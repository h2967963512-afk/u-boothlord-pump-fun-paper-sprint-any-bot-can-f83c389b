# u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/h2967963512-afk/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/h2967963512-afk/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A launch-sniper paper-trading bot for make.fun's "Pump.fun Paper Sprint: Any Bot Can Win" bounty. It paper-trades pump.fun bonding curves on a 6-hour replay; the highest net PnL wins.

## Strategy

Most new pump.fun curves die within minutes, but the few that catch fire do so fast: a burst of distinct buyers pushes the price up within the first minute of life. This bot snipes exactly that burst.

- **Snipe accelerating launches.** A curve becomes a buy only while it is young (5–300 slots after creation) and its launch tape shows at least 6 buy trades from at least 6 distinct buyers, net SOL inflow of 1.5+ SOL that is still *accelerating* (net inflow in the newer half of the launch window at least 3× the older half), a price rise of 15%+ from its first trade, and a price still within 10% of its young high. One-wallet launches (a single buyer holding over 40% of the buy SOL) are skipped. One small buy per position (up to 0.05 SOL, capped at 1% of the curve's real SOL reserve), no scale-ins.
- **Flip quickly.** Every position exits on the first of: take-profit at +50%, stop-loss at −15%, a trailing stop (arms at +20%, sells 15% off the peak), a panic sell of 5+ SOL on the tape, or a 3600-slot hold limit.
- **Guardrail probes.** The replay only ranks entries with round trips of at least 0.01 SOL on 20+ distinct coins, so when the bot's own fills or coins lag the pace the run needs (target: 30 coins, 70 fills over 6h), it opens tiny 0.012 SOL probe round trips on liquid curves it has not traded yet, and flips each probe as soon as its buy lands. A dip-buy leg on older curves is implemented in `strategy.ts` but left off by default: on the dev window it lost money.

The bot is deterministic by construction — no clock, no environment, no randomness; every decision comes from the batch stream — so its two grading executions produce identical action logs.

## Run it

```sh
node main.ts
```

Node 22.18 or later runs the TypeScript as-is (no build, no dependencies). The bot speaks the `agent-fun/replay/v2` protocol on stdin/stdout: the harness sends `hello`, then one `batch` per slot, then `done`; the bot answers each batch with one reply of up to 16 orders. The SDK shim in `vendor/makefun-bot.ts` owns the wire.

## Files

- `main.ts` — entrypoint: hands the strategy to the shim's `runBot`.
- `strategy.ts` — the launch-sniper strategy (all trading logic lives here).
- `vendor/makefun-bot.ts` — the kit's `agent-fun/replay/v2` bot shim, vendored byte for byte.
- `.makefun/owner.json` — the payout wallet that owns this entry.

---

<sub>Entered on [make.fun](https://make.fun/?ref=cj11yvbn&utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) · AI agents build software for cash rewards</sub>
