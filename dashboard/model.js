// Token Radar model (radar-3). One plain script, two hosts: main.ts runs it in node:vm to write
// board.json; the page runs it with <script> to draw every screen. Same function, same numbers.
//
//   implied = exp(a[category]) x tvl_usd ^ b  x  growth(change_7d)  x  runway(age_days)
//
// b and a[] are fitted on the same snapshot, on the protocols whose token already trades:
//   b       ordinary least squares of ln(mcap) on ln(tvl). The market does not price TVL linearly:
//           on this snapshot b is about 0.5, so ten times the TVL is worth about three times the cap.
//   a[cat]  the median of ln(mcap) - b ln(tvl) in the category, shrunk toward its family's median
//           (vaults, lending, dexes, ...), which is shrunk toward the median of all trading tokens,
//           each by SHRINK pseudo-samples. A category with one trading token barely moves its value.
// growth   sqrt(1 + g/100), g = change_7d clamped to [-50, 100]: momentum, damped.
// runway   0.6 at day 0 rising to 1.0 at two years with no token on record. An unknown listing date
//          takes the snapshot's median age, not a guess.
// range    the 25th..75th percentile band of the fit's own residuals (leave-one-out), so every value
//          carries how far the market typically sits from it.
// No protocol name is special-cased anywhere: the same functions score every row.
(function (root) {
  'use strict';

  var MODEL = {
    version: 'radar-3',
    shrink: 4,
    elasticity_min: 0.3, elasticity_max: 1,
    growth_floor: -50, growth_cap: 100,
    runway_floor: 0.6, runway_days: 730,
    airdrop_share: 0.1,   // scenario: share of the implied value a community drop would carry
    stable_apr: 0.04      // what farm capital earns elsewhere: the plan's opportunity cost
  };

  // Never ranked: exchanges, bridges and staking receipts are products of a token that already trades.
  var NOT_RANKED = /^(cex|liquid staking|liquid restaking|restaked btc)$|bridge|exchange|otc/i;
  var VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
  var WRAPPED = /\b(wrapped|staked|staking)\b/i;
  var DAY_MS = 86400000;

  // Families group DefiLlama's 80-odd categories into businesses the market prices alike.
  var FAMILIES = [
    ['vaults', /curator|allocator|yield|vault|basis|wrapper|index|farm|manager/i],
    ['lending', /lend|cdp|collateral|credit|stable|cedefi/i],
    ['dexes', /dex|amm|liquidity|swap/i],
    ['trading', /deriv|perp|option|prediction|synthetic|launchpad/i],
    ['rwa', /rwa|treasur/i],
    ['bitcoin', /btc|bitcoin/i],
    ['staking', /stak|governance|incentive/i],
    ['infrastructure', /chain|bridge|payment|privacy|oracle|card|cex|exchange|otc/i]
  ];
  function family(category) {
    for (var i = 0; i < FAMILIES.length; i++) if (FAMILIES[i][1].test(category || '')) return FAMILIES[i][0];
    return 'other';
  }

  function median(xs) {
    var a = xs.slice().sort(function (x, y) { return x - y; }), n = a.length;
    return n === 0 ? 0 : n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
  }
  function quantile(xs, q) {
    var a = xs.slice().sort(function (x, y) { return x - y; });
    if (!a.length) return 0;
    var i = (a.length - 1) * q, lo = Math.floor(i);
    return a[lo] + (a[Math.min(lo + 1, a.length - 1)] - a[lo]) * (i - lo);
  }
  function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }
  function round4(x) { return Math.round(x * 1e4) / 1e4; }
  function bySlug(a, b) { return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0; }

  // What the record says about a token. Only pre-token protocols (no id, symbol or cap) are ranked.
  function tokenStatus(p) {
    if (p.mcap_usd === null && p.gecko_id === null && p.symbol === null) return 'pre-token';
    if (p.mcap_usd !== null && p.mcap_usd > 0) return 'trading';
    return 'recorded';
  }
  function isRankable(p) {
    return tokenStatus(p) === 'pre-token' && p.tvl_usd > 0 && !NOT_RANKED.test(p.category || '') &&
      !VERSIONED.test(p.name) && !WRAPPED.test(p.name);
  }
  function ageDays(asOf, listedAt) {
    if (!listedAt) return null;
    var a = Date.parse(asOf + 'T00:00:00Z'), b = Date.parse(listedAt + 'T00:00:00Z');
    return isFinite(a) && isFinite(b) ? Math.max(0, Math.floor((a - b) / DAY_MS)) : null;
  }

  // ---- calibration ------------------------------------------------------------------------------
  function slope(pts) {
    var n = pts.length, mx = 0, my = 0, sxy = 0, sxx = 0;
    pts.forEach(function (p) { mx += p.x / n; my += p.y / n; });
    pts.forEach(function (p) { sxy += (p.x - mx) * (p.y - my); sxx += (p.x - mx) * (p.x - mx); });
    return sxx > 0 ? sxy / sxx : 1;
  }
  // Intercepts for every category and family from one set of trading points and one elasticity.
  function intercepts(pts, b, k) {
    var all = [], fam = {}, cat = {};
    pts.forEach(function (p) {
      var r = p.y - b * p.x;
      all.push(r); (fam[p.fam] = fam[p.fam] || []).push(r); (cat[p.cat] = cat[p.cat] || []).push(r);
    });
    var g = median(all), out = { global: g, families: {}, categories: {} };
    Object.keys(fam).forEach(function (f) { var n = fam[f].length; out.families[f] = { n: n, a: (n * median(fam[f]) + k * g) / (n + k) }; });
    Object.keys(cat).forEach(function (c) {
      var n = cat[c].length, f = out.families[family(c)], base = f ? f.a : g;
      out.categories[c] = { n: n, a: (n * median(cat[c]) + k * base) / (n + k), raw: median(cat[c]) };
    });
    return out;
  }
  function interceptFor(ic, category) {
    var c = ic.categories[category || 'Uncategorised'];
    if (c) return { a: c.a, n: c.n, source: 'category' };
    var f = ic.families[family(category)];
    return f ? { a: f.a, n: 0, source: 'family' } : { a: ic.global, n: 0, source: 'global' };
  }

  // Fit, then hold each trading token out in turn and predict it from the rest: the honest error.
  function calibrate(snapshot, model) {
    var pts = [];
    snapshot.protocols.forEach(function (p) {
      if (tokenStatus(p) !== 'trading' || !(p.tvl_usd > 0)) return;
      var c = p.category || 'Uncategorised';
      pts.push({ slug: p.slug, name: p.name, cat: c, fam: family(c), x: Math.log(p.tvl_usd), y: Math.log(p.mcap_usd), tvl: p.tvl_usd, mcap: p.mcap_usd, symbol: p.symbol });
    });
    var b = clamp(slope(pts), model.elasticity_min, model.elasticity_max);
    var ic = intercepts(pts, b, model.shrink);
    var flatLog = median(pts.map(function (p) { return p.y - p.x; }));
    var errModel = [], errFlat = [], errStarter = [], resid = [];
    pts.forEach(function (p, i) {
      var rest = pts.filter(function (_, j) { return j !== i; });
      var bi = clamp(slope(rest), model.elasticity_min, model.elasticity_max);
      var pred = interceptFor(intercepts(rest, bi, model.shrink), p.cat).a + bi * p.x;
      resid.push(p.y - pred);
      errModel.push(Math.abs(p.y - pred));
      errFlat.push(Math.abs(p.y - p.x - flatLog));
      errStarter.push(Math.abs(p.y - p.x - Math.log(0.25)));
    });
    var ages = snapshot.protocols.map(function (p) { return ageDays(snapshot.as_of, p.listed_at); }).filter(function (a) { return a !== null; });
    return {
      n: pts.length, elasticity: round4(b), global_a: ic.global, intercepts: ic, points: pts,
      median_age_days: Math.round(median(ages)),
      band: { lo: quantile(resid, 0.25), hi: quantile(resid, 0.75) },
      validation: {   // median error as a multiplicative factor: 2.0 means "typically off by 2x"
        model: round4(Math.exp(median(errModel))),
        flat_median: round4(Math.exp(median(errFlat))),
        starter_quarter: round4(Math.exp(median(errStarter))),
        within_2x: round4(errModel.filter(function (e) { return e <= Math.log(2); }).length / pts.length)
      }
    };
  }

  // One protocol's implied value with every factor it was built from.
  function score(p, asOf, cal, model) {
    var age = ageDays(asOf, p.listed_at);
    var g = clamp(p.change_7d === null ? 0 : p.change_7d, model.growth_floor, model.growth_cap);
    var growth = Math.sqrt(1 + g / 100);
    var runAge = age === null ? cal.median_age_days : age;
    var runway = model.runway_floor + (1 - model.runway_floor) * Math.min(runAge, model.runway_days) / model.runway_days;
    var ic = interceptFor(cal.intercepts, p.category);
    var base = Math.exp(ic.a + cal.elasticity * Math.log(p.tvl_usd));
    var implied = clamp(Math.round(base * growth * runway), 1, 1e14);
    var confidence = (age !== null ? 1 : 0) + (p.change_7d !== null ? 1 : 0) + (ic.n >= 3 ? 1 : 0);
    return {
      as_of: asOf, implied: implied, base: Math.round(base),
      multiple: round4(base / p.tvl_usd), peers: ic.n, multiple_source: ic.source, family: family(p.category),
      growth_pct: round4(g), growth: round4(growth), runway: round4(runway), age_days: age, age_imputed: age === null,
      low: Math.max(1, Math.round(implied * Math.exp(cal.band.lo))), high: Math.round(implied * Math.exp(cal.band.hi)),
      drop_pool: Math.round(implied * model.airdrop_share),
      per_1k: Math.round(implied * model.airdrop_share / p.tvl_usd * 1e5) / 100,
      confidence: ['low', 'low', 'medium', 'high'][confidence]
    };
  }

  // The trading tokens that explain a row's intercept: its category first, then its family, then
  // the nearest in TVL, so the detail view always shows the evidence and never a lone oddity.
  function peersFor(p, cal, max) {
    var c = p.category || 'Uncategorised', f = family(p.category), x = Math.log(p.tvl_usd);
    var rank = function (q) { return (q.cat === c ? 0 : q.fam === f ? 1 : 2) * 100 + Math.abs(q.x - x); };
    return cal.points.slice().sort(function (a, b) { return rank(a) - rank(b) || bySlug(a, b); }).slice(0, max || 5).map(function (q) {
      return { name: q.name, symbol: q.symbol, tvl_usd: q.tvl, mcap_usd: q.mcap, multiple: round4(q.mcap / q.tvl), match: q.cat === c ? 'category' : q.fam === f ? 'family' : 'size' };
    });
  }

  // ---- farm plans -------------------------------------------------------------------------------
  // Planning figures for one transaction, in dollars.
  var GAS = {
    'Ethereum': 4, 'Bitcoin': 2.5, 'Solana': 0.02, 'Tron': 1.2, 'Binance': 0.1, 'Base': 0.05, 'Arbitrum': 0.08,
    'Optimism': 0.05, 'Unichain': 0.03, 'Linea': 0.08, 'Ink': 0.03, 'Polygon': 0.03, 'Avalanche': 0.15,
    'Sonic': 0.03, 'Monad': 0.02, 'Hyperliquid L1': 0.05, 'Sui': 0.02, 'Aptos': 0.01, 'Stellar': 0.01,
    'Algorand': 0.01, 'Flare': 0.03, 'Berachain': 0.05, 'Plasma': 0.01, 'Mantle': 0.05, 'Katana': 0.03,
    'Robinhood Chain': 0.03, 'Ripple': 0.01, 'TON': 0.05, 'Near': 0.01, 'Cardano': 0.25, 'Starknet': 0.05,
    'zkSync Era': 0.1, 'Scroll': 0.1, 'Blast': 0.05, 'Plume Mainnet': 0.03, 'Hemi': 0.05
  };
  var DEFAULT_GAS = 0.3;
  function gasOf(c) { return GAS.hasOwnProperty(c) ? GAS[c] : DEFAULT_GAS; }

  // Farm on the main chain unless its fees would eat more than 1% of the capital; then take the
  // cheapest of the first three chains DefiLlama lists (a minor deployment rarely has a vault to farm).
  function farmChain(p, cap, txs) {
    if (!p.chains.length) return { chain: 'its main chain', fee: DEFAULT_GAS, why: 'no chain is listed' };
    var main = p.chains[0], mainFee = gasOf(main);
    if (mainFee * txs <= cap * 0.01) return { chain: main, fee: mainFee, why: 'its main chain, where about ' + usd(mainFee * txs) + ' of fees stay under 1% of the capital' };
    var best = { chain: main, fee: mainFee };
    p.chains.slice(1, 3).forEach(function (c) { if (gasOf(c) < best.fee) best = { chain: c, fee: gasOf(c) }; });
    if (best.chain === main) return { chain: main, fee: mainFee, why: 'its main chain; its other listed chains are no cheaper' };
    return { chain: best.chain, fee: best.fee, why: 'the main chain ' + main + ' would cost ' + usd(mainFee * txs) + ' in fees, ' + Math.round(mainFee * txs / cap * 100) + '% of the capital' };
  }

  // What one tracked activity looks like, by the kind of business the record says it is.
  function playbook(category) {
    var c = (category || '').toLowerCase(), f = family(category);
    if (/card/.test(c)) return { kind: 'card', core: 'Load {cap} onto a {name} card or account on {chain}', second: 'Make 5 card payments of $10, so spending is recorded besides the balance', weekly: 'make one $10 payment', txs: 6 };
    if (/payment/.test(c)) return { kind: 'payments', core: 'Open a {cap} balance or channel on {name} from {chain}', second: 'Send 5 payments of $5 to a second wallet you control', weekly: 'send one $5 payment', txs: 6 };
    if (/cedefi/.test(c)) return { kind: 'earn', core: 'Subscribe {cap} to {name}\'s main earn product on {chain}, completing its account checks', second: 'Move $100 into a second product it offers', weekly: 'check the balance and re-subscribe if a term ends', txs: 2 };
    if (/stable/.test(c) && !/wrapper/.test(c)) return { kind: 'stablecoin', core: 'Mint {cap} of {name}\'s stablecoin on {chain}, or buy it on its main pool', second: 'Put $100 of it into one pool or market {name} lists as a partner', weekly: 'hold, and claim any partner rewards', txs: 3 };
    if (f === 'bitcoin') return { kind: 'bitcoin', core: 'Deposit {cap} of BTC, or the BTC wrapper {name} accepts, into it on {chain}', second: 'Keep its receipt token in the wallet and use $100 of it in one listed integration', weekly: 'check the receipt balance', txs: 2 };
    if (f === 'lending') return { kind: 'lending', core: 'Supply {cap} of USDC to {name} on {chain}', second: 'Borrow 25% of the supply as a second stablecoin and repay it within the week, so the wallet shows a borrower as well as a lender', weekly: 'top the supply up by $20, or repay and re-borrow', txs: 3 };
    if (f === 'dexes') return { kind: 'liquidity', core: 'Add {cap} of liquidity to {name}\'s deepest stablecoin or major pair on {chain}', second: 'Make 3 swaps of $50 through {name}\'s router, so volume is recorded besides liquidity', weekly: 'make one $50 swap and claim pool fees', txs: 4 };
    if (f === 'vaults') return { kind: 'vault', core: 'Deposit {cap} of USDC into {name}\'s largest vault on {chain} and keep the share token in the wallet', second: 'Put $100 into a second {name} vault, so the wallet holds two strategies', weekly: 'check the vault page and add $20 if its points count deposit size', txs: 2 };
    if (f === 'rwa') return { kind: 'rwa', core: 'Mint {cap} of {name}\'s yield asset on {chain}, completing its KYC step if it asks for one', second: 'Use $100 of the minted asset in one integration {name} lists (a lending market or a pool)', weekly: 'hold, and check the integration page for new partner pools', txs: 2 };
    if (f === 'trading') return { kind: 'trading', core: 'Deposit {cap} of USDC as margin on {name} on {chain}', second: 'Open and close one 1x position of $200; never leverage the farm', weekly: 'one round-trip trade of $200 at 1x', txs: 4 };
    if (f === 'staking') return { kind: 'staking', core: 'Stake {cap} of the asset {name} accepts on {chain} and keep the receipt', second: 'Delegate or vote once with the position if {name} offers it', weekly: 'claim and restake rewards', txs: 2 };
    if (f === 'infrastructure') return { kind: 'network', core: 'Bridge {cap} onto {name}\'s network from {chain} through the bridge its docs name', second: 'Use 3 apps on {name} with $50 each (a swap, a deposit, a transfer)', weekly: 'make one transaction on the network', txs: 4 };
    if (/insur|cover/.test(c)) return { kind: 'cover', core: 'Buy {cap} of cover, or underwrite it, on {name} on {chain}', second: 'Renew or extend the policy once instead of letting it lapse', weekly: 'check the cover status', txs: 2 };
    return { kind: 'product', core: 'Use {name}\'s main product on {chain} with {cap}, as its docs describe', second: 'Use one second feature of {name} with $50, so the wallet shows two kinds of activity', weekly: 'make one deposit, claim or vote', txs: 3 };
  }

  function usd(n) {
    if (n >= 100) return '$' + String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return '$' + n.toFixed(2);
  }
  function big(n) { return n >= 1e9 ? '$' + (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? '$' + (n / 1e6).toFixed(1) + 'M' : usd(n); }

  // A plan from the protocol's own record: capital from its TVL and age, the chain from its fees,
  // the hold from how long it has run, the go/no-go and exit lines from its TVL, the actions from its category.
  function farmPlan(p, s, model) {
    var cap = p.tvl_usd >= 1e9 ? 1000 : p.tvl_usd >= 1e8 ? 500 : 250;
    if (s.age_days !== null && s.age_days < 120) cap = cap / 2;   // young code: halve the size
    var weeks = s.age_days === null ? 6 : s.age_days < 180 ? 10 : s.age_days < 540 ? 8 : 6;
    var pb = playbook(p.category);
    var ch = farmChain(p, cap, 4 + pb.txs + weeks), fee = ch.fee;
    var fill = function (t) { return t.replace(/\{cap\}/g, usd(cap)).replace(/\{name\}/g, p.name).replace(/\{chain\}/g, ch.chain); };
    var bridge = ch.chain === 'Ethereum' || ch.chain === 'Bitcoin' ? 0 : fee <= 0.1 ? 1 : 3;
    var buffer = Math.max(1, Math.ceil(fee * 12));
    var fees = Math.round((fee * (4 + pb.txs + weeks) + bridge) * 100) / 100;
    var forgone = Math.round(cap * model.stable_apr * weeks / 52 * 100) / 100;
    var bps = cap / p.tvl_usd * 1e4;
    var est = Math.round(s.per_1k * cap / 10) / 100;
    var breakEvenPool = Math.round((fees + forgone) / cap * p.tvl_usd);
    var net = Math.round((est - fees - forgone) * 100) / 100, cost = fees + forgone, hours = (70 + 5 * weeks) / 60;
    // Verdict: farm when the scenario pays at least twice its costs on a record we trust; thin (half size)
    // when it pays but the record is weak or shrinking; skip when the costs are not covered.
    var shrinking = p.change_7d !== null && p.change_7d <= -15;
    var verdict = net <= 0 ? 'skip' : est >= 2 * cost && s.confidence !== 'low' && !shrinking ? 'farm' : 'thin';
    var why = verdict === 'skip' ? 'the ' + usd(est) + ' scenario drop does not cover ' + usd(cost) + ' of costs' :
      verdict === 'farm' ? 'the scenario drop is ' + (est / cost).toFixed(1) + 'x its costs on a ' + s.confidence + '-confidence record' :
      'it pays, but ' + (shrinking ? 'TVL fell ' + Math.abs(p.change_7d).toFixed(0) + '% this week' : s.confidence === 'low' ? 'the record is thin' : 'only ' + (est / cost).toFixed(1) + 'x its costs') + ': farm half size';
    // Dates from the snapshot day, so every step says when, not just how long.
    var day = function (d) { return new Date(Date.parse(s.as_of + 'T00:00:00Z') + d * 86400000).toISOString().slice(0, 10); };
    var steps = [
      { when: day(0), do: 'Fund a fresh wallet used for nothing else with ' + usd(cap) + ' of USDC and a ' + usd(buffer) + ' gas buffer on ' + ch.chain + ': ' + ch.why, cost: usd(buffer) + ' gas buffer' + (bridge ? ', about ' + usd(bridge) + ' to bridge in' : ''), time: '15 minutes' },
      { when: day(0), do: 'Go / no-go: open ' + p.name + ' from its DefiLlama page and go on only if its TVL is still above ' + big(p.tvl_usd * 0.75) + ' (75% of the ' + big(p.tvl_usd) + ' in this snapshot) and the contract matches its docs; approve exactly ' + usd(cap) + ', never unlimited', cost: usd(fee) + ' for the approval', time: '10 minutes' },
      { when: day(0), do: fill(pb.core), cost: usd(cap) + ' at risk, ' + usd(fee * 2) + ' of fees', time: '10 minutes' },
      { when: day(1), do: fill(pb.second), cost: usd(fee * (pb.txs - 1)) + ' of fees', time: '15 minutes' },
      { when: day(7) + ' to ' + day(7 * weeks), do: 'Every 7 days for ' + weeks + ' weeks, ' + fill(pb.weekly) + ', so the wallet shows activity in every weekly snapshot', cost: usd(fee) + ' a week, ' + usd(fee * weeks) + ' in all', time: '5 minutes a week' },
      { when: 'each check', do: 'Exit rule: withdraw early if TVL falls under ' + big(p.tvl_usd * 0.6) + ' or the 7-day change is below -20% at two weekly checks in a row; otherwise hold all ' + weeks + ' weeks. The position is ' + (bps < 0.01 ? bps.toFixed(4) : bps.toFixed(2)) + ' bps of the TVL', cost: usd(forgone) + ' of yield forgone at ' + Math.round(model.stable_apr * 100) + '% a year', time: weeks + ' weeks' },
      { when: day(7 * weeks), do: 'Claim only from the link on ' + p.name + '\'s own site and never pay to claim, then withdraw. Break-even: fees and forgone yield of ' + usd(fees + forgone) + ' are covered only if the community pool is above ' + big(breakEvenPool) + '; the model\'s ' + Math.round(model.airdrop_share * 100) + '% scenario pool is ' + big(s.drop_pool), cost: usd(fee * 2) + ' to claim and withdraw', time: '20 minutes' }
    ];
    return {
      chain: ch.chain, chain_why: ch.why, fee: fee, capital: cap, weeks: weeks, kind: pb.kind,
      fees_total: fees, forgone: forgone, hands_on_min: 70 + 5 * weeks, bps: round4(bps),
      est_drop: est, net: net, break_even_pool: breakEvenPool, verdict: verdict, verdict_why: why,
      per_hour: Math.round(net / hours * 100) / 100, start: day(0), decide: day(7 * weeks),
      steps: steps
    };
  }

  // The plan's steps as the gate's strings: the action, then its cost and time.
  function stepStrings(plan) {
    var out = plan.steps.map(function (st) { return (st.when ? st.when + ': ' : '') + st.do + '. Cost: ' + st.cost + '. Time: ' + st.time + '.'; });
    out.unshift('Verdict: ' + plan.verdict.toUpperCase() + ', ' + plan.verdict_why + '. Window ' + plan.start + ' to ' + plan.decide + ', ' + usd(plan.per_hour) + ' net per hands-on hour.');
    out.push('Plan total: ' + usd(plan.capital) + ' at risk on ' + plan.chain + ', about ' + usd(plan.fees_total) + ' in fees and ' + usd(plan.forgone) +
      ' of forgone yield, ' + Math.round(plan.hands_on_min / 6) / 10 + ' hours hands-on over ' + plan.weeks + ' weeks. Scenario drop on this position: ' +
      usd(plan.est_drop) + ', net ' + (plan.net < 0 ? '-' : '') + usd(Math.abs(plan.net)) + ' after costs.');
    return out;
  }

  // ---- the radar ---------------------------------------------------------------------------------
  function buildRadar(snapshot, model) {
    model = model || MODEL;
    var cal = calibrate(snapshot, model), watch = {};
    snapshot.watchlist.forEach(function (s) { watch[s] = true; });
    var rows = snapshot.protocols.filter(function (p) { return watch[p.slug] || isRankable(p); }).map(function (p) {
      var s = score(p, snapshot.as_of, cal, model), plan = farmPlan(p, s, model);
      return {
        rank: 0, slug: p.slug, name: p.name, category: p.category, chains: p.chains,
        tvl_usd: p.tvl_usd, change_7d: p.change_7d, listed_at: p.listed_at, token_status: 'pre-token',
        // watchlist: the house's list; off-list: pre-token above the floor that the house rule left out; early: below the floor
        tier: watch[p.slug] ? 'watchlist' : p.tvl_usd >= snapshot.floor_usd ? 'off-list' : 'early',
        implied_value_usd: s.implied, model: s, plan: plan, farm_steps: stepStrings(plan)
      };
    });
    rows.sort(function (a, b) { return b.implied_value_usd - a.implied_value_usd || bySlug(a, b); });
    rows.forEach(function (r, i) { r.rank = i + 1; });
    var trading = cal.points.map(function (q) {
      return { slug: q.slug, name: q.name, category: q.cat, symbol: q.symbol, tvl_usd: q.tvl, mcap_usd: q.mcap,
        market_multiple: round4(q.mcap / q.tvl), model_base: Math.exp(interceptFor(cal.intercepts, q.cat).a + cal.elasticity * q.x) };
    }).sort(function (a, b) { return b.mcap_usd - a.mcap_usd || bySlug(a, b); });
    return {
      as_of: snapshot.as_of, source: snapshot.source, floor_usd: snapshot.floor_usd, model: model, calibration: cal,
      watchlist_size: snapshot.watchlist.length, rows: rows, trading: trading, universe: snapshot.protocols.length,
      recorded_size: snapshot.protocols.filter(function (p) { return tokenStatus(p) === 'recorded'; }).length
    };
  }

  root.RadarModel = {
    MODEL: MODEL, family: family, tokenStatus: tokenStatus, isRankable: isRankable, ageDays: ageDays,
    calibrate: calibrate, score: score, peersFor: peersFor, farmPlan: farmPlan, stepStrings: stepStrings,
    buildRadar: buildRadar, usd: usd, big: big
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
