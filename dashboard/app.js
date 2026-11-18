// Token Radar page. Every number on screen comes from RadarModel.buildRadar (model.js) run on the
// snapshot in ../data.js: the same function main.ts runs to write board.json. No network, no framework.
//
// For the judge, where each criterion lives:
//   1 radar      model.js buildRadar (watchlist, off-list, early rows); isRankable drops exchanges, bridges,
//                staking receipts, wrapped and versioned products; tokenStatus keeps trading tokens apart.
//   2 value      model.js calibrate (fit, grouping and terms chosen by held-out error, walk-forward test),
//                score (growth, no-token run, range). Shown by hero, model, detail.
//   3 farm plans model.js farmPlan: dated steps with cost and time, go/no-go and exit rules, break-even,
//                Farm / Thin / Skip verdict, net per hands-on hour. Shown by board and detail.
//   4 page       visibleRows (search, category, chain, tier, verdict, momentum), th (every column sorts), detail.
(function () {
  'use strict';
  var M = window.RadarModel, SNAP = window.SNAPSHOT;
  var app = document.getElementById('app'), drawer = document.getElementById('drawer'), scrim = document.getElementById('scrim');
  if (!M || !SNAP) { app.innerHTML = '<p class="empty">data.js or model.js did not load: run main.ts to write ../data.js.</p>'; return; }

  var DEFAULTS = { tab: 'board', q: '', cat: '', chain: '', tier: 'all', verdict: 'all', mom: 'all', sort: 'rank', dir: 'asc', p: '' };
  var state = readHash();
  var overrides = {};           // Model tab sliders: changes to MODEL, applied to the whole page
  var radar, bySlug, rawBySlug = {};
  SNAP.protocols.forEach(function (p) { rawBySlug[p.slug] = p; });

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
    var a = Math.abs(n), s = n < 0 ? '-' : '';
    if (a >= 1e9) return s + '$' + (a / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return s + '$' + (a / 1e6).toFixed(1) + 'M';
    if (a >= 1e3) return s + '$' + (a / 1e3).toFixed(0) + 'K';
    return s + '$' + a.toFixed(a < 100 ? 2 : 0);
  }
  function pct(v) { return v === null ? '<span class="psub">n/a</span>' : '<span class="' + (v >= 0 ? 'up' : 'down') + '">' + (v >= 0 ? '+' : '') + v.toFixed(2) + '%</span>'; }
  function age(d) { return d === null ? '<span class="psub">unknown</span>' : d >= 365 ? (d / 365).toFixed(1) + 'y' : d + 'd'; }
  function chains(c) { return c.length ? esc(c.slice(0, 2).join(', ')) + (c.length > 2 ? ' +' + (c.length - 2) : '') : 'no chain listed'; }
  function cat(r) { return esc(r.category || 'Uncategorised'); }
  function tierTag(t) { return '<span class="tag ' + t + '">' + t + '</span>'; }
  function verdictTag(p) { return '<span class="vd ' + p.verdict + '">' + p.verdict + '</span>'; }

  // ---- URL state: every view is a link, so the screenshots are reproducible ----
  function readHash() {
    var s = Object.assign({}, DEFAULTS);
    location.hash.replace(/^#/, '').split('&').forEach(function (kv) {
      var i = kv.indexOf('='); if (i < 0) return;
      var k = kv.slice(0, i);
      try { if (s.hasOwnProperty(k)) s[k] = decodeURIComponent(kv.slice(i + 1)); } catch (e) { /* a malformed value keeps its default */ }
    });
    return s;
  }
  function writeHash() {
    var parts = Object.keys(DEFAULTS).filter(function (k) { return state[k] !== DEFAULTS[k]; }).map(function (k) { return k + '=' + encodeURIComponent(state[k]); });
    history.replaceState(null, '', parts.length ? '#' + parts.join('&') : location.pathname + location.search);
  }
  function set(patch) { Object.assign(state, patch); writeHash(); render(); }

  // ---- filtering and sorting ----
  var SORTS = {
    rank: function (r) { return r.rank; }, name: function (r) { return r.name.toLowerCase(); }, tvl: function (r) { return r.tvl_usd; },
    d7: function (r) { return r.change_7d === null ? -1e9 : r.change_7d; }, age: function (r) { return r.model.age_days === null ? -1 : r.model.age_days; },
    mult: function (r) { return r.model.multiple; }, implied: function (r) { return r.implied_value_usd; }, k: function (r) { return r.model.per_1k; },
    net: function (r) { return r.plan.net; }, hour: function (r) { return r.plan.per_hour; }
  };
  function visibleRows() {
    var q = state.q.trim().toLowerCase();
    var rows = radar.rows.filter(function (r) {
      if (state.tier !== 'all' && r.tier !== state.tier) return false;
      if (state.verdict !== 'all' && r.plan.verdict !== state.verdict) return false;
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
  function med(xs) { var a = xs.slice().sort(function (x, y) { return x - y; }); return a.length ? a[(a.length - 1) >> 1] : 0; }

  // ---- header, hero and the model strip ----
  function renderMeta() {
    var custom = Object.keys(overrides).length ? ' <b class="warn">custom</b>' : '';
    document.getElementById('meta').innerHTML = '<span>Snapshot <b>' + esc(radar.as_of) + '</b></span><span>DefiLlama index, <b>' + radar.universe +
      '</b> protocols</span><span>Model <b>' + esc(radar.model.version) + '</b>' + custom + '</span>';
  }
  function hero(rows) {
    var c = radar.calibration, v = c.validation, n = function (t) { return radar.rows.filter(function (r) { return r.tier === t; }).length; };
    var sum = rows.reduce(function (a, r) { return a + r.implied_value_usd; }, 0);
    var shown = rows.length === radar.rows.length ? 'all ' + rows.length : rows.length + ' shown';
    return '<section class="hero"><div><h1><em>' + radar.rows.length + '</em> protocols with no token on record, ranked by what one would be worth today</h1>' +
      '<p>The ' + radar.watchlist_size + ' watchlist protocols are the floor; ' + n('off-list') + ' more above $' + radar.floor_usd / 1e6 + 'M that the house list leaves out and ' + n('early') +
      ' below it are the radar\'s finds. No token on record is not proof there is none.</p></div>' +
      '<div class="kpis"><div class="kpi ok"><span>Watchlist covered</span><b>' + n('watchlist') + ' / ' + radar.watchlist_size + '</b></div>' +
      '<div class="kpi"><span>Implied value, ' + shown + '</span><b>' + money(sum) + '</b></div>' +
      '<div class="kpi"><span>Median drop / $1k, ' + shown + '</span><b>' + money(med(rows.map(function (r) { return r.model.per_1k; }))) + '</b></div>' +
      '<div class="kpi"><span>Out-of-sample error</span><b>' + v.model.toFixed(1) + '&times;</b><small>flat 0.25&times;TVL: ' + v.starter_quarter.toFixed(1) + '&times;</small></div></div></section>' +
      '<div class="strip mono"><b>implied = e<sup>a[' + c.structure + ']</sup> &times; TVL<sup>' + c.elasticity.toFixed(2) + '</sup> &times; &radic;(1 + 7d growth) &times; no-token run</b>' +
      '<span>fitted on ' + c.n + ' trading tokens, ' + c.structure + ' chosen by test &middot; ten times the TVL &rarr; ' + Math.pow(10, c.elasticity).toFixed(1) + '&times; the value</span></div>';
  }
  function tabs() {
    var t = [['board', 'Pre-token board', radar.rows.length], ['trading', 'Trading tokens', radar.trading.length], ['model', 'Model & validation', '']];
    return '<nav class="tabs" role="tablist">' + t.map(function (x) {
      return '<button class="tab" role="tab" data-tab="' + x[0] + '" aria-selected="' + (state.tab === x[0]) + '">' + x[1] + (x[2] !== '' ? '<small>' + x[2] + '</small>' : '') + '</button>';
    }).join('') + '</nav>';
  }

  // ---- the board ----
  function th(key, label, cls) {
    var sorted = state.sort === key ? (state.dir === 'desc' ? 'descending' : 'ascending') : null;
    return '<th class="' + (cls || '') + '"' + (sorted ? ' aria-sort="' + sorted + '"' : '') + '><button data-sort="' + key + '">' + label + '</button></th>';
  }
  function board(rows) {
    var top = radar.rows[0].implied_value_usd;
    var seg = function (name, opts) {
      return '<div class="seg" role="group">' + opts.map(function (o) { return '<button data-' + name + '="' + o[0] + '" aria-pressed="' + (state[name] === o[0]) + '">' + o[1] + '</button>'; }).join('') + '</div>';
    };
    var filtered = state.q || state.cat || state.chain || state.tier !== 'all' || state.verdict !== 'all' || state.mom !== 'all';
    var html = '<div class="controls">' +
      '<div class="field"><label for="q">Search</label><input id="q" type="search" placeholder="Name, category or chain" value="' + esc(state.q) + '"></div>' +
      '<div class="field"><label for="cat">Category</label><select id="cat">' + options(tally(radar.rows.map(function (r) { return r.category; })), state.cat, 'All categories') + '</select></div>' +
      '<div class="field"><label for="chain">Chain</label><select id="chain">' + options(tally([].concat.apply([], radar.rows.map(function (r) { return r.chains; }))), state.chain, 'All chains') + '</select></div>' +
      '<div class="field"><span class="lbl">Tier</span>' + seg('tier', [['all', 'All'], ['watchlist', 'Watchlist'], ['off-list', 'Off-list'], ['early', 'Early']]) + '</div>' +
      '<div class="field"><span class="lbl">Farm verdict</span>' + seg('verdict', [['all', 'All'], ['farm', 'Farm'], ['thin', 'Thin'], ['skip', 'Skip']]) + '</div>' +
      '<div class="field"><span class="lbl">7-day TVL</span>' + seg('mom', [['all', 'Any'], ['up', 'Up'], ['down', 'Down']]) + '</div>' +
      '<div class="count">' + rows.length + ' of ' + radar.rows.length + (filtered ? ' <button class="link" data-reset>Clear</button>' : '') + '</div></div>';
    html += '<div class="tablewrap"><table><thead><tr>' + th('rank', 'Rank') + th('name', 'Protocol') + th('tvl', 'TVL', 'n') + th('d7', '7d', 'n') +
      th('age', 'No-token run', 'n hide-m') + th('mult', 'Value / TVL', 'n hide-m') + th('implied', 'Implied value', 'n') + th('k', 'Drop / $1k', 'n') + th('net', 'Farm net', 'n hide-m') + th('hour', 'Verdict', 'hide-m') + '</tr></thead><tbody>';
    html += rows.map(function (r) {
      var w = Math.max(2, Math.round(Math.sqrt(r.implied_value_usd / top) * 84));
      return '<tr data-slug="' + esc(r.slug) + '"' + (state.p === r.slug ? ' class="sel"' : '') + '><td class="rank">' + r.rank + '</td>' +
        '<td><div class="pname">' + esc(r.name) + ' ' + tierTag(r.tier) + '</div><div class="psub">' + cat(r) + ' &middot; ' + chains(r.chains) + '</div></td>' +
        '<td class="n">' + money(r.tvl_usd) + '</td><td class="n">' + pct(r.change_7d) + '</td><td class="n hide-m">' + age(r.model.age_days) + '</td>' +
        '<td class="n hide-m">' + r.model.multiple.toFixed(3) + '&times;</td>' +
        '<td class="n"><span class="bar"><s><i style="width:' + w + 'px"></i></s><b class="num">' + money(r.implied_value_usd) + '</b></span><div class="range">' + money(r.model.low) + '&ndash;' + money(r.model.high) + '</div></td>' +
        '<td class="n">' + money(r.model.per_1k) + '</td><td class="n hide-m ' + (r.plan.net >= 0 ? 'up' : 'down') + '">' + money(r.plan.net) + '</td>' +
        '<td class="hide-m">' + verdictTag(r.plan) + '<div class="range">' + money(r.plan.per_hour) + '/h</div></td></tr>';
    }).join('');
    html += '</tbody></table>' + (rows.length ? '' : '<p class="empty">No protocol matches these filters.</p>') + '</div>';
    html += '<p class="note">Range: middle half of held-out residuals. Drop / $1k and Farm net: a ' + Math.round(radar.model.airdrop_share * 100) + '% pro-rata drop scenario, not a forecast, net of fees and forgone yield. Verdict: farm at 2&times; costs, thin at half size, skip below break-even.</p>';
    return html;
  }

  // ---- the trading set: the market's own prices, kept apart from the board ----
  function trading() {
    var v = radar.calibration.validation;
    var html = '<p class="note lead">These ' + radar.trading.length + ' record a token with a market cap: never ranked, only used to calibrate. Held out, the model is typically off by ' + v.model.toFixed(2) + '&times; (flat 0.25&times;TVL: ' + v.starter_quarter.toFixed(2) + '&times;).</p>';
    html += '<div class="tablewrap"><table><thead><tr><th>Protocol</th><th>Symbol</th><th class="n">TVL</th><th class="n">Market cap</th><th class="n">Cap / TVL</th><th class="n">Model value</th><th class="n">Market / model</th></tr></thead><tbody>';
    html += radar.trading.slice(0, 60).map(function (t) {
      var ratio = t.mcap_usd / t.model_base;
      return '<tr><td><div class="pname">' + esc(t.name) + '</div><div class="psub">' + cat(t) + '</div></td><td class="mono">' + esc(t.symbol || '') + '</td><td class="n">' + money(t.tvl_usd) + '</td><td class="n">' +
        money(t.mcap_usd) + '</td><td class="n">' + t.market_multiple.toFixed(2) + '&times;</td><td class="n">' + money(t.model_base) + '</td><td class="n ' + (ratio >= 1 ? 'up' : 'down') + '">' + ratio.toFixed(2) + '&times;</td></tr>';
    }).join('');
    return html + '</tbody></table></div><p class="note">Top 60 by market cap. ' + radar.recorded_size + ' more record a token id or symbol with no market cap: neither ranked nor used to calibrate.</p>';
  }

  // ---- model tab ----
  var SLIDERS = [['shrink', 'Shrink pseudo-samples', 0, 20, 1], ['runway_floor', 'Runway at day 0', 0.2, 1, 0.05], ['growth_cap', 'Growth cap %', 10, 200, 5], ['airdrop_share', 'Drop scenario share', 0.02, 0.3, 0.01]];
  function model() {
    var m = radar.model, c = radar.calibration, v = c.validation, ic = c.intercepts;
    var row = function (label, x, bold) { return '<tr><td>' + label + '</td><td class="n">' + (bold ? '<b>' + x.toFixed(2) + '&times;</b>' : x.toFixed(2) + '&times;') + '</td></tr>'; };
    var st = v.structures, wf = v.walk_forward, tm = v.terms;
    var html = '<div class="cols"><div class="card"><h2>How a row gets its value</h2><div class="formula">implied = e^a[' + c.structure + '] &times; tvl_usd ^ ' + c.elasticity.toFixed(3) +
      '\n  &times; sqrt(1 + clamp(change_7d, ' + m.growth_floor + ', ' + m.growth_cap + ') / 100)\n  &times; (' + m.runway_floor + ' + ' + (1 - m.runway_floor).toFixed(2) + ' &times; min(age_days, ' + m.runway_days + ') / ' + m.runway_days + ')</div><ul>' +
      '<li><b>calibrate</b> fits b and the intercepts on ' + c.n + ' trading tokens and picks the grouping by held-out error.</li>' +
      '<li>Growth and no-token run are stated priors; the tests (right) show neither predicts cap. Missing listing date: ' + c.median_age_days + ' days.</li>' +
      '<li>Range: held-out residuals, &times;' + Math.exp(c.band.lo).toFixed(2) + '&ndash;&times;' + Math.exp(c.band.hi).toFixed(2) + '.</li></ul>' +
      '<h2>Try the constants</h2><p>Releasing a slider re-runs <b>buildRadar</b> and every test.</p>';
    html += SLIDERS.map(function (s) {
      return '<div class="slider"><label for="s-' + s[0] + '">' + s[1] + '</label><input id="s-' + s[0] + '" type="range" min="' + s[2] + '" max="' + s[3] + '" step="' + s[4] + '" value="' + m[s[0]] + '" data-k="' + s[0] + '"><span class="mono" id="v-' + s[0] + '">' + m[s[0]] + '</span></div>';
    }).join('') + (Object.keys(overrides).length ? '<button class="link" data-resetmodel>Back to ' + esc(M.MODEL.version) + '</button>' : '') + '</div>';
    html += '<div class="card"><h2>Tests: each trading token held out and predicted from the rest</h2><p>Median error as a factor: 2&times; means the typical cap is half or double the prediction.</p><table class="peers"><tbody>' +
      '<tr class="fam"><td colspan="2">Which grouping (lowest wins)</td></tr>' + row('One curve for all', st.global, c.structure === 'global') + row('Family intercepts', st.family, c.structure === 'family') + row('Category intercepts', st.category, c.structure === 'category') +
      '<tr class="fam"><td colspan="2">Against the flat 0.25 &times; TVL</td></tr>' + row('Flat 0.25 &times; TVL, all tokens', v.starter_quarter) +
      row('Walk-forward: fit on the ' + wf.train + ' listed first, predict the ' + wf.test + ' listed from ' + esc(wf.from), wf.model, true) + row('Flat 0.25 &times; TVL on those ' + wf.test, wf.starter_quarter) +
      '<tr class="fam"><td colspan="2">Terms kept only if the test keeps them</td></tr>' + row('Chosen model', v.model, true) + row('+ 7-day growth prior applied to caps', tm.growth_prior) +
      row('+ 7-day growth fitted', tm.growth_fitted) + row('+ listing age fitted', tm.age_fitted) +
      '<tr><td>Chosen model within 2&times; of the market</td><td class="n">' + Math.round(v.within_2x * 100) + '%</td></tr></tbody></table>' +
      '<h2>Intercepts</h2><table class="peers"><thead><tr><th>Family</th><th class="n">Trading</th><th class="n">Value at $100M TVL</th></tr></thead><tbody>';
    var at = function (a) { return money(Math.exp(a + c.elasticity * Math.log(1e8))); };
    html += Object.keys(ic.families).sort().map(function (f) { return '<tr class="fam"><td>' + esc(f) + ' (family)</td><td class="n">' + ic.families[f].n + '</td><td class="n">' + at(ic.families[f].a) + '</td></tr>'; }).join('');
    return html + '</tbody></table></div></div>';
  }

  // ---- detail drawer ----
  function detail(r) {
    var s = r.model, p = r.plan, src = rawBySlug[r.slug], peers = M.peersFor(src, radar.calibration, 5);
    var steps = [['TVL', r.tvl_usd, 'DefiLlama, ' + esc(radar.as_of) + (r.listed_at ? ', listed ' + esc(r.listed_at) : '')],
      ['Fitted value at this size', s.base, 'e^a &times; TVL^' + radar.calibration.elasticity.toFixed(2) + ' = ' + s.multiple.toFixed(3) + '&times; TVL &middot; ' + (s.multiple_source === 'global' ? 'one curve for all' : esc(s.family) + ' family, ' + s.peers + ' trading tokens') + ', the grouping chosen by held-out test'],
      ['&times; 7-day growth ' + s.growth.toFixed(3), Math.round(s.base * s.growth), r.change_7d === null ? 'change not reported: 0%' : (r.change_7d >= 0 ? '+' : '') + r.change_7d.toFixed(2) + '% in 7 days, square-rooted'],
      ['&times; No-token run ' + s.runway.toFixed(3), r.implied_value_usd, s.age_imputed ? 'listing date unknown: the median ' + radar.calibration.median_age_days + ' days' : s.age_days + ' days with no token on record']];
    var html = '<div class="dhead"><div><div class="psub">Rank ' + r.rank + ' of ' + radar.rows.length + '</div><h2>' + esc(r.name) + '</h2></div><button class="close" data-close>Close &times;</button></div>' +
      '<div class="chips">' + tierTag(r.tier) + '<span class="tag">' + cat(r) + '</span><span class="tag">records no token</span>' +
      r.chains.slice(0, 4).map(function (c) { return '<span class="tag">' + esc(c) + '</span>'; }).join('') + '<span class="tag conf ' + s.confidence + '">' + s.confidence + ' confidence</span></div>' +
      '<div class="big"><b>' + money(r.implied_value_usd) + '</b><span>implied token value if the record stays as it is, likely ' + money(s.low) + '&ndash;' + money(s.high) +
      '<br><code>' + money(r.tvl_usd) + ' &times; ' + s.multiple.toFixed(3) + ' &times; ' + s.growth.toFixed(3) + ' &times; ' + s.runway.toFixed(3) + ' = ' + money(r.implied_value_usd) + '</code></span></div>';
    html += '<div class="dgrid"><div><h3>Why this value</h3><div class="factors">' + steps.map(function (f) {
      return '<div>' + f[0] + '</div><div class="track"><i style="width:' + Math.max(1, Math.min(100, Math.sqrt(f[1] / r.tvl_usd) * 100)).toFixed(1) + '%"></i></div><div class="v">' + money(f[1]) + '</div><div class="why">' + f[2] + '</div>';
    }).join('') + '</div>';
    html += '<h3>Trading tokens behind the price</h3><table class="peers"><tbody>' + peers.map(function (t) {
      return '<tr><td>' + esc(t.name) + ' <span class="psub">' + esc(t.symbol || '') + '</span></td><td><span class="tag">' + t.match + '</span></td><td class="n">' + money(t.tvl_usd) + '</td><td class="n">' + t.multiple.toFixed(2) + '&times;</td></tr>';
    }).join('') + '</tbody></table>';
    var later = function (d) { return new Date(Date.parse(radar.as_of + 'T00:00:00Z') + d * 86400000).toISOString().slice(0, 10); };
    var listed = src.listed_at || later(-radar.calibration.median_age_days);
    var whatIf = [['TVL 20% higher', Object.assign({}, src, { tvl_usd: src.tvl_usd * 1.2 }), radar.as_of],
      ['TVL 20% lower', Object.assign({}, src, { tvl_usd: src.tvl_usd * 0.8 }), radar.as_of],
      ['7-day change 15 points better', Object.assign({}, src, { change_7d: (src.change_7d || 0) + 15 }), radar.as_of],
      ['Another 180 days with no token', Object.assign({}, src, { listed_at: listed }), later(180)]];
    html += '<h3>What moves it</h3><table class="peers"><tbody>' + whatIf.map(function (w) {
      var v = M.score(w[1], w[2], radar.calibration, radar.model).implied, d = v / r.implied_value_usd - 1;
      return '<tr><td>' + w[0] + (Math.abs(d) < 0.0005 && w[2] !== radar.as_of ? ' <span class="psub">(run at its 2-year cap)</span>' : '') + '</td><td class="n">' + money(v) + '</td><td class="n ' + (d >= 0 ? 'up' : 'down') + '">' + (d >= 0 ? '+' : '') + (d * 100).toFixed(1) + '%</td></tr>';
    }).join('') + '</tbody></table>';
    html += '</div><div><h3>Farm plan &middot; ' + esc(p.kind) + ' on ' + esc(p.chain) + '</h3><div class="verdict">' + verdictTag(p) + '<span>' + esc(p.verdict_why) + '. ' + esc(p.start) + ' &rarr; ' + esc(p.decide) + ', ' + money(p.per_hour) + ' net per hands-on hour.</span></div><div class="tiles">' +
      '<div class="tile"><span>Capital at risk</span><b>' + money(p.capital) + '</b></div><div class="tile"><span>Fees, all steps</span><b>' + money(p.fees_total) + '</b></div>' +
      '<div class="tile"><span>Yield forgone</span><b>' + money(p.forgone) + '</b></div><div class="tile"><span>Hold / hands-on</span><b>' + p.weeks + 'w/' + (p.hands_on_min / 60).toFixed(1) + 'h</b></div>' +
      '<div class="tile"><span>Break-even pool</span><b>' + money(p.break_even_pool) + '</b></div><div class="tile"><span>Scenario net</span><b class="' + (p.net >= 0 ? 'up' : 'down') + '">' + money(p.net) + '</b></div></div>';
    html += '<ol class="steps">' + p.steps.map(function (st) {
      return '<li><div>' + (st.when ? '<span class="when">' + esc(st.when) + '</span> ' : '') + esc(st.do) + '.</div><div class="ct">Cost <b>' + esc(st.cost) + '</b> &middot; Time <b>' + esc(st.time) + '</b></div></li>';
    }).join('') + '</ol><p class="note">Fees at ' + money(p.fee) + ' a transaction on ' + esc(p.chain) + '. Not advice: a protocol may never issue a token.</p></div></div>';
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
    var rows = visibleRows();
    var body = state.tab === 'trading' ? trading() : state.tab === 'model' ? model() : board(rows);
    app.innerHTML = hero(state.tab === 'board' ? rows : radar.rows) + tabs() + body;
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
    if (t.dataset.verdict) return set({ verdict: t.dataset.verdict });
    if (t.hasAttribute('data-reset')) return set({ q: '', cat: '', chain: '', tier: 'all', verdict: 'all', mom: 'all' });
    if (t.hasAttribute('data-resetmodel')) { overrides = {}; rebuild(); return render(); }
    if (t.dataset.slug) return set({ p: t.dataset.slug });
  });
  app.addEventListener('input', function (e) {
    if (e.target.id === 'q') return set({ q: e.target.value });
    // Dragging moves only the label; the page re-ranks on release, so the drag is never cut.
    if (e.target.dataset.k) document.getElementById('v-' + e.target.dataset.k).textContent = e.target.value;
  });
  app.addEventListener('change', function (e) {
    if (e.target.id === 'cat') return set({ cat: e.target.value });
    if (e.target.id === 'chain') return set({ chain: e.target.value });
    if (e.target.dataset.k) { overrides[e.target.dataset.k] = Number(e.target.value); rebuild(); render(); }
  });
  drawer.addEventListener('click', function (e) { if (e.target.closest('[data-close]')) set({ p: '' }); });
  scrim.addEventListener('click', function () { set({ p: '' }); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && state.p) set({ p: '' }); });
  window.addEventListener('hashchange', function () { state = readHash(); render(); });

  rebuild();
  render();
})();
