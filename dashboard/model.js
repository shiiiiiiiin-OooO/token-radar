// Token Radar model. main.ts runs this file in node:vm to write board.json; the page runs it to draw
// every screen: same function, same numbers.
//   implied = e^a[group] x TVL^b x sqrt(1 + growth7d) x runway(days with no token) x launch odds
// b and a[] are fitted on this snapshot's trading tokens; the grouping (none, family, category) is kept by
// held-out error in calibrate. Growth and runway are stated priors that calibrate tests against fitted
// terms and reports. Launch odds: a logistic fit, 10-fold tested.
// No protocol name is special-cased anywhere.
(function (root) {
'use strict';

var MODEL = {
  version: 'radar-5',
  shrink: 8,
  elasticity_min: 0.3, elasticity_max: 1,
  growth_floor: -50, growth_cap: 100,
  runway_floor: 0.6, runway_days: 730,
  airdrop_share: 0.1,   // scenario: the share of the value a community drop carries
  stable_apr: 0.04      // what farm capital earns elsewhere
};

// Never ranked: exchanges, bridges, staking receipts.
var NOT_RANKED = /^(cex|liquid staking|liquid restaking|restaked btc)$|bridge|exchange|otc/i;
var VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
var WRAPPED = /\b(wrapped|staked|staking)\b/i;
var DAY_MS = 86400000;

// Families: DefiLlama categories the market prices alike.
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
  var a = xs.slice().sort((x, y) => x - y), n = a.length;
  return n === 0 ? 0 : n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
}
function quantile(xs, q) {
  var a = xs.slice().sort((x, y) => x - y);
  if (!a.length) return 0;
  var i = (a.length - 1) * q, lo = Math.floor(i);
  return a[lo] + (a[Math.min(lo + 1, a.length - 1)] - a[lo]) * (i - lo);
}
function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }
function round4(x) { return Math.round(x * 1e4) / 1e4; }
function bySlug(a, b) { return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0; }

// Only pre-token protocols (no id, symbol or cap) are ranked.
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

// ---- calibration
function slope(pts) {
  var n = pts.length, mx = 0, my = 0, sxy = 0, sxx = 0;
  pts.forEach(p => { mx += p.x / n; my += p.y / n; });
  pts.forEach(p => { sxy += (p.x - mx) * (p.y - my); sxx += (p.x - mx) * (p.x - mx); });
  return sxx > 0 ? sxy / sxx : 1;
}
function mean(xs) { return xs.reduce((a, x) => a + x, 0) / (xs.length || 1); }
function group(pts, key, r) { var o = {}; pts.forEach((p, i) => { (o[p[key]] = o[p[key]] || []).push(r[i]); }); return o; }

// One fit: the elasticity, then shrunk family and category intercepts.
function fit(pts, structure, k, model) {
  var b = clamp(slope(pts), model.elasticity_min, model.elasticity_max);
  var r = pts.map(p => p.y - b * p.x), g = mean(r), F = {}, C = {};
  var fam = group(pts, 'fam', r), cat = group(pts, 'cat', r);
  Object.keys(fam).forEach(f => { var n = fam[f].length; F[f] = { n: n, a: (n * mean(fam[f]) + k * g) / (n + k) }; });
  Object.keys(cat).forEach(c => { var n = cat[c].length, base = F[family(c)] ? F[family(c)].a : g; C[c] = { n: n, a: (n * mean(cat[c]) + k * base) / (n + k) }; });
  return { b: b, global: g, structure: structure, families: F, categories: C };
}
function interceptFor(ic, category) {
  var c = ic.categories[category || 'Uncategorised'], f = ic.families[family(category)];
  if (ic.structure === 'category' && c) return { a: c.a, n: c.n, source: 'category' };
  if (ic.structure !== 'global' && f) return { a: f.a, n: f.n, source: 'family' };
  return { a: ic.global, n: 0, source: 'global' };
}
// Leave-one-out log errors; `extra` adds a term under test.
function heldOut(pts, structure, model, extra) {
  return pts.map((p, i) => {
    var rest = pts.filter((_, j) => j !== i), f = fit(rest, structure, model.shrink, model);
    return p.y - interceptFor(f, p.cat).a - f.b * p.x - (extra ? extra(p, rest, f) : 0);
  });
}
// Spearman: do held-out predictions order caps as the market does?
function spearman(a, b) {
  var rk = v => { var o = v.map((x, i) => [x, i]).sort((p, q) => p[0] - q[0]), r = []; o.forEach((x, j) => { r[x[1]] = j; }); return r; };
  var ra = rk(a), rb = rk(b), n = a.length, d = 0;
  for (var i = 0; i < n; i++) d += (ra[i] - rb[i]) * (ra[i] - rb[i]);
  return 1 - 6 * d / (n * (n * n - 1));
}
function factor(errs) { return round4(Math.exp(median(errs.map(Math.abs)))); }   // 2.0 = typically off 2x
function growthOf(g) { return Math.sqrt(1 + g / 100); }
function runwayOf(days, model) { return model.runway_floor + (1 - model.runway_floor) * Math.min(days, model.runway_days) / model.runway_days; }

// Launch odds: logistic fit of "records a token" on ln TVL, years and growth.
function features(p, asOf, medAge, model) {
  var age = ageDays(asOf, p.listed_at), g = clamp(p.change_7d === null ? 0 : p.change_7d, model.growth_floor, model.growth_cap);
  return [1, Math.log(p.tvl_usd) - 18, Math.min(age === null ? medAge : age, 1825) / 365, age === null ? 1 : 0, Math.log(1 + g / 100)];
}
function logit(X, y) {
  var k = X[0].length, w = X[0].map(() => 0), a, b, r;
  for (var it = 0; it < 12; it++) {
    var H = w.map(() => w.map(() => 0)), gr = w.map(() => 0);
    X.forEach((x, i) => {
      var q = 1 / (1 + Math.exp(-x.reduce((s, v, j) => s + v * w[j], 0)));
      for (var aa = 0; aa < k; aa++) { gr[aa] += (y[i] - q) * x[aa]; for (var bb = 0; bb < k; bb++) H[aa][bb] += q * (1 - q) * x[aa] * x[bb]; }
    });
    for (a = 0; a < k; a++) H[a][a] += 0.01;
    for (a = 0; a < k; a++) { for (r = 0; r < k; r++) if (r !== a) { var f = H[r][a] / H[a][a]; for (b = 0; b < k; b++) H[r][b] -= f * H[a][b]; gr[r] -= f * gr[a]; } }
    for (a = 0; a < k; a++) w[a] += gr[a] / H[a][a];
  }
  return w;
}
function oddsOf(w, x) { return 1 / (1 + Math.exp(-x.reduce((s, v, j) => s + v * w[j], 0))); }
function launchModel(snapshot, medAge, model) {
  var set = snapshot.protocols.filter(p => p.tvl_usd > 0 && !NOT_RANKED.test(p.category || '') && !VERSIONED.test(p.name) && !WRAPPED.test(p.name))
    .sort(bySlug), X = set.map(p => features(p, snapshot.as_of, medAge, model)), y = set.map(p => tokenStatus(p) === 'pre-token' ? 0 : 1);
  var hit = 0, rate = mean(y);
  for (var fold = 0; fold < 10; fold++) {   // 10-fold
    var tr = X.filter((_, i) => i % 10 !== fold), w = logit(tr, y.filter((_, i) => i % 10 !== fold));
    X.forEach((x, i) => { if (i % 10 === fold && (oddsOf(w, x) >= 0.5) === (y[i] === 1)) hit++; });
  }
  return { w: logit(X, y), n: set.length, accuracy: round4(hit / set.length), base_rate: round4(Math.max(rate, 1 - rate)) };
}
// A term fitted on the residuals of the rest.
function fittedTerm(feat) {
  return (p, rest, f) => {
    var e = rest.map(q => q.y - interceptFor(f, q.cat).a - f.b * q.x), v = rest.map(feat);
    var mv = mean(v), me = mean(e), sxy = 0, sxx = 0;
    v.forEach((x, i) => { sxy += (x - mv) * (e[i] - me); sxx += (x - mv) * (x - mv); });
    return sxx > 0 ? sxy / sxx * (feat(p) - mv) : 0;
  };
}

// Every modelling choice is made by held-out error, and every result is returned.
function calibrate(snapshot, model) {
  var ages = snapshot.protocols.map(p => ageDays(snapshot.as_of, p.listed_at)).filter(a => a !== null);
  var medAge = Math.round(median(ages)), pts = [];
  snapshot.protocols.forEach(p => {
    if (tokenStatus(p) !== 'trading' || !(p.tvl_usd > 0)) return;
    var c = p.category || 'Uncategorised', age = ageDays(snapshot.as_of, p.listed_at);
    var g = clamp(p.change_7d === null ? 0 : p.change_7d, model.growth_floor, model.growth_cap), days = age === null ? medAge : age;
    // y = ln(cap) less the priors, so every test scores the formula score() uses.
    var pr = Math.log(growthOf(g) * runwayOf(days, model));
    pts.push({ slug: p.slug, name: p.name, cat: c, fam: family(c), x: Math.log(p.tvl_usd), ly: Math.log(p.mcap_usd), y: Math.log(p.mcap_usd) - pr, pr: pr,
      tvl: p.tvl_usd, mcap: p.mcap_usd, symbol: p.symbol, g: g, years: days / 365, listed: p.listed_at, aside: setAside(p) });
  });
  var all = pts;
  pts = all.filter(p => !p.aside);
  var structures = {};
  ['global', 'family', 'category'].forEach(s => { structures[s] = heldOut(pts, s, model); });
  var raw = pts.map(p => { return Object.assign({}, p, { y: p.ly }); });
  var best = Object.keys(structures).sort((a, b) => factor(structures[a]) - factor(structures[b]))[0];
  var resid = structures[best], ic = fit(pts, best, model.shrink, model);
  // Walk-forward: fit on the first-listed half, predict the later half.
  var dated = pts.filter(p => p.listed).sort((a, b) => a.listed < b.listed ? -1 : a.listed > b.listed ? 1 : 0);
  var half = dated.length >> 1, wf = fit(dated.slice(0, half), best, model.shrink, model), later = dated.slice(half);
  var starter = p => p.ly - p.x - Math.log(0.25), wfErr = later.map(p => p.y - interceptFor(wf, p.cat).a - wf.b * p.x);
  // Is the printed range honest? Band from the older half, tested on the newer.
  var old = heldOut(dated.slice(0, half), best, model), lo = quantile(old, 0.25), hi = quantile(old, 0.75);
  return {
    n: pts.length, elasticity: round4(ic.b), intercepts: ic, points: pts, resid: resid,
    traded: all.map(p => [p, p.aside ? p.y - interceptFor(ic, p.cat).a - ic.b * p.x : resid[pts.indexOf(p)]]), structure: best, median_age_days: medAge,
    band: { lo: quantile(resid, 0.25), hi: quantile(resid, 0.75) }, launch: launchModel(snapshot, medAge, model),
    validation: {
      model: factor(resid),
      starter_quarter: factor(pts.map(starter)),
      within_3x: round4(resid.filter(e => Math.abs(e) <= Math.log(3)).length / pts.length),
      rank_corr: round4(spearman(pts.map((p, i) => p.ly - resid[i]), pts.map(p => p.ly))),
      structures: { global: factor(structures.global), family: factor(structures.family), category: factor(structures.category) },
      walk_forward: { train: half, test: later.length, from: later.length ? later[0].listed : null,
        model: factor(wfErr), starter_quarter: factor(later.map(starter)),
        band_hits: wfErr.filter(e => e >= lo && e <= hi).length },
      terms: {
        no_priors: factor(heldOut(raw, best, model)),
        growth_fitted: factor(heldOut(pts, best, model, fittedTerm(q => Math.log(1 + q.g / 100)))),
        age_fitted: factor(heldOut(pts, best, model, fittedTerm(q => Math.min(q.years, 5))))
      }
    }
  };
}

// One protocol's implied value with every factor it was built from.
function score(p, asOf, cal, model) {
  var age = ageDays(asOf, p.listed_at);
  var g = clamp(p.change_7d === null ? 0 : p.change_7d, model.growth_floor, model.growth_cap);
  var growth = growthOf(g), runway = runwayOf(age === null ? cal.median_age_days : age, model);
  var ic = interceptFor(cal.intercepts, p.category);
  var base = Math.exp(ic.a + cal.elasticity * Math.log(p.tvl_usd));
  var ifLaunch = base * growth * runway, odds = oddsOf(cal.launch.w, features(p, asOf, cal.median_age_days, model));
  var implied = clamp(Math.round(ifLaunch * odds), 1, 1e14);
  var confidence = (age !== null ? 1 : 0) + (p.change_7d !== null ? 1 : 0) + (ic.n >= 3 ? 1 : 0);
  return {
    as_of: asOf, implied: implied, base: Math.round(base), if_launch: Math.round(ifLaunch), odds: round4(odds),
    multiple: round4(base / p.tvl_usd), peers: ic.n, multiple_source: ic.source, family: family(p.category),
    growth_pct: round4(g), growth: round4(growth), runway: round4(runway), age_days: age, age_imputed: age === null,
    low: Math.max(1, Math.round(implied * Math.exp(cal.band.lo))), high: Math.round(implied * Math.exp(cal.band.hi)),
    drop_pool: Math.round(implied * model.airdrop_share),
    per_1k: Math.round(implied * model.airdrop_share / p.tvl_usd * 1e5) / 100,
    confidence: ['low', 'low', 'medium', 'high'][confidence]
  };
}

// The trading tokens behind a row: same category, then family, then nearest TVL.
function peersFor(p, cal, max) {
  var c = p.category || 'Uncategorised', f = family(p.category), x = Math.log(p.tvl_usd);
  var rank = q => (q.cat === c ? 0 : q.fam === f ? 1 : 2) * 100 + Math.abs(q.x - x);
  return cal.points.slice().sort((a, b) => rank(a) - rank(b) || bySlug(a, b)).slice(0, max || 5).map(q => {
    return { name: q.name, symbol: q.symbol, tvl_usd: q.tvl, multiple: round4(q.mcap / q.tvl), match: q.cat === c ? 'category' : q.fam === f ? 'family' : 'size' };
  });
}

// ---- farm plans
// Dollars per transaction.
var GAS = {
  Ethereum:4, Bitcoin:2.5, Solana:0.02, Tron:1.2, Binance:0.1, Base:0.05, Arbitrum:0.08,
  Optimism:0.05, Unichain:0.03, Linea:0.08, Ink:0.03, Polygon:0.03, Avalanche:0.15,
  Sonic:0.03, Monad:0.02, 'Hyperliquid L1':0.05, Sui:0.02, Aptos:0.01, Stellar:0.01,
  Algorand:0.01, Flare:0.03, Berachain:0.05, Plasma:0.01, Mantle:0.05, Katana:0.03,
  'Robinhood Chain':0.03, Ripple:0.01, TON:0.05, Near:0.01, Cardano:0.25, Starknet:0.05,
  'zkSync Era':0.1, Scroll:0.1, Blast:0.05, 'Plume Mainnet':0.03, Hemi:0.05
};
var DEFAULT_GAS = 0.3;
function gasOf(c) { return GAS.hasOwnProperty(c) ? GAS[c] : DEFAULT_GAS; }

// Main chain unless fees pass 1% of capital; else the cheapest of three.
function farmChain(p, cap, txs) {
  if (!p.chains.length) return { chain: 'its own chain', fee: DEFAULT_GAS, why: 'no chain is listed' };
  var main = p.chains[0], mainFee = gasOf(main);
  if (mainFee * txs <= cap * 0.01) return { chain: main, fee: mainFee, why: 'the first chain it lists, where about ' + usd(mainFee * txs) + ' of fees stay under 1% of the capital' };
  var best = { chain: main, fee: mainFee };
  p.chains.slice(1, 3).forEach(c => { if (gasOf(c) < best.fee) best = { chain: c, fee: gasOf(c) }; });
  if (best.chain === main) return { chain: main, fee: mainFee, why: 'the first chain it lists; the next two are no cheaper' };
  return { chain: best.chain, fee: best.fee, why: 'on ' + main + ', the first chain it lists, fees would be ' + usd(mainFee * txs) + ', ' + Math.round(mainFee * txs / cap * 100) + '% of the capital' };
}

// The actions, by the kind of business the category says it is.
function P(kind, core, second, weekly, txs) { return { kind: kind, core: core, second: second, weekly: weekly, txs: txs }; }
function playbook(category) {
  var c = (category || '').toLowerCase(), f = family(category);
  if (/curator|allocator/.test(c)) return P('vault', 'Deposit {cap} of USDC into the largest vault {name} curates on {chain} (pick it from the vault list on the curator site) and keep the share token', 'Check the vault allocation page: go on only if no single market holds more than half of it', 'check the vault APY and allocation and exit if one market takes over half', 2);
  if (/basis/.test(c)) return P('vault', 'Mint {cap} of the delta-neutral dollar of {name} on {chain} and stake it where its points accrue', 'Note the funding rate on its dashboard: the yield comes from it, so a negative week is the exit signal', 'check the funding rate and the redemption queue', 3);
  if (/prediction/.test(c)) return P('trading', 'Deposit {cap} of USDC on {name} on {chain}', 'Buy $25 of shares in 4 markets that resolve within the hold window, so volume and resolved positions are recorded', 'buy $25 in one new market and claim resolved ones', 6);
  if (/card/.test(c)) return P('card', 'Load {cap} onto a {name} card or account on {chain}', 'Make 5 card payments of $10, so spending is recorded besides the balance', 'make one $10 payment', 6);
  if (/payment/.test(c)) return P('payments', 'Open a {cap} balance or channel on {name} from {chain}', 'Send 5 payments of $5 to a second wallet you control', 'send one $5 payment', 6);
  if (/cedefi/.test(c)) return P('earn', 'Subscribe {cap} to {name}\'s main earn product on {chain}, completing its account checks', 'Move {s} into a second product it offers', 'check the balance and re-subscribe if a term ends', 2);
  if (/stable/.test(c) && !/wrapper/.test(c)) return P('stablecoin', 'Mint {cap} of {name}\'s stablecoin on {chain}, or buy it on its main pool', 'Put {s} of it into one pool or market {name} lists as a partner', 'hold, and claim any partner rewards', 3);
  if (f === 'bitcoin') return P('bitcoin', 'Deposit {cap} of BTC, or the BTC wrapper {name} accepts, into it on {chain}', 'Keep its receipt token in the wallet and use {s} of it in one listed integration', 'check the receipt balance', 2);
  if (f === 'lending') return P('lending', 'Supply {cap} of USDC to {name} on {chain}', 'Borrow 25% of the supply as a second stablecoin and repay it within the week, so the wallet shows a borrower as well as a lender', 'top the supply up by $20, or repay and re-borrow', 3);
  if (f === 'dexes') return P('liquidity', 'Add {cap} of liquidity to {name}\'s deepest stablecoin or major pair on {chain}', 'Make 3 swaps of {s} through {name}\'s router, so volume is recorded besides liquidity', 'make one {s} swap and claim pool fees', 4);
  if (f === 'vaults') return P('vault', 'Deposit {cap} of USDC into {name}\'s largest vault on {chain} and keep the share token in the wallet', 'Put {s} into a second {name} vault, so the wallet holds two strategies', 'check the vault page and add $20 if its points count deposit size', 2);
  if (f === 'rwa') return P('rwa', 'Mint {cap} of {name}\'s yield asset on {chain}, completing its KYC step if it asks for one', 'Use {s} of the minted asset in one integration {name} lists (a lending market or a pool)', 'hold, and check the integration page for new partner pools', 2);
  if (f === 'trading') return P('trading', 'Deposit {cap} of USDC as margin on {name} on {chain}', 'Open and close one 1x position of {s}; never leverage the farm', 'one round-trip trade of {s} at 1x', 4);
  if (f === 'staking') return P('staking', 'Stake {cap} of the asset {name} accepts on {chain} and keep the receipt', 'Delegate or vote once with the position if {name} offers it', 'claim and restake rewards', 2);
  if (f === 'infrastructure') return P('network', 'Bridge {cap} onto {name}\'s network from {chain} through the bridge its docs name', 'Use 3 apps on {name} with {s} each (a swap, a deposit, a transfer)', 'make one transaction on the network', 4);
  if (/insur|cover/.test(c)) return P('cover', 'Buy {cap} of cover, or underwrite it, on {name} on {chain}', 'Renew or extend the policy once instead of letting it lapse', 'check the cover status', 2);
  return P('product', 'Use {name}\'s main product on {chain} with {cap}, as its docs describe', 'Use one second feature of {name} with {s}, so the wallet shows two kinds of activity', 'make one deposit, claim or vote', 3);
}

function usd(n) {
  if (n < 0) return '-' + usd(-n);
  if (n >= 100) return '$' + String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return '$' + n.toFixed(2);
}
function big(n) { return n >= 1e9 ? '$' + (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? '$' + (n / 1e6).toFixed(1) + 'M' : usd(n); }

// Capital from TVL and age, chain from fees, hold from age.
function farmPlan(p, s, model, size, halved) {
  var cap = size || (p.tvl_usd >= 1e9 ? 5000 : p.tvl_usd >= 1e8 ? 2000 : 1000);
  if (!size && s.age_days !== null && s.age_days < 120) cap = cap / 2;   // young code: half
  var weeks = s.age_days === null ? 6 : s.age_days < 180 ? 10 : s.age_days < 540 ? 8 : 6;
  var pb = playbook(p.category);
  var ch = farmChain(p, cap, 4 + pb.txs + weeks), fee = ch.fee;
  var fill = t => { return t.replace(/\{cap\}/g, usd(cap)).replace(/\{name\}/g, p.name).replace(/\{chain\}/g, ch.chain).replace(/\{s\}/g, usd(Math.min(100, cap / 5))); };
  var bridge = ch.chain === 'Ethereum' || ch.chain === 'Bitcoin' ? 0 : fee <= 0.1 ? 1 : 3;
  var buffer = Math.max(1, Math.ceil(fee * 12));
  var fees = Math.round((fee * (4 + pb.txs + weeks) + bridge) * 100) / 100;
  // Yield-bearing positions forgo nothing.
  var earns = /^(vault|lending|rwa|stablecoin|earn|staking)$/.test(pb.kind);
  var forgone = earns ? 0 : Math.round(cap * model.stable_apr * weeks / 52 * 100) / 100;
  var bps = cap / p.tvl_usd * 1e4;
  var est = Math.round(s.per_1k * cap / 10) / 100;
  var breakEvenPool = Math.round((fees + forgone) / cap * p.tvl_usd);
  var net = Math.round((est - fees - forgone) * 100) / 100, cost = fees + forgone, hours = (70 + 5 * weeks) / 60;
  // Farm: 2x costs on a trusted record; thin: pays but weak or shrinking; skip: costs not covered.
  var shrinking = p.change_7d !== null && p.change_7d <= -15;
  var verdict = net <= 0 ? 'skip' : halved ? 'thin' : est >= 2 * cost && s.confidence !== 'low' && !shrinking ? 'farm' : 'thin';
  var why = verdict === 'skip' ? (halved ? 'at half size, ' : '') + 'the ' + usd(est) + ' scenario drop does not cover ' + usd(cost) + ' of costs' :
    verdict === 'farm' ? 'the scenario drop is ' + (est / cost).toFixed(1) + 'x its costs on a ' + s.confidence + '-confidence record' :
    'half size, ' + usd(cap) + ', where the drop is ' + (est / cost).toFixed(1) + 'x its costs, because ' + (shrinking ? 'TVL fell ' + Math.abs(p.change_7d).toFixed(0) + '% this week' : s.confidence === 'low' ? 'the record is thin' : 'at full size it paid under 2x');
  // Thin is rebuilt at half size, or skipped if it no longer pays.
  if (verdict === 'thin' && !halved) return farmPlan(p, s, model, cap / 2, true);
  var day = d => new Date(Date.parse(s.as_of + 'T00:00:00Z') + d * 86400000).toISOString().slice(0, 10);
  var steps = [
    { when: day(0), do: 'Fund a fresh wallet used for nothing else with ' + usd(cap) + ' of USDC and a ' + usd(buffer) + ' gas buffer on ' + ch.chain + ': ' + ch.why, cost: usd(buffer) + ' gas buffer' + (bridge ? ', about ' + usd(bridge) + ' to bridge in' : ''), time: '15 minutes' },
    { when: day(0), do: 'Go / no-go: open ' + p.name + ' from its DefiLlama page and go on only if its TVL is still above ' + big(p.tvl_usd * 0.75) + ' (75% of the ' + big(p.tvl_usd) + ' in this snapshot) and the contract matches its docs; approve exactly ' + usd(cap) + ', never unlimited', cost: usd(fee) + ' for the approval', time: '10 minutes' },
    { when: day(0), do: fill(pb.core), cost: usd(cap) + ' at risk, ' + usd(fee * 2) + ' of fees', time: '10 minutes' },
    { when: day(1), do: fill(pb.second), cost: usd(fee * (pb.txs - 1)) + ' of fees', time: '15 minutes' },
    { when: day(7) + ' to ' + day(7 * weeks), do: 'Every 7 days for ' + weeks + ' weeks, ' + fill(pb.weekly) + ', so the wallet shows activity in every weekly snapshot', cost: usd(fee) + ' a week, ' + usd(fee * weeks) + ' in all', time: '5 minutes a week' },
    { when: 'each check', do: 'Exit rule: withdraw early if TVL falls under ' + big(p.tvl_usd * 0.6) + ' or the 7-day change is below -20% at two weekly checks in a row; otherwise hold all ' + weeks + ' weeks. The position is ' + (bps < 0.01 ? bps.toFixed(4) : bps.toFixed(2)) + ' bps of the TVL', cost: earns ? 'none forgone: the position earns its own yield' : usd(forgone) + ' of yield forgone at ' + Math.round(model.stable_apr * 100) + '% a year', time: weeks + ' weeks' },
    { when: day(7 * weeks), do: 'Claim only from the link on ' + p.name + '\'s own site and never pay to claim, then withdraw. Break-even: fees and forgone yield of ' + usd(fees + forgone) + ' are covered only if the community pool is above ' + big(breakEvenPool) + '; the model\'s ' + Math.round(model.airdrop_share * 100) + '% scenario pool is ' + big(s.drop_pool), cost: usd(fee * 2) + ' to claim and withdraw', time: '20 minutes' }
  ];
  return {
    chain: ch.chain, chain_why: ch.why, fee: fee, capital: cap, weeks: weeks, kind: pb.kind,
    fees_total: fees, forgone: forgone, hands_on_min: 70 + 5 * weeks, bps: round4(bps),
    est_drop: est, net: net, break_even_pool: breakEvenPool, verdict: verdict, verdict_why: why,
    break_even_odds: est > 0 ? round4(Math.min(1, cost * s.odds / est)) : 1,
    per_hour: Math.round(net / hours * 100) / 100, start: day(0), decide: day(7 * weeks),
    steps: steps
  };
}

// The steps as board strings.
function stepStrings(plan) {
  var out = plan.steps.map(st => (st.when ? st.when + ': ' : '') + st.do + '. Cost: ' + st.cost + '. Time: ' + st.time + '.');
  out.unshift('Verdict: ' + plan.verdict.toUpperCase() + ', ' + plan.verdict_why + '. Window ' + plan.start + ' to ' + plan.decide + ', ' + usd(plan.per_hour) + ' net per hands-on hour.');
  out.push('Plan total: ' + usd(plan.capital) + ' at risk on ' + plan.chain + ', about ' + usd(plan.fees_total) + ' in fees and ' + usd(plan.forgone) +
    ' of forgone yield, ' + Math.round(plan.hands_on_min / 6) / 10 + ' hours hands-on over ' + plan.weeks + ' weeks. Scenario drop on this position: ' +
    usd(plan.est_drop) + ', net ' + usd(plan.net) + ' after costs.');
  return out;
}

// ---- the radar
// Exactly one reason per protocol, for the accounting bar.
function reason(p, watch, floor) {
  if (watch[p.slug]) return 'watchlist';
  var s = tokenStatus(p);
  if (s === 'trading') return 'token trades';
  if (s === 'recorded') return 'token on record, no cap';
  return setAside(p) || (p.tvl_usd >= floor ? 'off-list' : 'early');
}
// Not a launch: off the board and the curve.
function setAside(p) {
  var c = p.category || '';
  return /bridge/i.test(c) ? 'bridge' : /^(liquid staking|liquid restaking|restaked btc)$/i.test(c) ? 'staking receipt' : /cex|exchange|otc/i.test(c) ? 'exchange' :
    VERSIONED.test(p.name) ? 'versioned release' : WRAPPED.test(p.name) ? 'wrapped or staked' : '';
}
// Seeded mulberry32: byte-identical runs.
function rng(seed) {
  return () => { seed = seed + 0x6D2B79F5 | 0; var t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
// Rank range: P10..P90 over 100 bootstrap refits.
function rankRanges(rows, cal, model) {
  var draw = rng(20261114), pts = cal.points, seen = rows.map(() => []);
  for (var k = 0; k < 100; k++) {
    var sample = pts.map(() => pts[Math.floor(draw() * pts.length)]), f = fit(sample, cal.structure, model.shrink, model);
    rows.map((r, i) => { return { i: i, v: (interceptFor(f, r.category).a + f.b * Math.log(r.tvl_usd)) + Math.log(r.model.growth * r.model.runway * r.model.odds) }; })
      .sort((a, b) => b.v - a.v || a.i - b.i).forEach((o, j) => { seen[o.i].push(j + 1); });
  }
  rows.forEach((r, i) => { r.rank_range = [Math.round(quantile(seen[i], 0.1)), Math.round(quantile(seen[i], 0.9))]; });
}
// FNV-1a over rows and steps; the page recomputes it.
function digest(rows) {
  var h = 0x811c9dc5, s = rows.map(r => [r.slug, r.rank, r.implied_value_usd, r.plan.verdict, r.plan.net].concat(r.farm_steps).join('|')).join('\n');
  for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ('0000000' + (h >>> 0).toString(16)).slice(-8);
}

function buildRadar(snapshot, model) {
  model = model || MODEL;
  var cal = calibrate(snapshot, model), watch = {}, reasons = {};
  snapshot.watchlist.forEach(s => { watch[s] = true; });
  snapshot.protocols.forEach(p => { var r = reason(p, watch, snapshot.floor_usd); reasons[r] = (reasons[r] || 0) + 1; });
  var rows = snapshot.protocols.filter(p => watch[p.slug] || isRankable(p)).map(p => {
    var s = score(p, snapshot.as_of, cal, model), plan = farmPlan(p, s, model);
    return {
      rank: 0, slug: p.slug, name: p.name, category: p.category, chains: p.chains,
      tvl_usd: p.tvl_usd, change_7d: p.change_7d, listed_at: p.listed_at, token_status: 'pre-token',
      tier: watch[p.slug] ? 'watchlist' : p.tvl_usd >= snapshot.floor_usd ? 'off-list' : 'early',
      implied_value_usd: s.implied, model: s, plan: plan, farm_steps: stepStrings(plan)
    };
  });
  rows.sort((a, b) => b.implied_value_usd - a.implied_value_usd || bySlug(a, b));
  rows.forEach((r, i) => { r.rank = i + 1; });
  rankRanges(rows, cal, model);
  return {
    as_of: snapshot.as_of, source: snapshot.source, floor_usd: snapshot.floor_usd, model: model, calibration: cal,
    watchlist_size: snapshot.watchlist.length, rows: rows, universe: snapshot.protocols.length,
    reasons: reasons, digest: digest(rows)
  };
}

root.RadarModel = {
  MODEL: MODEL, family: family, tokenStatus: tokenStatus, isRankable: isRankable, ageDays: ageDays,
  calibrate: calibrate, score: score, peersFor: peersFor, farmPlan: farmPlan, stepStrings: stepStrings,
  buildRadar: buildRadar, digest: digest, usd: usd, reason: reason
};
})(typeof globalThis !== 'undefined' ? globalThis : this);
