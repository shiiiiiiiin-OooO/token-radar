// Token Radar page. Every number on screen comes from RadarModel.buildRadar (model.js) run on the
// snapshot in ../data.js: the same function main.ts runs to write board.json. No network, no framework.
(function () {
  'use strict';
  var M = window.RadarModel, SNAP = window.SNAPSHOT;
  var app = document.getElementById('app'), drawer = document.getElementById('drawer'), scrim = document.getElementById('scrim');
  if (!M || !SNAP) { app.innerHTML = '<p class="empty">data.js or model.js did not load: run main.ts to write ../data.js.</p>'; return; }

  var DEFAULTS = { tab: 'board', q: '', cat: '', chain: '', tier: 'all', mom: 'all', sort: 'rank', dir: 'asc', p: '' };
  var state = readHash();
  var overrides = {};           // the Model tab's sliders: changes to MODEL, applied to the whole page
  var radar, bySlug;

  function rebuild() {
    var model = {};
    Object.keys(M.MODEL).forEach(function (k) { model[k] = overrides.hasOwnProperty(k) ? overrides[k] : M.MODEL[k]; });
    radar = M.buildRadar(SNAP, model);
    bySlug = {};
    radar.rows.forEach(function (r) { bySlug[r.slug] = r; });
  }

  // ---- formatting ----
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function money(n) {
    var a = Math.abs(n);
    if (a >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (a >= 1e3) return '$' + (n / 1e3).toFixed(0) + 'K';
    return '$' + n.toFixed(a < 100 ? 2 : 0);
  }
  function pct(v) { return v === null ? '<span class="psub">n/a</span>' : '<span class="' + (v >= 0 ? 'up' : 'down') + '">' + (v >= 0 ? '+' : '') + v.toFixed(2) + '%</span>'; }
  function age(d) { return d === null ? '<span class="psub">unknown</span>' : d >= 365 ? (d / 365).toFixed(1) + 'y' : d + 'd'; }
  function chains(c) { return c.length ? esc(c.slice(0, 2).join(', ')) + (c.length > 2 ? ' +' + (c.length - 2) : '') : 'no chain listed'; }

  // ---- URL state: every view is a link, so the screenshots are reproducible ----
  function readHash() {
    var s = Object.assign({}, DEFAULTS);
    location.hash.replace(/^#/, '').split('&').forEach(function (kv) {
      var i = kv.indexOf('='); if (i < 0) return;
      var k = kv.slice(0, i); if (s.hasOwnProperty(k)) s[k] = decodeURIComponent(kv.slice(i + 1));
    });
    return s;
  }
  function writeHash() {
    var parts = Object.keys(DEFAULTS).filter(function (k) { return state[k] !== DEFAULTS[k]; }).map(function (k) { return k + '=' + encodeURIComponent(state[k]); });
    history.replaceState(null, '', parts.length ? '#' + parts.join('&') : location.pathname);
  }
  function set(patch) { Object.assign(state, patch); writeHash(); render(); }

  // ---- filtering and sorting ----
  var SORTS = {
    rank: function (r) { return r.rank; }, name: function (r) { return r.name.toLowerCase(); }, tvl: function (r) { return r.tvl_usd; },
    d7: function (r) { return r.change_7d === null ? -1e9 : r.change_7d; }, age: function (r) { return r.model.age_days === null ? -1 : r.model.age_days; },
    mult: function (r) { return r.model.multiple; }, implied: function (r) { return r.implied_value_usd; }, k: function (r) { return r.model.per_1k; },
    weeks: function (r) { return r.plan.weeks; }
  };
  function visibleRows() {
    var q = state.q.trim().toLowerCase();
    var rows = radar.rows.filter(function (r) {
      if (state.tier !== 'all' && r.tier !== state.tier) return false;
      if (state.cat && r.category !== state.cat) return false;
      if (state.chain && r.chains.indexOf(state.chain) < 0) return false;
      if (state.mom === 'up' && !(r.change_7d > 0)) return false;
      if (state.mom === 'down' && !(r.change_7d < 0)) return false;
      if (q && (r.name + ' ' + r.slug + ' ' + (r.category || '') + ' ' + r.chains.join(' ')).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    var key = SORTS[state.sort] || SORTS.rank, dir = state.dir === 'desc' ? -1 : 1;
    return rows.sort(function (a, b) { var x = key(a), y = key(b); return (x < y ? -1 : x > y ? 1 : 0) * dir || a.rank - b.rank; });
  }
  function options(values, current, all) {
    return '<option value="">' + all + '</option>' + values.map(function (v) {
      return '<option value="' + esc(v[0]) + '"' + (v[0] === current ? ' selected' : '') + '>' + esc(v[0]) + ' (' + v[1] + ')</option>';
    }).join('');
  }
  function tally(list) {
    var t = {}; list.forEach(function (x) { if (x) t[x] = (t[x] || 0) + 1; });
    return Object.keys(t).map(function (k) { return [k, t[k]]; }).sort(function (a, b) { return b[1] - a[1] || (a[0] < b[0] ? -1 : 1); });
  }

  // ---- header and hero ----
  function renderMeta() {
    var custom = Object.keys(overrides).length ? ' <b style="color:var(--amber)">custom</b>' : '';
    document.getElementById('meta').innerHTML = '<span>Snapshot <b>' + esc(radar.as_of) + '</b></span><span>DefiLlama protocol index, <b>' + radar.universe +
      '</b> protocols</span><span>Model <b>' + esc(radar.model.version) + '</b>' + custom + '</span>';
  }
  function hero() {
    var early = radar.rows.filter(function (r) { return r.tier === 'early'; }).length;
    var covered = radar.rows.filter(function (r) { return r.tier === 'watchlist'; }).length;
    var sum = radar.rows.reduce(function (a, r) { return a + r.implied_value_usd; }, 0);
    return '<section class="hero"><div><h1><em>' + radar.rows.length + '</em> protocols that record no token, ranked by what one would be worth today</h1>' +
      '<p>Implied value = TVL &times; the price the market already pays for a dollar of TVL in the same category (from the ' + radar.calibration.global.n +
      ' protocols whose token trades) &times; 7-day growth &times; how long it has run with no token. The ' + radar.watchlist_size + ' watchlist protocols are the floor; ' + early +
      ' smaller pre-token protocols are the early radar. A model, not a promise: DefiLlama records no token for these, which is not proof there is none.</p></div>' +
      '<div class="kpis"><div class="kpi ok"><span>Watchlist covered</span><b>' + covered + ' / ' + radar.watchlist_size + '</b></div>' +
      '<div class="kpi"><span>Pre-token ranked</span><b>' + radar.rows.length + '</b></div><div class="kpi"><span>Early, below $50M</span><b>' + early + '</b></div>' +
      '<div class="kpi"><span>Trading, set apart</span><b>' + radar.trading.length + '</b></div><div class="kpi"><span>Median TVL multiple</span><b>' +
      radar.calibration.global.median.toFixed(3) + '&times;</b></div><div class="kpi"><span>Sum of implied value</span><b>' + money(sum) + '</b></div></div></section>';
  }
  function tabs() {
    var t = [['board', 'Pre-token board', radar.rows.length], ['trading', 'Trading tokens', radar.trading.length], ['model', 'Model & calibration', '']];
    return '<nav class="tabs" role="tablist">' + t.map(function (x) {
      return '<button class="tab" role="tab" data-tab="' + x[0] + '" aria-selected="' + (state.tab === x[0]) + '">' + x[1] + (x[2] !== '' ? '<small>' + x[2] + '</small>' : '') + '</button>';
    }).join('') + '</nav>';
  }

  // ---- the board ----
  function th(key, label, cls) {
    var sorted = state.sort === key ? (state.dir === 'desc' ? 'descending' : 'ascending') : null;
    return '<th class="' + (cls || '') + '"' + (sorted ? ' aria-sort="' + sorted + '"' : '') + '><button data-sort="' + key + '">' + label + '</button></th>';
  }
  function board() {
    var rows = visibleRows(), top = radar.rows[0].implied_value_usd;
    var seg = function (name, opts) {
      return '<div class="seg" role="group">' + opts.map(function (o) { return '<button data-' + name + '="' + o[0] + '" aria-pressed="' + (state[name] === o[0]) + '">' + o[1] + '</button>'; }).join('') + '</div>';
    };
    var filtered = state.q || state.cat || state.chain || state.tier !== 'all' || state.mom !== 'all';
    var html = '<div class="controls">' +
      '<div class="field"><label for="q">Search</label><input id="q" type="search" placeholder="Name, category or chain" value="' + esc(state.q) + '"></div>' +
      '<div class="field"><label for="cat">Category</label><select id="cat">' + options(tally(radar.rows.map(function (r) { return r.category; })), state.cat, 'All categories') + '</select></div>' +
      '<div class="field"><label for="chain">Chain</label><select id="chain">' + options(tally([].concat.apply([], radar.rows.map(function (r) { return r.chains; }))), state.chain, 'All chains') + '</select></div>' +
      '<div class="field"><span class="lbl">Tier</span>' + seg('tier', [['all', 'All'], ['watchlist', 'Watchlist'], ['early', 'Early']]) + '</div>' +
      '<div class="field"><span class="lbl">7-day TVL</span>' + seg('mom', [['all', 'Any'], ['up', 'Growing'], ['down', 'Shrinking']]) + '</div>' +
      '<div class="count">' + rows.length + ' of ' + radar.rows.length + ' shown' + (filtered ? ' <button class="link" data-reset>Clear filters</button>' : '') + '</div></div>';
    html += '<div class="tablewrap"><table><thead><tr>' + th('rank', 'Rank') + th('name', 'Protocol') + '<th>Tier</th>' + th('tvl', 'TVL', 'n') + th('d7', '7d', 'n') +
      th('age', 'No-token run', 'n hide-m') + th('mult', 'Multiple', 'n hide-m') + th('implied', 'Implied value', 'n') + th('k', 'Drop / $1k', 'n') + th('weeks', 'Farm', 'n hide-m') + '<th class="hide-m">Conf.</th></tr></thead><tbody>';
    html += rows.map(function (r) {
      var w = Math.max(2, Math.round(Math.sqrt(r.implied_value_usd / top) * 90));
      return '<tr data-slug="' + esc(r.slug) + '"' + (state.p === r.slug ? ' class="sel"' : '') + '><td class="rank">' + r.rank + '</td>' +
        '<td><div class="pname">' + esc(r.name) + '</div><div class="psub">' + esc(r.category || 'Uncategorised') + ' &middot; ' + chains(r.chains) + '</div></td>' +
        '<td><span class="tag ' + (r.tier === 'watchlist' ? 'watch' : 'early') + '">' + r.tier + '</span></td>' +
        '<td class="n">' + money(r.tvl_usd) + '</td><td class="n">' + pct(r.change_7d) + '</td><td class="n hide-m">' + age(r.model.age_days) + '</td>' +
        '<td class="n hide-m">' + r.model.multiple.toFixed(2) + '&times;</td>' +
        '<td class="n"><span class="bar"><s><i style="width:' + w + 'px"></i></s><b class="num">' + money(r.implied_value_usd) + '</b></span></td>' +
        '<td class="n">' + money(r.model.per_1k) + '</td><td class="n hide-m">' + money(r.plan.capital) + ' &middot; ' + r.plan.weeks + 'w</td>' +
        '<td class="hide-m"><span class="conf ' + r.model.confidence + '">' + r.model.confidence + '</span></td></tr>';
    }).join('');
    html += '</tbody></table>' + (rows.length ? '' : '<p class="empty">No protocol matches these filters.</p>') + '</div>';
    html += '<p class="note">Drop / $1k: the model\'s estimate of what $1,000 held in the protocol would receive if ' + Math.round(radar.model.airdrop_share * 100) +
      '% of the implied value went to depositors pro rata. Farm: the plan\'s capital and hold window. Select a row for its factors, peers and farm plan. Every column sorts.</p>';
    return html;
  }

  // ---- the trading set: the market's own prices, kept apart from the board ----
  function trading() {
    var html = '<p class="note" style="margin:16px 0">These ' + radar.trading.length + ' protocols record a token with a market cap, so the board does not rank them: their value is the market\'s, not a model\'s. ' +
      'They are the calibration set: each category\'s TVL multiple is the median of their mcap / TVL. Model value is what radar-2 would have said with no market price; the ratio shows how far the market sits from it.</p>';
    html += '<div class="tablewrap"><table><thead><tr><th>Protocol</th><th>Symbol</th><th class="n">TVL</th><th class="n">Market cap</th><th class="n">Market multiple</th><th class="n">Model value</th><th class="n">Market / model</th></tr></thead><tbody>';
    html += radar.trading.slice(0, 60).map(function (t) {
      var ratio = t.mcap_usd / t.model_value;
      return '<tr><td><div class="pname">' + esc(t.name) + '</div><div class="psub">' + esc(t.category || 'Uncategorised') + ' &middot; ' + chains(t.chains) + '</div></td>' +
        '<td class="mono">' + esc(t.symbol || '') + '</td><td class="n">' + money(t.tvl_usd) + '</td><td class="n">' + money(t.mcap_usd) + '</td><td class="n">' + t.market_multiple.toFixed(2) + '&times;</td>' +
        '<td class="n">' + money(t.model_value) + '</td><td class="n ' + (ratio >= 1 ? 'up' : 'down') + '">' + ratio.toFixed(2) + '&times;</td></tr>';
    }).join('');
    return html + '</tbody></table></div><p class="note">Top 60 by market cap of ' + radar.trading.length + '. ' + radar.recorded_size + ' more protocols record a token id or symbol with no market cap: neither ranked nor used to calibrate.</p>';
  }

  // ---- the model tab: formula, constants you can move, and the calibration table ----
  var SLIDERS = [
    ['shrink', 'Category shrink', 0, 30, 1], ['runway_floor', 'Runway floor', 0.2, 1, 0.05], ['growth_cap', 'Growth cap %', 10, 200, 5],
    ['airdrop_share', 'Airdrop share', 0.02, 0.3, 0.01], ['multiple_max', 'Multiple cap', 0.3, 3, 0.1]
  ];
  function model() {
    var m = radar.model, cal = radar.calibration;
    var html = '<div class="cols"><div class="card"><h2>How a row gets its value</h2><div class="formula">implied = tvl_usd\n  &times; categoryMultiple(category)\n  &times; sqrt(1 + clamp(change_7d, ' + m.growth_floor + ', ' + m.growth_cap + ') / 100)\n  &times; (' + m.runway_floor +
      ' + ' + (1 - m.runway_floor).toFixed(2) + ' &times; min(age_days, ' + m.runway_days + ') / ' + m.runway_days + ')</div><ul>' +
      '<li><b>Category multiple</b>: the median ln(mcap / TVL) of the trading protocols in the category, shrunk toward the median of all ' + cal.global.n + ' by ' + m.shrink + ' pseudo-samples, clamped to ' + m.multiple_min + '&ndash;' + m.multiple_max + '&times;. A category with no trading token takes the global ' + cal.global.multiple.toFixed(3) + '&times;.</li>' +
      '<li><b>Growth</b>: seven-day TVL change, square-rooted so one hot week cannot double a value. Missing change counts as 0.</li>' +
      '<li><b>No-token run</b>: days since DefiLlama began tracking it. A protocol that has held TVL for two years with no token has proved more than one listed last month. Unknown dates count as ' + m.unknown_age_days + ' days.</li>' +
      '<li><b>Confidence</b>: one point each for a known listing date, a known 7-day change, and three or more trading peers in the category.</li>' +
      '<li>Ranked: protocols recording no token id, symbol or market cap; never exchanges, bridges, liquid staking or wrapped, staked and versioned products. No protocol name is special-cased.</li></ul>' +
      '<h2 style="margin-top:20px">Try the constants</h2><p>Moving a slider re-runs <b>buildRadar</b> on the snapshot and re-ranks the whole page.</p>';
    html += SLIDERS.map(function (s) {
      return '<div class="slider"><label for="s-' + s[0] + '">' + s[1] + '</label><input id="s-' + s[0] + '" type="range" min="' + s[2] + '" max="' + s[3] + '" step="' + s[4] + '" value="' + m[s[0]] + '" data-k="' + s[0] + '"><span class="mono">' + m[s[0]] + '</span></div>';
    }).join('') + (Object.keys(overrides).length ? '<button class="link" data-resetmodel>Back to radar-2</button>' : '') + '</div>';
    html += '<div class="card"><h2>Calibration: what the market pays per dollar of TVL</h2><table class="peers"><thead><tr><th>Category</th><th class="n">Trading</th><th class="n">Raw median</th><th class="n">Multiple used</th><th class="n">Ranked here</th></tr></thead><tbody>';
    var ranked = {}; radar.rows.forEach(function (r) { var c = r.category || 'Uncategorised'; ranked[c] = (ranked[c] || 0) + 1; });
    var cats = Object.keys(cal.categories).sort(function (a, b) { return cal.categories[b].n - cal.categories[a].n || (a < b ? -1 : 1); });
    html += cats.map(function (c) {
      var x = cal.categories[c];
      return '<tr><td>' + esc(c) + '</td><td class="n">' + x.n + '</td><td class="n">' + x.median.toFixed(3) + '&times;</td><td class="n">' + x.multiple.toFixed(3) + '&times;</td><td class="n">' + (ranked[c] || 0) + '</td></tr>';
    }).join('');
    return html + '</tbody></table></div></div>';
  }

  // ---- detail drawer ----
  function detail(r) {
    var s = r.model, p = r.plan, peers = radar.trading.filter(function (t) { return t.category === r.category; }).slice(0, 5);
    var base = r.tvl_usd * s.multiple;
    var factor = function (label, value, frac, cls, why) {
      return '<div>' + label + '</div><div class="track"><i class="' + cls + '" style="width:' + Math.max(2, Math.min(100, frac * 100)).toFixed(0) + '%"></i></div><div class="v">' + value + '</div><div class="why">' + why + '</div>';
    };
    var html = '<div class="dhead"><div><div class="psub">Rank ' + r.rank + ' of ' + radar.rows.length + '</div><h2>' + esc(r.name) + '</h2></div><button class="close" data-close>Close &times;</button></div>' +
      '<div class="chips"><span class="tag ' + (r.tier === 'watchlist' ? 'watch' : 'early') + '">' + r.tier + '</span><span class="tag">' + esc(r.category || 'Uncategorised') + '</span><span class="tag">records no token</span>' +
      r.chains.slice(0, 5).map(function (c) { return '<span class="tag">' + esc(c) + '</span>'; }).join('') + '<span class="tag conf ' + s.confidence + '">' + s.confidence + ' confidence</span></div>' +
      '<div class="big"><b>' + money(r.implied_value_usd) + '</b><span>implied token value if the record stays as it is<br>' + money(s.drop_pool) + ' community pool at ' + Math.round(radar.model.airdrop_share * 100) + '% &middot; ' + money(s.per_1k) + ' per $1k deposited</span></div>';
    html += '<div class="dgrid"><div><h3>Why this value</h3><div class="factors">' +
      factor('TVL', money(r.tvl_usd), 1, '', 'DefiLlama, ' + esc(radar.as_of) + '. Listed ' + (r.listed_at ? esc(r.listed_at) : 'on an unknown date') + '.') +
      factor('&times; Category multiple', s.multiple.toFixed(3) + '&times;', s.multiple / radar.model.multiple_max, '', s.peers ? s.peers + ' trading ' + esc(r.category) + ' protocol' + (s.peers > 1 ? 's' : '') + ', shrunk toward the global ' + radar.calibration.global.multiple.toFixed(3) + '&times;' : 'No trading peer in its category: the global multiple') +
      factor('&times; 7-day growth', s.growth.toFixed(3) + '&times;', s.growth / 1.5, s.growth >= 1 ? 'pos' : 'neg', 'TVL ' + (r.change_7d === null ? 'change not reported (0%)' : (r.change_7d >= 0 ? '+' : '') + r.change_7d.toFixed(2) + '% in 7 days') + ', square-rooted') +
      factor('&times; No-token run', s.runway.toFixed(3) + '&times;', s.runway, '', s.age_days === null ? 'Listing date unknown: counted as ' + radar.model.unknown_age_days + ' days' : s.age_days + ' days tracked with no token on record') +
      factor('= Implied value', money(r.implied_value_usd), r.implied_value_usd / base, '', money(base) + ' at the category multiple, then growth and run') + '</div>';
    if (peers.length) {
      html += '<h3>Trading peers in ' + esc(r.category) + '</h3><table class="peers"><tbody>' + peers.map(function (t) {
        return '<tr><td>' + esc(t.name) + ' <span class="psub">' + esc(t.symbol || '') + '</span></td><td class="n">' + money(t.tvl_usd) + ' TVL</td><td class="n">' + money(t.mcap_usd) + ' mcap</td><td class="n">' + t.market_multiple.toFixed(2) + '&times;</td></tr>';
      }).join('') + '</tbody></table>';
    }
    // Sensitivity: the same score() on what-if copies of the record, so the reader sees what moves the value.
    var src = SNAP.protocols.filter(function (x) { return x.slug === r.slug; })[0];
    var later = function (d) { var t = Date.parse(radar.as_of + 'T00:00:00Z') + d * 86400000; return new Date(t).toISOString().slice(0, 10); };
    var whatIf = [
      ['TVL 20% higher', Object.assign({}, src, { tvl_usd: src.tvl_usd * 1.2 }), radar.as_of],
      ['TVL 20% lower', Object.assign({}, src, { tvl_usd: src.tvl_usd * 0.8 }), radar.as_of],
      ['7-day change +15%', Object.assign({}, src, { change_7d: 15 }), radar.as_of],
      ['180 more days, no token', src, later(180)]
    ];
    html += '<h3>What moves it</h3><table class="peers"><tbody>' + whatIf.map(function (w) {
      var v = M.score(w[1], w[2], radar.calibration, radar.model).implied, d = v / r.implied_value_usd - 1;
      return '<tr><td>' + w[0] + '</td><td class="n">' + money(v) + '</td><td class="n ' + (d >= 0 ? 'up' : 'down') + '">' + (d >= 0 ? '+' : '') + (d * 100).toFixed(1) + '%</td></tr>';
    }).join('') + '</tbody></table>';
    html += '</div><div><h3>Farm plan &middot; ' + esc(p.kind) + ' on ' + esc(p.chain) + '</h3><div class="tiles">' +
      '<div class="tile"><span>Capital at risk</span><b>' + money(p.capital) + '</b></div><div class="tile"><span>Fees, all steps</span><b>' + money(p.fees_total) + '</b></div>' +
      '<div class="tile"><span>Yield forgone</span><b>' + money(p.forgone) + '</b></div><div class="tile"><span>Hold window</span><b>' + p.weeks + ' weeks</b></div>' +
      '<div class="tile"><span>Hands-on time</span><b>' + (p.hands_on_min / 60).toFixed(1) + ' h</b></div><div class="tile"><span>Model drop estimate</span><b>' + money(p.est_drop) + '</b></div></div>';
    html += '<ol class="steps">' + p.steps.map(function (st) {
      return '<li><div>' + esc(st.do) + '.</div><div class="ct">Cost <b>' + esc(st.cost) + '</b> &middot; Time <b>' + esc(st.time) + '</b></div></li>';
    }).join('') + '</ol><p class="note">Fees use a planning figure of ' + money(p.fee) + ' a transaction on ' + esc(p.chain) + ', the cheapest of the chains ' + esc(r.name) + ' lists first. Not advice: a protocol may never issue a token.</p></div></div>';
    return html;
  }
  function openDetail() {
    var r = state.p && bySlug[state.p];
    if (!r) { drawer.classList.remove('open'); drawer.setAttribute('aria-hidden', 'true'); scrim.hidden = true; return; }
    drawer.innerHTML = detail(r);
    drawer.classList.add('open'); drawer.setAttribute('aria-hidden', 'false'); scrim.hidden = false;
  }

  // ---- render and events ----
  function render() {
    var focus = document.activeElement && document.activeElement.id, caret = focus === 'q' ? document.activeElement.selectionStart : null;
    renderMeta();
    var body = state.tab === 'trading' ? trading() : state.tab === 'model' ? model() : board();
    app.innerHTML = hero() + tabs() + body;
    app.setAttribute('aria-busy', 'false');
    if (focus) { var el = document.getElementById(focus); if (el) { el.focus(); if (caret !== null) el.setSelectionRange(caret, caret); } }
    openDetail();
  }
  app.addEventListener('click', function (e) {
    var t = e.target.closest('button, tr[data-slug]');
    if (!t) return;
    if (t.dataset.tab) return set({ tab: t.dataset.tab, p: '' });
    if (t.dataset.sort) {
      var k = t.dataset.sort, numeric = k !== 'rank' && k !== 'name';
      return set({ sort: k, dir: state.sort === k ? (state.dir === 'asc' ? 'desc' : 'asc') : numeric ? 'desc' : 'asc' });
    }
    if (t.dataset.tier) return set({ tier: t.dataset.tier });
    if (t.dataset.mom) return set({ mom: t.dataset.mom });
    if (t.hasAttribute('data-reset')) return set({ q: '', cat: '', chain: '', tier: 'all', mom: 'all' });
    if (t.hasAttribute('data-resetmodel')) { overrides = {}; rebuild(); return render(); }
    if (t.dataset.slug) return set({ p: t.dataset.slug });
  });
  app.addEventListener('input', function (e) {
    if (e.target.id === 'q') return set({ q: e.target.value });
    if (e.target.dataset.k) { overrides[e.target.dataset.k] = Number(e.target.value); rebuild(); render(); }
  });
  app.addEventListener('change', function (e) {
    if (e.target.id === 'cat') set({ cat: e.target.value });
    if (e.target.id === 'chain') set({ chain: e.target.value });
  });
  drawer.addEventListener('click', function (e) { if (e.target.closest('[data-close]')) set({ p: '' }); });
  scrim.addEventListener('click', function () { set({ p: '' }); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && state.p) set({ p: '' }); });
  window.addEventListener('hashchange', function () { state = readHash(); render(); });

  rebuild();
  render();
})();
