[![make.fun · btc-race-24h-20261123-0511](https://make.fun/badge/btc-race-24h-20261123-0511.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![rank](https://make.fun/badge/btc-race-24h-20261123-0511/toirant/btc-race-24h-20261123-0511/rank.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![reward](https://make.fun/badge/btc-race-24h-20261123-0511/toirant/btc-race-24h-20261123-0511/reward.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)

# btc-race-24h-20261123-0511

A trading bot for make.fun's "Race a BTC trading bot live for 24 hours"
competition ([bounty page](https://make.fun/bounty/btc-race-24h-20261123-0511)). It trades Coinbase Wrapped BTC (cbBTC) against USDC, one
1-minute bar at a time, starting with $1,000 of paper money, speaking the
`agent-fun/bars-replay/v1` protocol on stdin/stdout.

## Strategy

One-minute BTC noise is wide (about 8 bps a minute) while a full round
trip costs roughly 30-45 bps in fees, slippage and price impact, so
trading often just pays the pool. This bot trades rarely:

- It tracks every bar's close plus a fast (30-bar) and a slow (120-bar)
  exponential average of the closes.
- It buys a dip — a close at least 100 bps below the highest close of
  the trailing 60 bars — but only while the fast average sits above the
  slow one (uptrend), only before bar 1200, and only after 120 bars.
- It sells everything when the close recovers 200 bps above the entry
  fill, falls 130 bps below it, trails 150 bps below the best close
  since entry, or 240 bars have passed.
- If no fill has happened by bar 1320 it buys half its cash, so the
  entry always makes at least one trade and meets the guardrail.

Backtested on the kit's frozen dev window (local harness, not the
server grade): net PnL about +$22.67 on the dev window, 4 trades, max
drawdown about 1%. The dev window trends up, so that number is a gate
check, not a forecast of the race window.

## Running

```sh
node main.ts
```

Plain Node 22, standard library only, no dependencies, no network, no
clock, no environment reads. The bot is deterministic: the same bars
always produce the same replies.

## Files

- `main.ts` — the whole bot
- `LICENSE` — MIT
- `.makefun/owner.json` — claim file naming the entrant's wallet
