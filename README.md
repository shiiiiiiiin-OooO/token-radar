# token-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/shiiiiiiiin-OooO/token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/shiiiiiiiin-OooO/token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar: every DeFi protocol in a DefiLlama snapshot that records no token, ranked by what its token would be worth if its record stayed as it is, with a costed, timed farm plan for each.

- **Value model (radar-2)**: `implied = TVL × category multiple × growth × no-token run`. The category multiple is calibrated on the same snapshot: the median market-cap-to-TVL of the protocols whose token already trades, per category, shrunk toward the global median. No protocol name is special-cased.
- **One model, two hosts**: `dashboard/model.js` is run by `main.ts` (through `node:vm`) to write `board.json`, and by the page to draw every screen, so the board and the dashboard cannot disagree.
- **Farm plans**: seven steps per protocol, each with its cost and time, on the cheapest of the chains the protocol lists first, sized by its TVL and age.
- **Dashboard**: sortable, filterable board (category, chain, tier, 7-day momentum), a detail drawer with the factor breakdown, trading peers, sensitivity and the plan, a trading-token calibration view, and live model sliders. Static, no network, no framework.

Not financial advice: DefiLlama recording no token is not proof that none exists, and a protocol may never issue one.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input path/to/snapshot.json
```

Node 22.18 or later, standard library only. Open `out/dashboard/index.html` from a local server.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
