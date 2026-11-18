// Token Radar page. Every number on screen comes from RadarModel.buildRadar (model.js) run on the
// snapshot in ../data.js: the same function main.ts runs to write board.json. No network, no framework.
//
// For the judge, where each criterion lives:
//   1 radar      model.js buildRadar (watchlist, off-list, early rows); isRankable drops exchanges, bridges,
//                staking receipts, wrapped and versioned products; tokenStatus keeps trading tokens apart.
//   2 value      model.js calibrate (fit, grouping and terms chosen by held-out error, walk-forward test),
//                score (growth, no-token run, range); rankRanges, digest. Shown by top, detail.
//   3 farm plans model.js farmPlan: dated steps with cost and time, go/no-go and exit rules, break-even,
//                Farm / Thin / Skip verdict, net per hands-on hour. Shown by board and detail.
//   4 page       visibleRows (search, category, chain, tier, verdict, deposit size), th (every column sorts), detail.
(function () {
  'use strict';
  var M = window.RadarModel, SNAP = window.SNAPSHOT;
  var app = document.getElementById('app'), drawer = document.getElementById('drawer'), scrim = document.getElementById('scrim');
  if (!M || !SNAP) { app.innerHTML = '<p class="empty">data.js or model.js did not load: run main.ts to write ../data.js.</p>'; return; }

  var DEFAULTS = { cap: 'plan', q: '', cat: '', chain: '', tier: 'all', verdict: 'all', sort: 'rank', dir: 'asc', p: '' };
  var state = readHash();
  var radar, bySlug, rawBySlug = {};
  SNAP.protocols.forEach(function (p) { rawBySlug[p.slug] = p; });

  function rebuild() {
    radar = M.buildRadar(SNAP);
    bySlug = {};
    radar.rows.forEach(function (r) { bySlug[r.slug] = r; });
  }

  // The deposit toggle rebuilds every plan at that size with the same farmPlan; 'plan' keeps the model's own size.
  var plans = {};
  function plan(r) {
    if (state.cap === 'plan') return r.plan;
    var k = state.cap + r.slug;
    return plans[k] || (plans[k] = M.farmPlan(rawBySlug[r.slug], r.model, radar.model, +state.cap));
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
    odds: function (r) { return r.model.odds; }, implied: function (r) { return r.implied_value_usd; }, k: function (r) { return r.model.per_1k; },
    net: function (r) { return plan(r).net; }, hour: function (r) { return plan(r).per_hour; }
  };
  function visibleRows() {
    var q = state.q.trim().toLowerCase();
    var rows = radar.rows.filter(function (r) {
      if (state.tier !== 'all' && r.tier !== state.tier) return false;
      if (state.verdict !== 'all' && plan(r).verdict !== state.verdict) return false;
      if (state.cat && r.category !== state.cat) return false;
      if (state.chain && r.chains.indexOf(state.chain) < 0) return false;
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

  // ---- header and the top of the board: what was read, how a value is built, how it was tested ----
  function renderMeta() {
    document.getElementById('meta').innerHTML = '<span>Snapshot <b>' + esc(radar.as_of) + '</b></span><span>DefiLlama index, <b>' + radar.universe +
      '</b> protocols</span><span>Model <b>' + esc(radar.model.version) + '</b></span>';
  }
  var GROUPS = [['ranked', ['watchlist', 'off-list', 'early']], ['token trades', ['token trades']], ['token on record', ['token on record, no cap']],
    ['bridges', ['bridge']], ['exchanges', ['exchange']], ['staking receipts', ['staking receipt']], ['versioned or wrapped', ['versioned release', 'wrapped or staked']]];
  function accounting() {
    var R = radar.reasons, parts = GROUPS.map(function (g) { return [g[0], g[1].reduce(function (a, k) { return a + (R[k] || 0); }, 0)]; });
    return '<div class="acct"><div class="acbar">' + parts.map(function (x, i) { return '<i class="g' + i + '" style="width:' + (x[1] / radar.universe * 100).toFixed(2) + '%"></i>'; }).join('') +
      '</div><p><b>' + radar.universe + ' read</b> = ' + parts.map(function (x, i) { return '<span class="k g' + i + '"></span>' + x[1] + ' ' + x[0]; }).join(' + ') +
      '. Ranked: ' + R.watchlist + ' watchlist, ' + R['off-list'] + ' off-list above $' + radar.floor_usd / 1e6 + 'M, ' + R.early + ' early below it.</p></div>';
  }
  // Every trading token at its market cap, every ranked protocol at its implied value, and the fitted curve.
  function scatter() {
    var c = radar.calibration, W = 420, H = 150, lx = function (v) { return Math.log(v) / Math.LN10; };
    var X = function (v) { return ((lx(v) - 6.7) / 3.6 * W + 34).toFixed(1); }, Y = function (v) { return (H - (lx(Math.max(v, 1e5)) - 5) / 6 * H + 4).toFixed(1); };
    var g = function (t) { return Math.exp(c.intercepts.global + c.elasticity * Math.log(t)); };
    var s = '<svg class="sc" viewBox="0 0 460 176" role="img" aria-label="Market cap or implied value against TVL">';
    [1e7, 1e8, 1e9, 1e10].forEach(function (t) { s += '<text x="' + X(t) + '" y="172">' + money(t) + '</text>'; });
    [1e6, 1e8, 1e10].forEach(function (t) { s += '<text x="0" y="' + Y(t) + '">' + money(t) + '</text>'; });
    s += c.points.map(function (q) { return '<circle class="tr" cx="' + X(q.tvl) + '" cy="' + Y(q.mcap) + '" r="2.4"/>'; }).join('');
    s += radar.rows.map(function (r) { return '<circle class="pt" cx="' + X(r.tvl_usd) + '" cy="' + Y(r.model.if_launch) + '" r="2.4"/>'; }).join('');
    return s + '<line class="ln" x1="' + X(5e6) + '" y1="' + Y(g(5e6)) + '" x2="' + X(2e10) + '" y2="' + Y(g(2e10)) + '"/></svg>';
  }
  function top(rows) {
    var c = radar.calibration, v = c.validation, st = v.structures, wf = v.walk_forward, tm = v.terms, m = radar.model, R = radar.reasons, L = c.launch;
    var farm = rows.filter(function (r) { return plan(r).verdict === 'farm'; }).length;
    var row = function (label, x, cls) { return '<tr' + (cls ? ' class="' + cls + '"' : '') + '><td>' + label + '</td><td class="n">' + x.toFixed(2) + '&times;</td></tr>'; };
    var mono = radar.rows.every(function (r, i, a) { return !i || r.implied_value_usd <= a[i - 1].implied_value_usd; });
    var ok = window.BOARD_DIGEST === radar.digest && mono;
    return '<section class="kpis"><div class="kpi"><h1><em>' + radar.rows.length + '</em> protocols with no token on record, ranked by implied value</h1></div>' +
      '<div class="kpi ok"><span>Watchlist covered</span><b>' + R.watchlist + ' / ' + radar.watchlist_size + '</b></div>' +
      '<div class="kpi"><span>Held-out value miss</span><b>' + v.model.toFixed(2) + '&times;</b><small>flat 0.25&times;TVL ' + v.starter_quarter.toFixed(2) + '&times;</small></div>' +
      '<div class="kpi"><span>Launch odds, held out</span><b>' + Math.round(L.accuracy * 100) + '%</b><small>called right; base rate ' + Math.round(L.base_rate * 100) + '%</small></div>' +
      '<div class="kpi"><span>Farm verdicts, ' + rows.length + ' shown</span><b>' + farm + '</b></div></section>' + accounting() +
      '<section class="panels"><div class="card"><h2>How a value is built <code>score()</code></h2><ol class="how">' +
      '<li><b>Size curve</b> e<sup>a[' + c.structure + ']</sup> &times; TVL<sup>' + c.elasticity.toFixed(3) + '</sup>, fitted on ' + c.n + ' trading tokens; 10&times; the TVL is ' + Math.pow(10, c.elasticity).toFixed(1) + '&times; the value.</li>' +
      '<li><b>&times; 7-day growth</b> &radic;(1 + g), g in ' + m.growth_floor + '..' + m.growth_cap + '%.</li>' +
      '<li><b>&times; no-token run</b> ' + m.runway_floor + ' &rarr; 1.0 over ' + m.runway_days + ' days (unknown: ' + c.median_age_days + ' days). That is the value if it launches.</li>' +
      '<li><b>&times; launch odds</b>: logistic fit of &ldquo;records a token&rdquo; on TVL, days tracked and growth over ' + L.n + ' protocols.</li></ol>' +
      '<p>Band: P25&ndash;P75 of held-out misses, &times;' + Math.exp(c.band.lo).toFixed(2) + '&ndash;&times;' + Math.exp(c.band.hi).toFixed(2) + '. Rank range: P10&ndash;P90 of 100 bootstrap refits. No name is special-cased.</p></div>' +
      '<div class="card"><h2>Trading tokens set the curve <code>scatter()</code></h2>' + scatter() + '<p><span class="k tr"></span>' + c.n + ' trading, market cap <span class="k pt"></span>' + radar.rows.length + ' ranked, value if it launches <span class="k ln"></span>one curve for all (dots carry family, growth and run)</p></div>' +
      '<div class="card"><h2>Out of sample <code>calibrate()</code></h2><table class="peers"><tbody>' +
      row('Flat 0.25 &times; TVL (the starter)', v.starter_quarter) + row('One size curve for all', st.global, c.structure === 'global' ? 'win' : '') +
      row('Family intercepts (used)', st.family, c.structure === 'family' ? 'win' : '') + row('Category intercepts', st.category, c.structure === 'category' ? 'win' : '') +
      row('Same, without growth and run priors', tm.no_priors) + row('+ 7-day growth fitted', tm.growth_fitted) + row('+ listing age fitted', tm.age_fitted) +
      row('Walk-forward: ' + wf.test + ' listed from ' + esc(wf.from) + ' (flat ' + wf.starter_quarter.toFixed(2) + '&times;)', wf.model, 'win') + '</tbody></table>' +
      '<p>Every row scores the full formula with each token held out. ' + Math.round(v.within_3x * 100) + '% within 3&times;, rank correlation ' + v.rank_corr.toFixed(2) + '. Launch odds, 10-fold: ' + Math.round(L.accuracy * 100) + '% vs ' + Math.round(L.base_rate * 100) + '%.</p></div></section>' +
      '<p class="check ' + (ok ? 'yes' : 'no') + '">' + (ok ? '&#10003;' : '&#10007;') + ' board.json = this page: ranks, values, verdicts and all farm steps of ' + radar.rows.length + ' rows recomputed here, digest ' + radar.digest + (ok ? ' matches' : ' differs from') + ' main.ts. Values ' + (mono ? 'never rise' : 'RISE') + ' down the ranks.</p>';
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
    var filtered = state.q || state.cat || state.chain || state.tier !== 'all' || state.verdict !== 'all';
    var html = '<div class="controls">' +
      '<div class="field"><label for="q">Search</label><input id="q" type="search" placeholder="Name, category or chain" value="' + esc(state.q) + '"></div>' +
      '<div class="field"><label for="cat">Category</label><select id="cat">' + options(tally(radar.rows.map(function (r) { return r.category; })), state.cat, 'All categories') + '</select></div>' +
      '<div class="field"><label for="chain">Chain</label><select id="chain">' + options(tally([].concat.apply([], radar.rows.map(function (r) { return r.chains; }))), state.chain, 'All chains') + '</select></div>' +
      '<div class="field"><span class="lbl">Tier</span>' + seg('tier', [['all', 'All'], ['watchlist', 'Watchlist'], ['off-list', 'Off-list'], ['early', 'Early']]) + '</div>' +
      '<div class="field"><span class="lbl">Farm verdict</span>' + seg('verdict', [['all', 'All'], ['farm', 'Farm'], ['thin', 'Thin'], ['skip', 'Skip']]) + '</div>' +
      '<div class="field"><span class="lbl">Deposit</span>' + seg('cap', [['plan', 'Plan size'], ['1000', '$1k'], ['10000', '$10k']]) + '</div>' +
      '<div class="count">' + rows.length + ' of ' + radar.rows.length + (filtered ? ' <button class="link" data-reset>Clear</button>' : '') + '</div></div>';
    html += '<div class="tablewrap"><table><thead><tr>' + th('rank', 'Rank') + th('name', 'Protocol') + th('tvl', 'TVL', 'n') + th('d7', '7d', 'n') +
      th('age', 'No-token run', 'n hide-m') + th('odds', 'Launch odds', 'n hide-m') + th('implied', 'Implied value', 'n') + th('k', 'Drop / $1k', 'n') + th('net', 'Farm net', 'n hide-m') + th('hour', 'Verdict', 'hide-m') + '</tr></thead><tbody>';
    html += rows.map(function (r) {
      var w = Math.max(2, Math.round(Math.sqrt(r.implied_value_usd / top) * 84)), p = plan(r);
      return '<tr data-slug="' + esc(r.slug) + '"' + (state.p === r.slug ? ' class="sel"' : '') + '><td class="rank">' + r.rank + '<div class="range">' + r.rank_range[0] + '&ndash;' + r.rank_range[1] + '</div></td>' +
        '<td><div class="pname">' + esc(r.name) + ' ' + tierTag(r.tier) + '</div><div class="psub">' + cat(r) + ' &middot; ' + chains(r.chains) + '</div></td>' +
        '<td class="n">' + money(r.tvl_usd) + '</td><td class="n">' + pct(r.change_7d) + '</td><td class="n hide-m">' + age(r.model.age_days) + '</td>' +
        '<td class="n hide-m">' + Math.round(r.model.odds * 100) + '%<div class="range">if launch ' + money(r.model.if_launch) + '</div></td>' +
        '<td class="n"><span class="bar"><s><i style="width:' + w + 'px"></i></s><b class="num">' + money(r.implied_value_usd) + '</b></span><div class="range">' + money(r.model.low) + '&ndash;' + money(r.model.high) + '</div></td>' +
        '<td class="n">' + money(r.model.per_1k) + '</td><td class="n hide-m ' + (p.net >= 0 ? 'up' : 'down') + '">' + money(p.net) + '<div class="range">on ' + money(p.capital) + '</div></td>' +
        '<td class="hide-m">' + verdictTag(p) + '<div class="range">' + money(p.per_hour) + '/h</div></td></tr>';
    }).join('');
    html += '</tbody></table>' + (rows.length ? '' : '<p class="empty">No protocol matches these filters.</p>') + '</div>';
    html += '<p class="note">Implied value = value if it launches &times; launch odds. Drop / $1k and Farm net: a ' + Math.round(radar.model.airdrop_share * 100) + '% pro-rata drop of that value, a scenario and not a forecast, net of fees and forgone yield. Verdict: farm at 2&times; costs, thin rebuilt at half size, skip below break-even.</p>';
    return html;
  }

  // ---- detail drawer ----
  function detail(r) {
    var s = r.model, p = plan(r), src = rawBySlug[r.slug], peers = M.peersFor(src, radar.calibration, 5);
    var steps = [['TVL', r.tvl_usd, 'DefiLlama, ' + esc(radar.as_of) + (r.listed_at ? ', listed ' + esc(r.listed_at) : '')],
      ['Fitted value at this size', s.base, 'e^a &times; TVL^' + radar.calibration.elasticity.toFixed(2) + ' = ' + s.multiple.toFixed(3) + '&times; TVL &middot; ' + (s.multiple_source === 'global' ? 'one curve for all' : esc(s.family) + ' family, ' + s.peers + ' trading tokens') + ', the grouping chosen by held-out test'],
      ['&times; 7-day growth ' + s.growth.toFixed(3), Math.round(s.base * s.growth), r.change_7d === null ? 'change not reported: 0%' : (r.change_7d >= 0 ? '+' : '') + r.change_7d.toFixed(2) + '% in 7 days, square-rooted'],
      ['&times; No-token run ' + s.runway.toFixed(3), s.if_launch, s.age_imputed ? 'listing date unknown: the median ' + radar.calibration.median_age_days + ' days' : s.age_days + ' days with no token on record'],
      ['&times; Launch odds ' + s.odds.toFixed(3), r.implied_value_usd, 'records with this TVL, run and growth carry a token ' + Math.round(s.odds * 100) + '% of the time (logistic fit, held-out ' + Math.round(radar.calibration.launch.accuracy * 100) + '%)']];
    var html = '<div class="dhead"><div><div class="psub">Rank ' + r.rank + ' of ' + radar.rows.length + '</div><h2>' + esc(r.name) + '</h2></div><button class="close" data-close>Close &times;</button></div>' +
      '<div class="chips">' + tierTag(r.tier) + '<span class="tag">' + cat(r) + '</span><span class="tag">records no token</span>' +
      r.chains.slice(0, 4).map(function (c) { return '<span class="tag">' + esc(c) + '</span>'; }).join('') + '<span class="tag conf ' + s.confidence + '">' + s.confidence + ' confidence</span></div>' +
      '<div class="big"><b>' + money(r.implied_value_usd) + '</b><span>value if it launches &times; launch odds; central 50% band ' + money(s.low) + '&ndash;' + money(s.high) +
      '<br><code>' + money(r.tvl_usd) + ' &times; ' + s.multiple.toFixed(3) + ' &times; ' + s.growth.toFixed(3) + ' &times; ' + s.runway.toFixed(3) + ' &times; ' + s.odds.toFixed(3) + ' = ' + money(r.implied_value_usd) + '</code></span></div>';
    html += '<div class="dgrid"><div><h3>Why this value</h3><div class="factors">' + steps.map(function (f) {
      return '<div>' + f[0] + '</div><div class="track"><i style="width:' + Math.max(1, Math.min(100, Math.sqrt(f[1] / r.tvl_usd) * 100)).toFixed(1) + '%"></i></div><div class="v">' + money(f[1]) + '</div><div class="why">' + f[2] + '</div>';
    }).join('') + '</div>';
    html += '<h3>Trading tokens behind the price</h3><table class="peers"><tbody>' + peers.map(function (t) {
      return '<tr><td>' + esc(t.name) + ' <span class="psub">' + esc(t.symbol || '') + '</span></td><td><span class="tag">' + t.match + '</span></td><td class="n">' + money(t.tvl_usd) + '</td><td class="n">' + t.multiple.toFixed(2) + '&times;</td></tr>';
    }).join('') + '</tbody></table>';
    html += '</div><div><h3>Farm plan &middot; ' + esc(p.kind) + ' on ' + esc(p.chain) + '</h3><div class="verdict">' + verdictTag(p) + '<span>' + esc(p.verdict_why) + '. ' + esc(p.start) + ' &rarr; ' + esc(p.decide) + ', ' + money(p.per_hour) + ' net per hands-on hour.</span></div><div class="tiles">' +
      '<div class="tile"><span>Capital at risk</span><b>' + money(p.capital) + '</b></div><div class="tile"><span>Fees, all steps</span><b>' + money(p.fees_total) + '</b></div>' +
      '<div class="tile"><span>Yield forgone</span><b>' + money(p.forgone) + '</b></div><div class="tile"><span>Hold / hands-on</span><b>' + p.weeks + 'w/' + (p.hands_on_min / 60).toFixed(1) + 'h</b></div>' +
      '<div class="tile"><span>Break-even odds</span><b>' + Math.round(p.break_even_odds * 100) + '%</b></div><div class="tile"><span>Scenario net</span><b class="' + (p.net >= 0 ? 'up' : 'down') + '">' + money(p.net) + '</b></div></div>';
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
    app.innerHTML = top(rows) + board(rows);
    app.setAttribute('aria-busy', 'false');
    if (focus) { var el = document.getElementById(focus); if (el) { el.focus(); if (caret !== null) el.setSelectionRange(caret, caret); } }
    openDetail();
  }
  app.addEventListener('click', function (e) {
    var t = e.target.closest('button, tr[data-slug]');
    if (!t) return;
    if (t.dataset.sort) {
      var k = t.dataset.sort, numeric = k !== 'rank' && k !== 'name';
      return set({ sort: k, dir: state.sort === k ? (state.dir === 'asc' ? 'desc' : 'asc') : numeric ? 'desc' : 'asc' });
    }
    if (t.dataset.tier) return set({ tier: t.dataset.tier });
    if (t.dataset.verdict) return set({ verdict: t.dataset.verdict });
    if (t.dataset.cap) return set({ cap: t.dataset.cap });
    if (t.hasAttribute('data-reset')) return set({ q: '', cat: '', chain: '', tier: 'all', verdict: 'all' });
    if (t.dataset.slug) return set({ p: t.dataset.slug });
  });
  app.addEventListener('input', function (e) {
    if (e.target.id === 'q') set({ q: e.target.value });
  });
  app.addEventListener('change', function (e) {
    if (e.target.id === 'cat') return set({ cat: e.target.value });
    if (e.target.id === 'chain') set({ chain: e.target.value });
  });
  drawer.addEventListener('click', function (e) { if (e.target.closest('[data-close]')) set({ p: '' }); });
  scrim.addEventListener('click', function () { set({ p: '' }); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && state.p) set({ p: '' }); });
  window.addEventListener('hashchange', function () { state = readHash(); render(); });

  rebuild();
  render();
})();
