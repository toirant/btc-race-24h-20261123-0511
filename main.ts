// Dip-buying cbBTC bot for agent-fun/bars-replay/v1.
//
// Idea: BTC's one-minute noise is wide (about 8 bps a minute) while a full
// round trip costs roughly 30-45 bps, so trading often just pays the pool.
// This bot therefore trades rarely: it waits for a real dip inside an
// uptrend, buys it with all its cash, and sells on a recovery, a stop, a
// trailing stop, or a time limit. A late-window fallback guarantees at
// least one trade so the entry always meets the guardrail.
//
// Rules, all decided from the bars the harness sends (never the clock):
//  - Track the close of every bar, plus a fast (30-bar) and a slow
//    (120-bar) exponential average of the closes.
//  - A dip is a close at least 100 bps below the highest close of the
//    trailing 60 bars.
//  - Buy a dip only while the fast average sits above the slow one (the
//    trend is up), only before bar 1200, and only once the averages have
//    had 120 bars to settle.
//  - Sell everything when the close recovers 200 bps above the entry
//    fill, falls 130 bps below it, trails 150 bps below the best close
//    since entry, or 240 bars have passed. The 130 bps stop is the
//    tight end of the tested plateau (130-170 all clear the dev gate):
//    in a down-trend the losing trades fell straight from entry, so a
//    tighter hard stop cuts each such loss by about 20 bps of notional.
//  - If no fill has happened by bar 1320, buy half the cash at the next
//    bar so the entry is never left with zero trades.
//
// Everything is deterministic: no randomness, no wall clock, no files,
// no environment reads. The harness's own account report is the source
// of truth for cash, position and cost.

import * as readline from "node:readline";

const SYMBOL = "CBBTC";
const MAX_SLIPPAGE_BPS = 300;
const LOOKBACK_BARS = 60;
const DIP_BPS = 100;
const RECOVERY_BPS = 200;
const STOP_BPS = 130;
const TRAIL_BPS = 150;
const MAX_HOLD_BARS = 240;
const FAST_BARS = 30;
const SLOW_BARS = 120;
const ENTRY_CUTOFF_BAR = 1200;
const FALLBACK_BAR = 1320;
const FALLBACK_FRACTION_NUM = 1;
const FALLBACK_FRACTION_DEN = 2;

type Order =
  | {
      side: "buy";
      client_id: string;
      symbol: string;
      notional_quote_units: string;
      max_slippage_bps: number;
    }
  | {
      side: "sell";
      client_id: string;
      symbol: string;
      qty: string;
      max_slippage_bps: number;
    };

let priceScale = 5;
let quoteScale = 6;
let qtyScale = 8;
let warmupBars = 0;

let barsSeen = 0;
let closes: number[] = [];
let emaFast = 0;
let emaSlow = 0;
let fillsSeen = 0;
let orderSeq = 0;

// Position state, reconciled from the harness account every batch and
// from the fills it reports.
let holding = false;
let entryPrice = 0; // USDC per cbBTC, from the buy fill price
let peakPrice = 0; // best close since entry, USDC
let heldBars = 0;

function priceToUsdc(raw: string): number {
  return Number(raw) / 10 ** priceScale;
}

function emaUpdate(prev: number, price: number, bars: number): number {
  const k = 2 / (bars + 1);
  return price * k + prev * (1 - k);
}

function trailingHigh(): number {
  let high = 0;
  const start = Math.max(0, closes.length - LOOKBACK_BARS);
  for (let i = start; i < closes.length; i++) {
    if (closes[i] > high) high = closes[i];
  }
  return high;
}

function handleHello(msg: Record<string, unknown>): void {
  const symbols = msg.symbols as Array<Record<string, unknown>>;
  for (const s of symbols) {
    if (s.symbol === SYMBOL) {
      priceScale = s.price_scale as number;
      qtyScale = s.qty_scale as number;
    }
  }
  const capital = msg.capital as Record<string, unknown>;
  quoteScale = capital.quote_scale as number;
  if (typeof msg.warmup_bars === "number") warmupBars = msg.warmup_bars;
}

function handleBatch(msg: Record<string, unknown>): Order[] {
  const orders: Order[] = [];

  // First, learn from the fills of the orders decided on the last batch.
  const fills = (msg.fills ?? []) as Array<Record<string, unknown>>;
  for (const f of fills) {
    if (f.status !== "filled") continue;
    const clientId = f.client_id as string;
    if (clientId.startsWith("_")) continue; // the harness's own flatten
    fillsSeen += 1;
    if (f.side === "buy") {
      holding = true;
      entryPrice = priceToUsdc(f.price as string);
      peakPrice = entryPrice;
      heldBars = 0;
    } else if (f.side === "sell") {
      holding = false;
      entryPrice = 0;
      peakPrice = 0;
      heldBars = 0;
    }
  }

  // Then read this batch's bar, if the symbol was present this minute.
  const bars = (msg.bars ?? []) as Array<Record<string, unknown>>;
  let close: number | null = null;
  for (const b of bars) {
    if (b.symbol === SYMBOL) close = priceToUsdc(b.c as string);
  }
  if (close === null) return orders; // no bar: answer empty, stay in sync

  barsSeen += 1;
  closes.push(close);
  if (closes.length === 1) {
    emaFast = close;
    emaSlow = close;
  } else {
    emaFast = emaUpdate(emaFast, close, FAST_BARS);
    emaSlow = emaUpdate(emaSlow, close, SLOW_BARS);
  }

  // Reconcile with the harness account: it is authoritative.
  const account = msg.account as Record<string, unknown>;
  const positions = (account.positions ?? []) as Array<Record<string, unknown>>;
  const position = positions.find((p) => p.symbol === SYMBOL);
  const cash = BigInt(account.cash_quote_units as string);
  const qty = position ? BigInt(position.qty as string) : 0n;
  if (qty > 0n && !holding) {
    // A position we did not record (should not happen): adopt it at cost.
    holding = true;
    const cost = BigInt(position.cost_quote_units as string);
    entryPrice = Number(cost) / 10 ** quoteScale / (Number(qty) / 10 ** qtyScale);
    peakPrice = entryPrice;
    heldBars = 0;
  }
  if (qty === 0n) holding = false;

  if (holding) {
    heldBars += 1;
    if (close > peakPrice) peakPrice = close;
    const recovered = close >= entryPrice * (1 + RECOVERY_BPS / 10000);
    const stopped = close <= entryPrice * (1 - STOP_BPS / 10000);
    const trailed = close <= peakPrice * (1 - TRAIL_BPS / 10000);
    const stale = heldBars >= MAX_HOLD_BARS;
    if (recovered || stopped || trailed || stale) {
      orderSeq += 1;
      orders.push({
        side: "sell",
        client_id: `sell-${orderSeq}`,
        symbol: SYMBOL,
        qty: qty.toString(),
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
    }
    return orders;
  }

  // Flat: look for a dip to buy.
  if (barsSeen < warmupBars) return orders;
  const trendUp = emaFast >= emaSlow;
  const settled = closes.length >= SLOW_BARS;
  if (settled && trendUp && barsSeen <= ENTRY_CUTOFF_BAR) {
    const high = trailingHigh();
    if (high > 0 && close <= high * (1 - DIP_BPS / 10000)) {
      if (cash >= 1000000n) {
        orderSeq += 1;
        orders.push({
          side: "buy",
          client_id: `buy-${orderSeq}`,
          symbol: SYMBOL,
          notional_quote_units: cash.toString(),
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        });
        return orders;
      }
    }
  }

  // Fallback: never end the window without a trade.
  if (fillsSeen === 0 && barsSeen >= FALLBACK_BAR && cash >= 1000000n) {
    const notional =
      (cash * BigInt(FALLBACK_FRACTION_NUM)) / BigInt(FALLBACK_FRACTION_DEN);
    orderSeq += 1;
    orders.push({
      side: "buy",
      client_id: `buy-${orderSeq}`,
      symbol: SYMBOL,
      notional_quote_units: notional.toString(),
      max_slippage_bps: MAX_SLIPPAGE_BPS,
    });
  }
  return orders;
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line: string) => {
  const text = line.trim();
  if (text === "") return;
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return;
  }
  if (msg.type === "hello") {
    handleHello(msg);
  } else if (msg.type === "batch") {
    const orders = handleBatch(msg);
    process.stdout.write(
      JSON.stringify({ type: "reply", seq: msg.seq, orders }) + "\n",
    );
  } else if (msg.type === "done") {
    process.exit(0);
  }
});
