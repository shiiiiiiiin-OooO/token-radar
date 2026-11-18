// Token Radar model (radar-2). One plain script, run by two hosts:
//   - main.ts loads it with node:vm and writes /output/board.json from it;
//   - the page loads it with <script> and draws every screen from it.
// So the board the gate reads and the board the screenshots show are the same function's output.
//
// The implied value is what a protocol's token would be worth if its record stayed as it is:
//
//   implied = tvl_usd x categoryMultiple(category) x growthFactor(change_7d) x runwayFactor(age_days)
//
// categoryMultiple: the snapshot's own price of TVL. For every protocol whose token already trades
//   (mcap_usd > 0), take ln(mcap / tvl); per category take the median, shrink it toward the median of
//   all trading protocols by SHRINK pseudo-samples, and clamp. A category with one trading token moves
//   the multiple a little; a category with fifteen moves it a lot. No protocol name is special-cased.
// growthFactor: sqrt(1 + g/100), g = change_7d clamped to [-50, 100]: momentum, damped.
// runwayFactor: how long the protocol has run with no token on record: 0.6 at day 0 rising to 1.0 at
//   two years; an unknown listing date counts as one year.
(function (root) {
  'use strict';

  var MODEL = {
    version: 'radar-2',
    shrink: 6,            // pseudo-samples pulling a category's multiple toward the global one
    multiple_min: 0.03,
    multiple_max: 1.5,
    growth_floor: -50,
    growth_cap: 100,
    runway_floor: 0.6,
    runway_days: 730,
    unknown_age_days: 365,
    airdrop_share: 0.1,   // share of the implied value a community drop would carry
    stable_apr: 0.04      // what the farm capital earns elsewhere: the plan's opportunity cost
  };

  // Categories the board never ranks: exchanges, bridges and staking receipts are products of a
  // token that already trades, not protocols waiting on a launch of their own.
  var NOT_RANKED = ['CEX', 'Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC'];
  var VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
  var WRAPPED = /\b(wrapped|staked|staking)\b/i;
  var DAY_MS = 86400000;

  function median(xs) {
    var a = xs.slice().sort(function (x, y) { return x - y; });
    var n = a.length;
    if (n === 0) return 0;
    return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
  }
  function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }
  function round4(x) { return Math.round(x * 1e4) / 1e4; }
  function bySlug(a, b) { return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0; }

  // What the record says about a token: pre-token (no id, no symbol, no market cap), trading (a market
  // cap), or recorded (an id or symbol but no market cap). Only pre-token protocols are ranked.
  function tokenStatus(p) {
    if (p.mcap_usd === null && p.gecko_id === null && p.symbol === null) return 'pre-token';
    if (p.mcap_usd !== null && p.mcap_usd > 0) return 'trading';
    return 'recorded';
  }

  function isRankable(p) {
    return tokenStatus(p) === 'pre-token' && NOT_RANKED.indexOf(p.category) < 0 &&
      !VERSIONED.test(p.name) && !WRAPPED.test(p.name);
  }

  function ageDays(asOf, listedAt) {
    if (!listedAt) return null;
    var a = Date.parse(asOf + 'T00:00:00Z'), b = Date.parse(listedAt + 'T00:00:00Z');
    if (!isFinite(a) || !isFinite(b)) return null;
    return Math.max(0, Math.floor((a - b) / DAY_MS));
  }

  // The price of a dollar of TVL per category, from the trading protocols in the same snapshot.
  function calibrate(snapshot, model) {
    var logs = {}, all = [];
    snapshot.protocols.forEach(function (p) {
      if (tokenStatus(p) !== 'trading' || !(p.tvl_usd > 0)) return;
      var r = Math.log(p.mcap_usd / p.tvl_usd);
      all.push(r);
      var c = p.category || 'Uncategorised';
      (logs[c] = logs[c] || []).push(r);
    });
    var g = median(all);
    var out = { global: { n: all.length, median: Math.exp(g), multiple: clamp(Math.exp(g), model.multiple_min, model.multiple_max) }, categories: {} };
    Object.keys(logs).sort().forEach(function (c) {
      var n = logs[c].length, m = median(logs[c]);
      var shrunk = (n * m + model.shrink * g) / (n + model.shrink);
      out.categories[c] = { n: n, median: Math.exp(m), multiple: clamp(Math.exp(shrunk), model.multiple_min, model.multiple_max) };
    });
    return out;
  }

  function multipleFor(cal, category) {
    var c = cal.categories[category || 'Uncategorised'];
    return c ? { multiple: c.multiple, n: c.n, median: c.median, source: 'category' } :
      { multiple: cal.global.multiple, n: 0, median: cal.global.median, source: 'global' };
  }

  // One protocol's implied value with every factor it was built from.
  function score(p, asOf, cal, model) {
    var age = ageDays(asOf, p.listed_at);
    var g = clamp(p.change_7d === null ? 0 : p.change_7d, model.growth_floor, model.growth_cap);
    var growth = Math.sqrt(1 + g / 100);
    var runwayAge = age === null ? model.unknown_age_days : age;
    var runway = model.runway_floor + (1 - model.runway_floor) * Math.min(runwayAge, model.runway_days) / model.runway_days;
    var m = multipleFor(cal, p.category);
    var implied = Math.max(1, Math.round(p.tvl_usd * m.multiple * growth * runway));
    var confidence = (age !== null ? 1 : 0) + (p.change_7d !== null ? 1 : 0) + (m.n >= 3 ? 1 : 0);
    return {
      implied: implied,
      multiple: round4(m.multiple), peers: m.n, multiple_source: m.source,
      growth_pct: round4(g), growth: round4(growth),
      runway: round4(runway), age_days: age,
      drop_pool: Math.round(implied * model.airdrop_share),
      per_1k: Math.round(implied * model.airdrop_share / p.tvl_usd * 1000 * 100) / 100,
      confidence: ['low', 'low', 'medium', 'high'][confidence]
    };
  }

  // ---- Farm plans -------------------------------------------------------------------------------
  // Fees per transaction by chain, in dollars, as round planning figures. A plan farms on the cheapest
  // chain the protocol lists, because the same activity costs a hundred times more on Ethereum.
  var GAS = {
    'Ethereum': 4, 'Bitcoin': 2.5, 'Solana': 0.02, 'Tron': 1.2, 'Binance': 0.1, 'Base': 0.05, 'Arbitrum': 0.08,
    'Optimism': 0.05, 'Unichain': 0.03, 'Linea': 0.08, 'Ink': 0.03, 'Polygon': 0.03, 'Avalanche': 0.15,
    'Sonic': 0.03, 'Monad': 0.02, 'Hyperliquid L1': 0.05, 'Sui': 0.02, 'Aptos': 0.01, 'Stellar': 0.01,
    'Algorand': 0.01, 'Flare': 0.03, 'Berachain': 0.05, 'Plasma': 0.01, 'Mantle': 0.05, 'Katana': 0.03,
    'Robinhood Chain': 0.03, 'Ripple': 0.01, 'TON': 0.05, 'Near': 0.01, 'Cardano': 0.25, 'Starknet': 0.05,
    'zkSync Era': 0.1, 'Scroll': 0.1, 'Blast': 0.05, 'Mode': 0.03, 'Plume Mainnet': 0.03, 'Hemi': 0.05
  };
  var DEFAULT_GAS = 0.3;

  // Only the first three chains DefiLlama lists: a minor deployment is cheap but often has no vault worth farming.
  function farmChain(p) {
    var best = null;
    p.chains.slice(0, 3).forEach(function (c) {
      var fee = GAS.hasOwnProperty(c) ? GAS[c] : DEFAULT_GAS;
      if (best === null || fee < best.fee) best = { chain: c, fee: fee };
    });
    return best || { chain: 'its main chain', fee: DEFAULT_GAS };
  }

  // What one tracked activity looks like, by the kind of protocol the record says it is.
  function playbook(category) {
    var c = (category || '').toLowerCase();
    if (/lend|cdp|collateral|credit/.test(c)) return { kind: 'lending', core: 'Supply {cap} of USDC to {name} on {chain}', second: 'Borrow 25% of the supply back as a second stablecoin and repay it within the week, so the wallet shows a borrower as well as a lender', weekly: 'top the supply up by $20 or repay and re-borrow', txs: 3 };
    if (/dex|liquidity|amm/.test(c)) return { kind: 'liquidity', core: 'Add {cap} of liquidity to {name}\'s deepest stablecoin or major pair on {chain}', second: 'Make 3 swaps of $50 through {name}\'s router, so volume is recorded besides liquidity', weekly: 'make one $50 swap and claim pool fees', txs: 4 };
    if (/curator|allocator|yield|vault|basis|wrapper|index|farm|manager/.test(c)) return { kind: 'vault', core: 'Deposit {cap} of USDC into {name}\'s largest vault on {chain} and keep the share token in the wallet', second: 'Split $100 into a second vault of {name} so the wallet holds two strategies', weekly: 'check the vault page and add $20 if its points program counts deposit size', txs: 2 };
    if (/rwa|treasur/.test(c)) return { kind: 'rwa', core: 'Mint {cap} of {name}\'s yield asset on {chain}, completing its KYC step if it asks for one', second: 'Use $100 of the minted asset in one integration {name} lists (a lending market or a pool)', weekly: 'hold, and check the integration page for new partner pools', txs: 2 };
    if (/deriv|perp|option|prediction|synthetic/.test(c)) return { kind: 'trading', core: 'Deposit {cap} of USDC as margin on {name} on {chain}', second: 'Open and close a 1x position of $200 each week; never leverage the farm', weekly: 'one round-trip trade of $200 at 1x', txs: 4 };
    if (/restak|staking pool|governance|incentive/.test(c)) return { kind: 'staking', core: 'Stake {cap} of the asset {name} accepts on {chain} and keep the receipt', second: 'Delegate or vote once with the position if {name} offers it', weekly: 'claim and restake rewards', txs: 2 };
    if (/chain|payment|privacy/.test(c)) return { kind: 'network', core: 'Bridge {cap} onto {name} through its official bridge on {chain} and keep it there', second: 'Use 3 different apps on {name} with $50 each (a swap, a deposit, a payment)', weekly: 'make one transaction on the network', txs: 4 };
    if (/insur|cover/.test(c)) return { kind: 'cover', core: 'Buy {cap} of cover, or underwrite it, on {name} on {chain}', second: 'Renew or extend the policy once instead of letting it lapse', weekly: 'check the cover status', txs: 2 };
    return { kind: 'general', core: 'Deposit {cap} of USDC into {name} on {chain} and keep the position open', second: 'Use a second feature of {name} with $50 so the wallet has two kinds of activity', weekly: 'make one deposit, claim or vote', txs: 3 };
  }

  function usd(n) {
    if (n >= 100) { var s = String(Math.round(n)); return '$' + s.replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
    return '$' + (Math.round(n * 100) / 100).toFixed(n < 1 ? 2 : n % 1 ? 2 : 0);
  }

  // A plan from the protocol's own record: capital from its TVL and age, fees from its cheapest chain,
  // the hold window from how long it has run, the actions from its category.
  function farmPlan(p, s, model) {
    var ch = farmChain(p), fee = ch.fee;
    var cap = p.tvl_usd >= 1e9 ? 1000 : p.tvl_usd >= 1e8 ? 500 : 250;
    if (s.age_days !== null && s.age_days < 120) cap = cap / 2;   // young code: halve the size
    var weeks = s.age_days === null ? 6 : s.age_days < 180 ? 10 : s.age_days < 540 ? 8 : 6;
    var pb = playbook(p.category);
    var fill = function (t) { return t.replace(/\{cap\}/g, usd(cap)).replace(/\{name\}/g, p.name).replace(/\{chain\}/g, ch.chain); };
    var bridge = ch.chain === 'Ethereum' || ch.chain === 'Bitcoin' ? 0 : fee <= 0.1 ? 1 : 3;
    var setupFees = fee * (2 + pb.txs) + bridge;
    var upkeep = fee * weeks;
    var forgone = cap * model.stable_apr * weeks / 52;
    var est = s.per_1k * cap / 1000;
    var steps = [
      { do: 'Make a fresh wallet for this farm only and fund it with ' + usd(cap) + ' of USDC plus a ' + usd(Math.max(1, fee * 10)) + ' gas buffer on ' + ch.chain + ', the cheapest chain ' + p.name + ' lists (about ' + usd(fee) + ' a transaction)', cost: usd(Math.max(1, fee * 10)) + ' gas buffer' + (bridge ? ' and about ' + usd(bridge) + ' to bridge in' : ''), time: '15 minutes' },
      { do: 'Open ' + p.name + ' from the link on its DefiLlama page, check the contract address against its docs, and approve only the amount you deposit, never unlimited', cost: usd(fee) + ' for the approval', time: '10 minutes' },
      { do: fill(pb.core), cost: usd(cap) + ' of capital at risk and ' + usd(fee * 2) + ' of fees', time: '10 minutes' },
      { do: fill(pb.second), cost: usd(fee * (pb.txs - 1)) + ' of fees', time: '15 minutes' },
      { do: 'Each week for ' + weeks + ' weeks, ' + fill(pb.weekly) + ', so the wallet is active across several snapshots', cost: usd(fee) + ' a week, ' + usd(upkeep) + ' in all', time: '5 minutes a week' },
      { do: 'Hold the position for the full ' + weeks + ' weeks; ' + (s.age_days !== null && s.age_days < 120 ? 'the protocol is under 120 days old, so the plan already halves the size' : 'size it so that losing it all would not hurt'), cost: usd(forgone) + ' of yield forgone at ' + Math.round(model.stable_apr * 100) + '% a year on ' + usd(cap), time: weeks + ' weeks' },
      { do: 'If ' + p.name + ' announces points or a token, claim only from the link on its own site or verified account and never pay a fee to claim; then exit and log every transaction', cost: usd(fee * 2) + ' to claim and withdraw', time: '20 minutes' }
    ];
    var total = setupFees + upkeep + fee * 2;
    return {
      chain: ch.chain, fee: fee, capital: cap, weeks: weeks, kind: pb.kind,
      fees_total: Math.round(total * 100) / 100,
      forgone: Math.round(forgone * 100) / 100,
      hands_on_min: 80 + 5 * weeks,
      est_drop: Math.round(est * 100) / 100,
      steps: steps
    };
  }

  // The plan's steps as the gate's strings: the action, then its cost and time.
  function stepStrings(plan) {
    var out = plan.steps.map(function (st) { return st.do + '. Cost: ' + st.cost + '. Time: ' + st.time + '.'; });
    out.push('Plan total: ' + usd(plan.capital) + ' at risk, about ' + usd(plan.fees_total) + ' in fees and ' +
      usd(plan.forgone) + ' of forgone yield, ' + Math.round(plan.hands_on_min / 6) / 10 + ' hours of hands-on time over ' + plan.weeks +
      ' weeks. Model estimate of the drop on this position: ' + usd(plan.est_drop) + ', if the token lands at the implied value.');
    return out;
  }

  // The whole radar: the ranked board, the trading set kept apart, and the calibration behind both.
  function buildRadar(snapshot, model) {
    model = model || MODEL;
    var cal = calibrate(snapshot, model);
    var watch = {};
    snapshot.watchlist.forEach(function (s) { watch[s] = true; });
    var rows = snapshot.protocols.filter(function (p) { return watch[p.slug] || isRankable(p); }).map(function (p) {
      var s = score(p, snapshot.as_of, cal, model);
      var plan = farmPlan(p, s, model);
      return {
        rank: 0, slug: p.slug, name: p.name, category: p.category, chains: p.chains,
        tvl_usd: p.tvl_usd, change_7d: p.change_7d, listed_at: p.listed_at,
        token_status: 'pre-token', tier: watch[p.slug] ? 'watchlist' : 'early',
        implied_value_usd: s.implied, model: s, plan: plan, farm_steps: stepStrings(plan)
      };
    });
    rows.sort(function (a, b) { return b.implied_value_usd - a.implied_value_usd || bySlug(a, b); });
    rows.forEach(function (r, i) { r.rank = i + 1; });
    var trading = snapshot.protocols.filter(function (p) { return tokenStatus(p) === 'trading' && p.tvl_usd > 0; }).map(function (p) {
      var s = score(p, snapshot.as_of, cal, model);
      return { slug: p.slug, name: p.name, category: p.category, chains: p.chains, tvl_usd: p.tvl_usd, change_7d: p.change_7d,
        mcap_usd: p.mcap_usd, symbol: p.symbol, market_multiple: round4(p.mcap_usd / p.tvl_usd), model_value: s.implied };
    }).sort(function (a, b) { return b.mcap_usd - a.mcap_usd || bySlug(a, b); });
    return {
      as_of: snapshot.as_of, source: snapshot.source, floor_usd: snapshot.floor_usd, model: model,
      calibration: cal, watchlist_size: snapshot.watchlist.length, rows: rows, trading: trading,
      recorded_size: snapshot.protocols.filter(function (p) { return tokenStatus(p) === 'recorded'; }).length,
      universe: snapshot.protocols.length
    };
  }

  root.RadarModel = {
    MODEL: MODEL, tokenStatus: tokenStatus, isRankable: isRankable, ageDays: ageDays, calibrate: calibrate,
    score: score, farmPlan: farmPlan, stepStrings: stepStrings, buildRadar: buildRadar, usd: usd
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
