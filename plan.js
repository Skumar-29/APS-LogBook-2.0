/* Plan ahead: usual shift from the last four weeks, what fits in the next two weeks, trip checks,
   and a one-page availability report. Every check runs the same rules engine as the diary. */
(function () {
  'use strict';
  var WD = window.WD, FM = window.FM, D = 96, hm = FM.hm, esc = WD.esc, main = WD.main;
  var DAYS = 14, MAXROW = 6, cache = null;
  function P() { var s = WD.S.settings; if (!s.plan) s.plan = { own: false, start: '20:00', work: 12, days: 7, trips: [{ name: 'Melbourne to Sydney', hours: 10 }, { name: 'Melbourne to Brisbane', hours: 20 }] }; s.plan.trips.forEach(function (t) { if (t.hours == null) { t.hours = /brisbane/i.test(t.name) ? 20 : /sydney/i.test(t.name) ? 10 : (t.shifts || 1) * 10; delete t.shifts; } }); return s.plan; }
  function tabs(v) { return '<div class="subnav">' + [['plan', 'Plan ahead'], ['fortnight', 'Last 14 days']].map(function (t) { return '<a href="#' + t[0] + '"' + (t[0] === v ? ' aria-current="page"' : '') + '>' + t[1] + '</a>'; }).join('') + '</div>'; }

  /* ---------- rules helpers ---------- */
  function keys(W, c) { var k = {}; FM.analyse(W, c.opt, c.cfg).findings.forEach(function (f) { if (!f.warn) k[f.rule + ':' + f.kind + ':' + f.at] = f; }); return k; }
  function firstNew(W, base, c) { var k = keys(W, c); for (var x in k) if (!base[x] || (k[x].used > base[x].used)) return k[x]; return null; }
  function put(W, at, tpl, workMax) { var n = 0; for (var i = 0; i < tpl.length && at + i < W.length; i++) if (tpl[i]) { if (workMax != null && n >= workMax) break; W[at + i] = 1; n++; } return n; }
  function reason(f) {
    if (!f) return '';
    if (f.rule === 'ln7') return 'long/night limit (36h in 7 days)';
    if (f.rule === 'r84') return '24-hour rest due (84h work)';
    if (f.rule === 'd24') return f.kind === 'work' ? 'work limit for 24 hours' : '7-hour rest needed';
    if (/night rest/.test(f.msg)) return 'night rest breaks needed';
    if (/24 continuous/.test(f.msg)) return '24-hour rest needed';
    if (f.kind === 'work') return f.label.toLowerCase() + ' limit (' + hm(f.max) + ')';
    return f.label.toLowerCase();
  }
  // A shift of `work` slots with the rest breaks the rules ask for
  function makeShift(work, c) {
    var W = new Uint8Array(D * 3), out = [], n = 0, pos = D, c2 = { opt: c.opt, cfg: c.cfg };
    while (n < work && out.length < 24 * 4) { W[pos] = 1; var bad = Object.keys(keys(W, c2)).some(function (k) { return /^s\d+:/.test(k); }); if (bad) { W[pos] = 0; out.push(0); } else { out.push(1); n++; } pos++; }
    return out;
  }
  /* ---------- usual shift: the average of the last four weeks ---------- */
  function usual(c) {
    var p = P(), major = c.opt === 'std2' ? 20 : 28, W = c.W, from = Math.max(0, c.T - 28 * D), shifts = [], i = from;
    while (i < c.T && W[i]) i++; // skip a shift already running at the start of the window
    while (i < c.T) {
      if (!W[i]) { i++; continue; }
      var s = i, last = i, gap = 0; i++;
      while (i < c.T) { if (W[i]) { last = i; gap = 0; } else if (++gap >= major) break; i++; }
      if (last + 1 < c.T - 0 && (i < c.T || gap >= major)) { var work = 0; for (var k = s; k <= last; k++) work += W[k]; if (work >= 16) shifts.push({ s: s, e: last + 1, work: work, span: last + 1 - s }); }
    }
    var u = { count: shifts.length, from: 'default' };
    if (!p.own && shifts.length >= 3) {
      var med = function (a) { a = a.slice().sort(function (x, y) { return x - y; }); return a[Math.floor(a.length / 2)]; };
      var sx = 0, cx = 0; shifts.forEach(function (h) { var an = (h.s % D) / D * 2 * Math.PI; sx += Math.sin(an); cx += Math.cos(an); });
      var st = Math.round(((Math.atan2(sx, cx) / (2 * Math.PI) * D) + D) % D) % D, mw = med(shifts.map(function (h) { return h.work; })), ms = med(shifts.map(function (h) { return h.span; }));
      var best = shifts[0], bd = 1e9; shifts.forEach(function (h) { var d = Math.abs(h.work - mw) + Math.abs(h.span - ms); if (d <= bd) { bd = d; best = h; } });
      var tpl = Array.prototype.slice.call(W.subarray(best.s, best.e)), solo = new Uint8Array(D * 3); solo.set(tpl, D);
      if (Object.keys(keys(solo, c)).length) tpl = makeShift(mw, c); // the sample shift broke a break rule: use a clean one
      u.start = st; u.tpl = tpl; u.from = 'avg';
    } else {
      var m = /^(\d\d):(\d\d)$/.exec(p.start || '20:00') || [0, 20, 0];
      u.start = (+m[1] * 4 + Math.floor(+m[2] / 15)) % D; u.tpl = makeShift(Math.max(4, Math.min(56, Math.round((+p.work || 12) * 4))), c); u.from = p.own ? 'own' : 'default';
    }
    u.work = u.tpl.reduce(function (n, x) { return n + x; }, 0); u.span = u.tpl.length;
    return u;
  }
  /* ---------- the plan ---------- */
  function compute() {
    var c = WD.planCtx(), big = new Uint8Array(c.off + (DAYS + MAXROW + 3) * D); big.set(c.W.subarray(0, Math.min(c.W.length, big.length))); c.W = big;
    var u = usual(c), base = keys(c.W, c), day, out = { c: c, u: u, rows: [], avail: [] };
    var startOf = function (d) { return c.off + d * D + u.start; };
    // 1. If you work every usual shift: place them one by one, shorten or skip when a limit is hit
    var W = c.W.slice();
    for (day = 0; day < DAYS; day++) {
      var at = startOf(day), row = { day: day, at: at };
      if (at < c.T) { row.skip = c.working ? 'On shift now' : 'Usual start time has passed'; out.rows.push(row); continue; }
      var busy = false; for (var x = at - 4; x < at + u.span && x < W.length; x++) if (W[x]) { busy = true; break; }
      if (busy) { row.skip = 'Already in your diary'; row.planned = true; out.rows.push(row); continue; }
      var t = W.slice(); put(t, at, u.tpl); var f = firstNew(t, base, c);
      if (!f) { W = t; row.work = u.work; row.end = at + u.span; }
      else {
        row.why = reason(f); var okW = 0;
        for (var w = u.work - 4; w >= Math.max(16, Math.floor(u.work / 2)); w -= 4) { t = W.slice(); put(t, at, u.tpl, w); if (!firstNew(t, base, c)) { okW = w; break; } }
        if (okW) { W = t; row.work = okW; row.short = true; var n2 = 0, e2 = 0; for (var q = 0; q < u.tpl.length; q++) if (u.tpl[q] && n2 < okW) { n2++; e2 = q + 1; } row.end = at + e2; }
      }
      out.rows.push(row);
    }
    var res = FM.analyse(W, c.opt, c.cfg);
    out.rows.forEach(function (r) { if (r.work) { r.ln = 0; for (var i = r.at; i < r.end; i++) if (res.ln[i]) r.ln++; } });
    // 2. Availability by start day: resting until that day, how many usual shifts in a row can start
    for (day = 0; day < DAYS; day++) {
      var a0 = startOf(day), av = { day: day, at: a0, n: 0 };
      if (a0 < c.T) { av.note = c.working ? 'on shift now' : 'start time passed'; out.avail.push(av); continue; }
      var t2 = c.W.slice();
      for (var k = 0; k < MAXROW; k++) {
        var p0 = a0 + k * D, clash = false; for (var y = p0; y < p0 + u.span && y < t2.length; y++) if (t2[y]) { clash = true; break; }
        if (clash) { if (k === 0) av.note = 'already planned'; break; }
        var t3 = t2.slice(); put(t3, p0, u.tpl); var ff = firstNew(t3, base, c);
        if (ff) { av.why = reason(ff); break; }
        t2 = t3; av.n = k + 1;
      }
      out.avail.push(av);
    }
    out.planW = W; return out;
  }
  function limits(c) { // plain "due" lines from the standing right now
    var L = c.st.m.list, by = {}, out = []; L.forEach(function (m) { by[m.id] = m; });
    var d = by.d24;
    if (d) out.push(['Work left in this 24-hour period', d.from == null ? hm(d.max) + ' (new period starts when you start work)' : hm(Math.max(0, d.max - d.used)) + (d.restDue != null ? ' · 7-hour rest must start by ' + WD.absT(d.restDue, c.n) : ' · 7-hour rest already taken')]);
    if (by.r84) out.push(['Work left before a 24-hour rest', hm(Math.max(0, by.r84.max - by.r84.used)) + ' of 84h']);
    if (by.w7 && by.w7.max) out.push(['Work left in 7 days', hm(Math.max(0, by.w7.max - by.w7.used)) + (by.w7.to != null ? ' until ' + WD.absT(by.w7.to) + ', when older hours drop out' : '')]);
    if (by.ln7) out.push(['Long/night hours left', hm(Math.max(0, by.ln7.max - by.ln7.used)) + ' of 36h' + (by.ln7.to != null ? ' until ' + WD.absT(by.ln7.to) + ', when older hours drop out' : '')]);
    var w = by.w14 || by.w28;
    if (w) {
      if (w.max) out.push(['Work left in ' + (w.P / D) + ' days', hm(Math.max(0, w.max - w.used)) + ' of ' + hm(w.max) + (w.to != null ? ' until ' + WD.absT(w.to) + ', when older hours drop out' : '')]);
      if (w.rest && w.rest.got < w.rest.need) out.push(['24-hour rests', w.rest.got + ' of ' + w.rest.need + ' taken' + (w.restTo != null ? ' · needed before ' + WD.absT(w.restTo) : '')]);
      if (w.nights && (w.nights.got < w.nights.need || w.nights.pair === false)) out.push(['Night rest breaks', w.nights.got + ' of ' + w.nights.need + ' taken' + (w.restTo != null ? ' · needed before ' + WD.absT(w.restTo) : '')]);
    }
    return out;
  }
  function shiftText(u) { return WD.clock(u.start) + ' start, ' + hm(u.work) + ' work, ' + hm(u.span) + ' on shift'; }
  function tripFit(pl, n) { return pl.avail.filter(function (a) { return a.n >= n; }).map(function (a) { return a.day; }); }

  /* ---------- screen ---------- */
  function strip(pl, day) {
    var c = pl.c, o = c.off + day * D, r = '<rect x="0" y="0" width="32" height="10" fill="var(--night)"/><rect x="88" y="0" width="8" height="10" fill="var(--night)"/><rect x="32" y="0" width="56" height="10" fill="var(--cell)"/>', i = 0;
    while (i < D) { var real = c.W[o + i], plan = pl.planW[o + i]; if (!plan) { i++; continue; } var j = i; while (j < D && pl.planW[o + j] && c.W[o + j] === real) j++; r += '<rect x="' + i + '" y="0" width="' + (j - i) + '" height="10" fill="var(--work)"' + (real ? '' : ' opacity=".45"') + '/>'; i = j; }
    return '<svg class="strip" viewBox="0 0 96 10" preserveAspectRatio="none" aria-hidden="true">' + r + '</svg>';
  }
  function render() {
    main.innerHTML = '<div class="wrap">' + tabs('plan') + '<p class="hint">Working out your plan…</p></div>';
    setTimeout(function () { if ((location.hash || '') !== '#plan') return; try { cache = compute(); paint(cache); } catch (e) { main.innerHTML = '<div class="wrap">' + tabs('plan') + '<p class="note warn">The plan could not be worked out: ' + esc(e.message) + '</p></div>'; } }, 30);
  }
  function paint(pl) {
    var c = pl.c, u = pl.u, p = P(), n0 = c.n, run = 0, firstRest = null;
    pl.rows.some(function (r) { if (r.skip) return false; if (r.work && !r.short) { run++; return false; } firstRest = r; return true; });
    var src = u.from === 'avg' ? 'Average of your last 4 weeks (' + u.count + ' shifts)' : u.from === 'own' ? 'Your own numbers' : 'Starting numbers. The app switches to your own average after 3 recorded shifts';
    var h = '<div class="wrap">' + tabs('plan') + '<div class="datebar"><div class="day">Plan ahead</div><button class="btn pri" id="pl-send">Send availability</button></div>';
    h += '<div class="cols"><div class="stack">';
    h += '<div class="card stack" style="gap:10px"><h3>Your usual shift</h3><div class="big" style="font-size:30px">' + esc(shiftText(u)) + '<small>' + esc(src) + '. Rest breaks inside the shift are counted.</small></div>'
      + '<details class="fold" id="pl-own"' + (p.own ? ' open' : '') + '><summary style="font-size:15px">Change the shift used for planning</summary><label class="chk"><input type="checkbox" id="pl-useown"' + (p.own ? ' checked' : '') + '> Use my own numbers, not the average</label><div class="form" style="margin-top:8px"><label>Start time<input type="time" id="pl-start" step="900" value="' + esc(p.start) + '"></label><label>Work in a shift (hours)<input type="text" inputmode="decimal" id="pl-work" value="' + esc(p.work) + '"></label></div></details></div>';
    h += '<div class="card"><h3>If you work every usual shift</h3><div class="tw"><table><thead><tr><th>Day</th><th class="hide-sm">Midnight to midnight</th><th>Shift</th><th class="num">Work</th></tr></thead><tbody>'
      + pl.rows.map(function (r) {
        var cell = r.skip ? '<span class="hint">' + esc(r.skip) + '</span>' : r.work ? WD.clock(r.at) + ' to ' + WD.clock(r.end) + (r.short ? ' <span class="chip warn">short</span>' : '') : '<span class="chip">Rest day</span>';
        return '<tr><td style="white-space:nowrap">' + WD.fmtDay(n0 + r.day) + '</td><td class="hide-sm">' + strip(pl, r.day) + '</td><td>' + cell + (r.why ? '<small class="hint" style="display:block">' + esc(r.why) + '</small>' : '') + '</td><td class="num">' + (r.work ? hm(r.work) + (c.opt === 'bfm' && r.ln ? '<small class="hint" style="display:block">' + hm(r.ln) + ' long/night</small>' : '') : '–') + '</td></tr>';
      }).join('') + '</tbody></table></div><p class="hint" style="margin-top:10px">Light blue is the plan. Dark blue is already in your diary. A shift is made shorter or left out when it would break a limit.</p></div>';
    h += '</div><div class="stack">';
    h += '<div class="card"><h3>Coming up</h3><div class="meters"><div class="meter"><div class="hd"><b>Usual shifts in a row from now</b><span>' + run + '</span></div><small>' + (firstRest ? 'Then ' + (firstRest.work ? 'a short shift' : 'a rest day') + ' on ' + WD.fmtDay(n0 + firstRest.day) + (firstRest.why ? ': ' + esc(firstRest.why) : '') : 'No limit reached in the next ' + DAYS + ' days') + '</small></div>'
      + limits(c).map(function (x) { return '<div class="meter"><div class="hd"><b>' + esc(x[0]) + '</b></div><small style="font-size:15px;color:var(--ink)">' + esc(x[1]) + '</small></div>'; }).join('') + '</div></div>';
    h += '<div class="card stack" style="gap:10px"><h3>Trips</h3>' + p.trips.map(function (t, i) {
      var ns = tripShifts(t, u), fit = tripFit(pl, ns), txt = fit.length ? (fit[0] === 0 ? 'Can start today at ' + WD.clock(u.start) : 'Earliest start ' + WD.fmtDay(n0 + fit[0]) + ' ' + WD.clock(u.start)) : 'Does not fit in the next ' + DAYS + ' days';
      return '<div class="rowcard"><div class="rowhd"><b>' + esc(t.name) + '</b><span class="chip ' + (fit.length ? 'ok' : 'bad') + '">' + hm(Math.ceil(t.hours * 4)) + ' work</span></div><div>' + esc(txt) + '<small class="hint" style="display:block">About ' + ns + ' usual shift' + (ns > 1 ? 's' : '') + (t.km ? ' · ' + t.km.toLocaleString('en-AU') + ' km' : '') + '</small></div><div class="tripbtns"><button class="btn sm pri" data-trip="' + i + '">Plan this trip</button><button class="btn sm danger" data-rmtrip="' + i + '">Remove</button></div></div>';
    }).join('') + '<div class="form" style="grid-template-columns:1fr 96px auto;align-items:end"><label>Trip name<input id="pl-tn" placeholder="Melbourne to Adelaide"></label><label>Work hours<input id="pl-ts" type="text" inputmode="decimal" autocomplete="off" value="10"></label><button class="btn" id="pl-addtrip">Add trip</button></div>' + (window.claude && window.claude.use ? '' : '<button class="btn" id="pl-route">Work out hours from addresses</button>') + '<p class="hint">Tap Plan this trip to set when you leave and when you must arrive. The app shows your breaks, long/night hours and arrival time.</p></div>';
    h += '<p class="note warn">This is a forecast of the legal limits only. It assumes your diary is up to date and that you do no other work. Delays use up hours, so leave a margin. Never drive tired.</p>';
    h += '</div></div></div>';
    main.innerHTML = h;
    var redo = function () { WD.touch(); render(); };
    document.getElementById('pl-useown').addEventListener('change', function (e) { p.own = e.target.checked; redo(); });
    document.getElementById('pl-start').addEventListener('change', function (e) { if (e.target.value) { p.start = e.target.value; p.own = true; redo(); } });
    document.getElementById('pl-work').addEventListener('change', function (e) { p.work = Math.max(1, Math.min(14, +e.target.value || 12)); p.own = true; redo(); });
    main.querySelectorAll('[data-rmtrip]').forEach(function (b) { b.addEventListener('click', function () { p.trips.splice(+b.dataset.rmtrip, 1); redo(); }); });
    main.querySelectorAll('[data-trip]').forEach(function (b) { b.addEventListener('click', function () { tripSheet(+b.dataset.trip); }); });
    document.getElementById('pl-addtrip').addEventListener('click', function () { var n = document.getElementById('pl-tn').value.trim(), s = parseFloat(String(document.getElementById('pl-ts').value).replace(',', '.')); if (!n) return WD.toast('Enter a trip name.'); if (!(s > 0) || s > 100) return WD.toast('Enter the work hours, from 0.25 to 100.'); p.trips.push({ name: n, hours: Math.round(s * 100) / 100 }); WD.touch(); render(); setTimeout(function () { tripSheet(p.trips.length - 1); }, 60); });
    var rb = document.getElementById('pl-route'); if (rb) rb.addEventListener('click', routeSheet);
    document.getElementById('pl-send').addEventListener('click', function () { sendSheet(pl); });
  }

  /* ---------- availability report ---------- */
  function report(pl, days) {
    var c = pl.c, u = pl.u, p = P(), st = WD.S.settings, o = FM.OPTIONS[c.opt];
    var rows = pl.avail.slice(0, days).map(function (a) {
      var d = WD.fmtDay(c.n + a.day);
      return { day: d, n: a.n, text: a.n ? a.n + ' shift' + (a.n > 1 ? 's' : '') + ' in a row from ' + WD.clock(u.start) + (a.n >= MAXROW ? ' or more' : '') : 'Not available' + (a.note ? ' (' + a.note + ')' : a.why ? ' (' + a.why + ')' : ''), work: a.n * u.work };
    });
    var trips = p.trips.map(function (t) { var fit = tripFit(pl, tripShifts(t, u)).filter(function (d) { return d < days; }); return { name: t.name, hours: hm(Math.ceil(t.hours * 4)), days: fit.map(function (d) { return WD.fmtDay(c.n + d).split(' ').slice(0, 2).join(' '); }) }; });
    return { name: st.name || 'Driver', option: o.name, base: st.base, made: WD.fmtDay(c.n, true) + ' ' + WD.clock(c.T - c.off), from: WD.fmtDay(c.n), to: WD.fmtDay(c.n + days - 1), shift: shiftText(u), rows: rows, trips: trips, limits: limits(c), days: days };
  }
  function reportText(r) {
    var L = ['DRIVER AVAILABILITY', r.name + ' · ' + r.option + ' · ' + r.base + ' time', r.from + ' to ' + r.to + ' (made ' + r.made + ')', 'Usual shift: ' + r.shift, ''];
    r.rows.forEach(function (x) { L.push(x.day + ': ' + x.text); });
    if (r.trips.length) { L.push('', 'TRIPS'); r.trips.forEach(function (t) { L.push(t.name + ' (' + t.hours + ' work): ' + (t.days.length ? 'can start ' + t.days.join(', ') : 'does not fit in this period')); }); }
    L.push('', 'LIMITS NOW'); r.limits.forEach(function (x) { L.push(x[0] + ': ' + x[1]); });
    L.push('', 'Each line assumes no other work before that start day. Legal limits only, not a fitness check.');
    return L.join('\n');
  }
  function ascii(s) { return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/·/g, '-').replace(/[^\x20-\x7e]/g, ''); }
  function reportSvg(r) { // one A4 page in the PDF engine's own drawing words
    var x0 = 36, w = 523, y = 0, h = '', T = function (x, yy, t, size, bold, anchor, fill) { return '<text x="' + x + '" y="' + yy + '" font-size="' + size + '" font-weight="' + (bold ? 'bold' : 'normal') + '" text-anchor="' + (anchor || 'start') + '" fill="' + (fill || '#131e2b') + '">' + esc(ascii(t)) + '</text>'; };
    var R = function (x, yy, ww, hh, fill) { return '<rect x="' + x + '" y="' + yy + '" width="' + ww + '" height="' + hh + '" fill="' + fill + '" stroke="none"/>'; };
    h += R(0, 0, 595.28, 86, '#0f1a28') + T(x0, 40, 'DRIVER AVAILABILITY', 24, true, 'start', '#ffffff') + T(x0, 62, r.name + '  -  ' + r.option + '  -  ' + r.base + ' time', 12, false, 'start', '#c9d6e6') + T(x0 + w, 40, r.from + ' to ' + r.to, 13, true, 'end', '#ffffff') + T(x0 + w, 62, 'Made ' + r.made, 10, false, 'end', '#c9d6e6');
    y = 112; h += T(x0, y, 'USUAL SHIFT', 9, true, 'start', '#566475') + T(x0 + 90, y, r.shift, 12, true);
    y += 22; var rh = r.days > 7 ? 22 : 30, c1 = x0 + 10, c2 = x0 + 120, c3 = x0 + w - 10;
    h += R(x0, y, w, 22, '#1b4fd0') + T(c1, y + 15, 'START DAY', 9, true, 'start', '#ffffff') + T(c2, y + 15, 'CAN DO', 9, true, 'start', '#ffffff') + T(c3, y + 15, 'WORK HOURS', 9, true, 'end', '#ffffff'); y += 22;
    r.rows.forEach(function (row, i) {
      h += R(x0, y, w, rh, row.n ? (i % 2 ? '#eef3fb' : '#ffffff') : '#f1f1f1') + R(x0, y, 5, rh, row.n >= 2 ? '#17794a' : row.n === 1 ? '#b05a06' : '#9aa5b1');
      h += T(c1, y + rh / 2 + 4, row.day, 11.5, true) + T(c2, y + rh / 2 + 4, row.text, 11.5, false, 'start', row.n ? '#131e2b' : '#566475') + T(c3, y + rh / 2 + 4, row.n ? hm(row.work) : '-', 11.5, row.n > 0, 'end');
      y += rh;
    });
    h += '<line x1="' + x0 + '" y1="' + y + '" x2="' + (x0 + w) + '" y2="' + y + '" stroke="#d3dae3" stroke-width="1"/>';
    y += 26;
    if (r.trips.length) { h += T(x0, y, 'TRIPS', 9, true, 'start', '#566475'); y += 16; r.trips.slice(0, 6).forEach(function (t) { var ok = t.days.length > 0; h += R(x0, y - 10, 5, 13, ok ? '#17794a' : '#c32222') + T(c1, y, t.name + ' (' + t.hours + ' work)', 11, true) + T(x0 + 250, y, ok ? 'Can start: ' + t.days.slice(0, 5).join(', ') + (t.days.length > 5 ? ' and ' + (t.days.length - 5) + ' more days' : '') : 'Does not fit in this period', 10.5, false, 'start', ok ? '#131e2b' : '#c32222'); y += 18; }); y += 10; }
    h += T(x0, y, 'LIMITS NOW', 9, true, 'start', '#566475'); y += 16;
    r.limits.slice(0, 7).forEach(function (x) { h += T(c1, y, x[0], 10.5, true) + T(x0 + 250, y, x[1], 10.5); y += 16; });
    h += '<line x1="' + x0 + '" y1="786" x2="' + (x0 + w) + '" y2="786" stroke="#d3dae3" stroke-width="1"/>' + T(x0, 802, 'Each line assumes no other work before that start day. Shifts in a row are at the usual shift length.', 9, false, 'start', '#566475') + T(x0, 815, 'Forecast of legal work and rest limits only. It is not a fitness-to-drive check and not a work diary record.', 9, false, 'start', '#566475');
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 595.28 841.89" role="img" aria-label="Driver availability"><rect width="595.28" height="841.89" fill="#ffffff"/><g font-family="Arial, Helvetica, sans-serif">' + h + '</g></svg>';
  }
  function sendSheet(pl) {
    var p = P(), m = document.createElement('div'); m.className = 'modal sheetm wide';
    m.innerHTML = '<div class="box" role="dialog" aria-modal="true" aria-label="Send availability"><div class="sheet-hd"><h2>Send availability</h2><button class="btn sm" data-close>Close</button></div><div class="sheet-bd"></div></div>';
    document.body.appendChild(m); var bd = m.querySelector('.sheet-bd'); m.querySelector('[data-close]').addEventListener('click', function () { m.remove(); });
    function paintSheet() {
      var r = report(pl, p.days), text = reportText(r), enc = encodeURIComponent(text);
      bd.innerHTML = '<div class="kinds" id="rp-days">' + [3, 7, 14].map(function (d) { return '<button type="button" data-d="' + d + '" aria-pressed="' + (p.days === d) + '">' + (d === 3 ? 'Next 3 days' : d === 7 ? 'One week' : 'Two weeks') + '</button>'; }).join('') + '</div>'
        + '<div class="tools" style="margin-top:12px">' + (navigator.share ? '<button class="btn pri" id="rp-share">Share…</button>' : '') + '<a class="btn" href="https://wa.me/?text=' + enc + '" target="_blank" rel="noopener noreferrer">WhatsApp</a><a class="btn" href="sms:?&body=' + enc + '">Text message</a><button class="btn" id="rp-copy">Copy text</button><button class="btn" id="rp-pdf">PDF</button></div>'
        + '<div class="paper-scroll"><div class="paper">' + reportSvg(r) + '</div></div><h3>Text version</h3><textarea readonly id="rp-text" style="min-height:220px;font-size:14px">' + esc(text) + '</textarea>';
      bd.querySelectorAll('#rp-days button').forEach(function (b) { b.addEventListener('click', function () { p.days = +b.dataset.d; WD.touch(); paintSheet(); }); });
      var sh = bd.querySelector('#rp-share'); if (sh) sh.addEventListener('click', function () { navigator.share({ title: 'Driver availability', text: text }).catch(function () {}); });
      bd.querySelector('#rp-copy').addEventListener('click', function () { (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(function () { WD.toast('Copied. Paste it into your message.'); }, function () { var t = bd.querySelector('#rp-text'); t.focus(); t.select(); WD.toast('Select the text and copy it.'); }); });
      bd.querySelector('#rp-pdf').addEventListener('click', function (e) {
        if (!window.WDOffice) return WD.toast('PDF is not available here.');
        var b = e.target; b.disabled = true; b.textContent = 'Making PDF…'; var name = 'Availability-' + WD.keyOf(pl.c.n);
        window.WDOffice.core().then(function (APS) { return APS.createPdf([reportSvg(r)], name); }).then(function (blob) { b.disabled = false; b.textContent = 'PDF'; return window.WDOffice.shareFile(blob, name + '.pdf'); })
          .catch(function (er) { b.disabled = false; b.textContent = 'PDF'; WD.toast((er && er.message) || 'The PDF could not be made.'); });
      });
    }
    paintSheet();
  }
  /* ---------- trip planner: work hours, leave time, arrive-by time ---------- */
  var TRUCKS = { semi: ['Semi trailer', 4.3, 42.5, 19], bd: ['B-double', 4.3, 62.5, 26], rigid: ['Rigid truck', 4.3, 22.5, 12.5] };
  function slotOf(t) { var m = /^(\d\d?):(\d\d)$/.exec(t || ''); return m ? (+m[1]) * 4 + Math.floor(+m[2] / 15) : null; }
  function tripShifts(t, u) { return Math.max(1, Math.min(MAXROW, Math.ceil(t.hours * 4 / Math.max(4, u.work)))); }
  function tripCtx() { var c = WD.planCtx(), big = new Uint8Array(c.off + (DAYS + 12) * D); big.set(c.W.subarray(0, Math.min(c.W.length, big.length))); c.W = big; c.major = c.opt === 'std2' ? 20 : 28; return c; }
  function tm(c, abs, ref) { var r = abs - c.off, d = Math.floor(r / D), s = ((r % D) + D) % D, day = WD.fmtDay(c.n + d).split(' ').slice(0, 2).join(' '); return (ref != null && Math.floor((ref - c.off) / D) === d ? '' : day + ' ') + WD.clock(s); }
  // Place H work slots from `dep`, as early as the rules allow. cap = most work slots in one shift (0 = no cap).
  function tripSim(c, dep, H, cap, minRest) {
    minRest = minRest || [];
    var W = c.W.slice(), i; for (i = dep; i < W.length; i++) W[i] = 0;
    var base = keys(W, c), pos = dep, n = 0, inShift = 0, restRun = 0, must = 0, ri = 0, limit = Math.min(W.length - 1, dep + 9 * D), why = {};
    while (n < H && pos < limit) {
      if (cap && inShift >= cap) { must = Math.max(c.major, minRest[ri] || 0); inShift = 0; }
      if (must > 0) { must--; restRun++; pos++; continue; }
      var kk = Math.min(4, H - n, cap ? cap - inShift : 4, limit - pos), q;
      if (kk > 1) { for (q = 0; q < kk; q++) W[pos + q] = 1; if (!firstNew(W, base, c)) { if (restRun >= c.major) ri++; n += kk; inShift += kk; restRun = 0; pos += kk; continue; } for (q = 1; q < kk; q++) W[pos + q] = 0; }
      W[pos] = 1; var f = firstNew(W, base, c);
      if (!f) { if (restRun >= c.major) ri++; n++; inShift++; restRun = 0; }
      else { W[pos] = 0; restRun++; why[pos] = reason(f); if (restRun === c.major) { inShift = 0; if ((minRest[ri] || 0) > restRun) must = minRest[ri] - restRun; } }
      pos++;
    }
    if (n < H) return null;
    var end = pos, first = dep; while (first < end && !W[first]) first++;
    var legs = [], cur = null, r0 = -1;
    for (i = first; i <= end; i++) {
      if (i < end && W[i]) {
        if (r0 >= 0) { var len = i - r0; if (len >= c.major) { legs.push(cur); legs.push({ rest: true, s: r0, e: i, len: len, why: why[i - 1] || '' }); cur = null; } else cur.breaks.push({ at: r0, len: len }); r0 = -1; }
        if (!cur) cur = { s: i, e: i + 1, work: 0, breaks: [] };
        cur.work++; cur.e = i + 1;
      } else if (r0 < 0) r0 = i;
    }
    if (cur) legs.push(cur);
    var res = FM.analyse(W, c.opt, c.cfg), ln = 0; for (i = dep; i < end; i++) if (res.ln[i]) ln++;
    var lnm = null; FM.meters(W, c.opt, c.cfg, end).list.forEach(function (m) { if (m.ln) lnm = m; });
    return { W: W, dep: dep, first: first, end: end, H: H, legs: legs, ln: ln, lnLeft: lnm ? Math.max(0, lnm.max - lnm.used) : null, lnMax: lnm ? lnm.max : null, waitWhy: first > dep ? (why[first - 1] || '') : '', cap: cap };
  }
  // Move a long wait in the middle of a shift into the sleep break before it, when that does not make the trip longer
  function tripBest(c, dep, H, cap) {
    var s = tripSim(c, dep, H, cap), mr = [], guard = 0;
    while (s && guard++ < 5) {
      var rc = -1, hit = null; s.legs.some(function (l) { if (l.rest) { rc++; return false; } if (rc < 0) return false; var b = l.breaks.filter(function (x) { return x.len >= 6; })[0]; if (b) hit = { r: rc, len: b.len, rest: s.legs[s.legs.indexOf(l) - 1].len }; return !!b; });
      if (!hit) break;
      var done = [hit.len, hit.len - 1, hit.len - 2, hit.len - 4].some(function (t) { if (t < 2) return false; var m2 = mr.slice(); m2[hit.r] = hit.rest + t; var s2 = tripSim(c, dep, H, cap, m2); if (s2 && s2.end <= s.end) { s = s2; mr = m2; return true; } return false; });
      if (!done) break;
    }
    return s;
  }
  function mins(x) { return x < 4 ? x * 15 + ' min' : hm(x); }
  function tripPlan(H, dep, arrBy) {
    var c = tripCtx(), out = { c: c, tips: [], H: H };
    if (dep < c.T) { dep = c.T; out.clamped = true; }
    var fast = tripBest(c, dep, H, 0), k = Math.ceil(H / 48), capB = k > 1 ? Math.ceil(H / k) : 0, bal = capB ? tripBest(c, dep, H, capB) : fast;
    if (!fast) { out.fail = true; return out; }
    if (!bal) bal = fast;
    var useBal = bal !== fast && (arrBy != null ? bal.end <= arrBy : bal.end <= fast.end + 8) && bal.ln <= fast.ln;
    var best = useBal ? bal : fast, other = useBal ? fast : bal; out.best = best; out.arrBy = arrBy; out.dep = dep;
    if (other !== best && (other.end !== best.end || other.ln !== best.ln)) out.other = { s: other, name: useBal ? 'Fewest stops' : 'Even shifts' };
    out.even = useBal;
    var sim = function (d) { return d >= c.T && d < c.off + (DAYS + 1) * D ? tripSim(c, d, H, best.cap) : null; };
    if (arrBy != null) {
      if (best.end > arrBy) {
        out.late = best.end - arrBy; var d2 = dep, s2 = best, n2 = 0;
        while (s2 && s2.end > arrBy && n2++ < 8) { d2 -= s2.end - arrBy; s2 = sim(d2); }
        if (s2 && s2.end <= arrBy) out.tips.push('To arrive on time, leave by ' + tm(c, d2) + '.');
        else { var now = tripBest(c, c.T, H, 0); out.tips.push(now && now.end > arrBy ? 'You cannot legally arrive by then. Leaving right now, the earliest arrival is ' + tm(c, now.end) + '.' : 'There is not enough legal time before the arrive-by time. Ask for a later delivery time.'); }
      } else {
        out.slack = arrBy - best.end; var d3 = dep + out.slack, s3 = sim(d3), n3 = 0;
        while (s3 && s3.end > arrBy && n3++ < 8) { d3 -= s3.end - arrBy; s3 = sim(d3); }
        if (s3 && s3.end <= arrBy && d3 - dep >= 2) { out.latest = d3; out.tips.push('You have time to spare. The latest you can leave and still arrive on time is ' + tm(c, d3) + '.'); }
      }
    }
    // a different leave time that uses less long/night work
    var bestAlt = null; if (!out.late) [-16, -12, -8, -4, 4, 8, 12, 16].forEach(function (dx) { var s = sim(dep + dx); if (!s || (arrBy != null && s.end > arrBy)) return; if (best.ln - s.ln >= 4 && (!bestAlt || s.ln < bestAlt.s.ln || (s.ln === bestAlt.s.ln && Math.abs(dx) < Math.abs(bestAlt.dx)))) bestAlt = { s: s, dx: dx }; });
    if (bestAlt) out.tips.push('Leave at ' + tm(c, dep + bestAlt.dx) + ' instead (' + hm(Math.abs(bestAlt.dx)) + (bestAlt.dx < 0 ? ' earlier' : ' later') + ') and the trip uses ' + hm(best.ln - bestAlt.s.ln) + ' less long/night work. You would arrive ' + tm(c, bestAlt.s.end) + '.');
    if (best.first > dep) out.tips.unshift('You cannot start work until ' + tm(c, best.first) + (best.waitWhy ? ' (' + best.waitWhy + ')' : '') + '.');
    if (best.lnLeft != null && best.lnLeft < 16) out.tips.push('After this trip you have only ' + hm(best.lnLeft) + ' of long/night work left. Plan day work or a long rest next.');
    if (best.legs.some(function (l) { return l.rest && l.len >= D; })) out.tips.push('This trip includes a 24-hour rest, because one falls due on the way.');
    return out;
  }
  function tripLines(pl, name) { // plain text, for the screen copy and for sending
    var c = pl.c, b = pl.best, L = [(name || 'Trip') + ': ' + hm(pl.H) + ' work', 'Leave ' + tm(c, pl.dep) + ', arrive ' + tm(c, b.end) + (pl.arrBy != null ? (b.end <= pl.arrBy ? ' (on time, needed by ' + tm(c, pl.arrBy) + ')' : ' (' + hm(pl.late) + ' after ' + tm(c, pl.arrBy) + ')') : ''), ''];
    b.legs.forEach(function (l) {
      if (l.rest) L.push(tm(c, l.s) + ' to ' + tm(c, l.e, l.s) + ': REST ' + hm(l.len));
      else L.push(tm(c, l.s) + ' to ' + tm(c, l.e, l.s) + ': WORK ' + hm(l.work) + (l.breaks.length ? ', short breaks at ' + l.breaks.map(function (x) { return WD.clock(((x.at - c.off) % D + D) % D) + ' (' + mins(x.len) + ')'; }).join(', ') : ''));
    });
    L.push('', 'Long/night work used: ' + hm(b.ln) + (b.lnLeft != null ? ' (' + hm(b.lnLeft) + ' left after the trip)' : ''));
    L.push('Legal limits only. Delays use up hours.');
    return L.join('\n');
  }
  function sheetBox(title) {
    var m = document.createElement('div'); m.className = 'modal sheetm wide';
    m.innerHTML = '<div class="box" role="dialog" aria-modal="true" aria-label="' + esc(title) + '"><div class="sheet-hd"><h2>' + esc(title) + '</h2><button class="btn sm" data-close>Close</button></div><div class="sheet-bd"></div></div>';
    document.body.appendChild(m); m.querySelector('[data-close]').addEventListener('click', function () { m.remove(); render(); }); return m;
  }
  function tripSheet(i) {
    var p = P(), t = p.trips[i]; if (!t) return;
    var c0 = WD.planCtx(), nowS = c0.T - c0.off, u = cache ? cache.u : { start: slotOf(p.start) || 80 };
    var pad = function (x) { return (x < 10 ? '0' : '') + x; }, hhmm = function (s) { return pad(Math.floor(s / 4)) + ':' + pad((s % 4) * 15); };
    if (!t.dep) t.dep = hhmm(u.start);
    var ds = slotOf(t.dep), depN = c0.n + (ds < nowS ? 1 : 0), arrN = depN + (t.arrD == null ? 1 : t.arrD);
    var m = sheetBox(t.name), bd = m.querySelector('.sheet-bd');
    bd.innerHTML = '<div class="form tripform"><label>Work hours needed<input id="tp-h" type="text" inputmode="decimal" autocomplete="off" value="' + esc(String(t.hours)) + '"></label><span></span>'
      + '<label>Leave on<input id="tp-dd" type="date" value="' + WD.keyOf(depN) + '" min="' + WD.keyOf(c0.n) + '" max="' + WD.keyOf(c0.n + DAYS) + '"></label><label>Leave at<input id="tp-dt" type="time" step="900" value="' + esc(t.dep) + '"></label>'
      + '<label>Arrive by (optional)<input id="tp-ad" type="date" value="' + (t.arr ? WD.keyOf(arrN) : '') + '"></label><label>Arrive by time<input id="tp-at" type="time" step="900" value="' + esc(t.arr || '') + '"></label></div>'
      + '<p class="hint">Work hours means driving plus loading, fuel and checks. Leave the arrive-by boxes empty to see the earliest legal arrival.</p><div id="tp-out" class="stack" style="gap:12px"></div>';
    var out = bd.querySelector('#tp-out'), last = null, g = function (id) { return bd.querySelector(id); };
    function run() {
      var h = parseFloat(String(g('#tp-h').value).replace(',', '.')), dd = g('#tp-dd').value, dt = slotOf(g('#tp-dt').value), ad = g('#tp-ad').value, at = slotOf(g('#tp-at').value);
      if (!(h > 0) || h > 100) { out.innerHTML = '<p class="note warn">Enter the work hours for this trip, from 0.25 to 100.</p>'; return; }
      if (!dd || dt == null) { out.innerHTML = '<p class="note warn">Choose the day and time you leave.</p>'; return; }
      if (at != null && !ad) { ad = WD.keyOf(WD.dayNum(dd) + (at <= dt ? 1 : 0)); g('#tp-ad').value = ad; }
      var H = Math.ceil(h * 4 - 1e-9), c = tripCtx(), dep = c.off + (WD.dayNum(dd) - c.n) * D + dt, arr = ad && at != null ? c.off + (WD.dayNum(ad) - c.n) * D + at : null;
      t.hours = Math.round(h * 100) / 100; t.dep = g('#tp-dt').value; t.arr = arr != null ? g('#tp-at').value : ''; t.arrD = arr != null ? WD.dayNum(ad) - WD.dayNum(dd) : null; WD.touch();
      if (arr != null && arr <= dep) { out.innerHTML = '<p class="note warn">The arrive-by time is before the leave time. Check the dates.</p>'; return; }
      out.innerHTML = '<p class="hint">Working it out…</p>';
      setTimeout(function () {
        var pl; try { pl = tripPlan(H, dep, arr); } catch (e) { out.innerHTML = '<p class="note warn">The trip could not be worked out.</p>'; return; }
        if (pl.fail) { out.innerHTML = '<p class="note warn">This trip does not fit in the next 9 days from that leave time.</p>'; last = null; return; }
        last = pl; var b = pl.best, cc = pl.c, ok = arr == null || b.end <= arr;
        var head = arr == null ? 'Earliest legal arrival: ' + tm(cc, b.end) : ok ? 'On time. Arrive ' + tm(cc, b.end) + ', ' + (pl.slack ? hm(pl.slack) + ' before' : 'right on') + ' your arrive-by time.' : 'Not on time. Earliest legal arrival is ' + tm(cc, b.end) + ', ' + hm(pl.late) + ' late.';
        var h2 = '<div class="tripres ' + (ok ? 'ok' : 'bad') + '"><b>' + esc(head) + '</b>' + (pl.clamped ? '<small>The leave time has passed, so this is planned from now.</small>' : '') + '</div>';
        h2 += '<div class="tripstats"><div><small>Work</small><b>' + hm(pl.H) + '</b></div><div><small>Leave to arrive</small><b>' + hm(b.end - pl.dep) + '</b></div><div><small>Long/night used</small><b>' + hm(b.ln) + '</b></div>' + (b.lnLeft != null ? '<div><small>Long/night left after</small><b>' + hm(b.lnLeft) + '</b></div>' : '') + '</div>';
        h2 += '<div><h3>The plan' + (pl.even ? ' · even shifts' : '') + '</h3><ol class="tripsteps">' + b.legs.map(function (l) {
          var span = '<span class="when">' + esc(tm(cc, l.s)) + ' to ' + esc(tm(cc, l.e, l.s)) + '</span>';
          if (l.rest) return '<li class="r">' + span + '<b>Rest ' + hm(l.len) + '</b><small>' + (l.len >= D ? '24-hour rest' : l.len > cc.major ? 'Sleep break. The rules do not let you start sooner' : 'Your ' + hm(cc.major) + ' sleep break') + (l.why ? ' · ' + esc(l.why) : '') + '</small></li>';
          return '<li class="w">' + span + '<b>Work ' + hm(l.work) + '</b>' + (l.breaks.length ? '<small>Short breaks: ' + l.breaks.map(function (x) { return esc(WD.clock(((x.at - cc.off) % D + D) % D)) + ' for ' + mins(x.len); }).join(', ') + '</small>' : '<small>No short break needed</small>') + '</li>';
        }).join('') + '<li class="e"><span class="when">' + esc(tm(cc, b.end)) + '</span><b>Arrive</b></li></ol></div>';
        if (pl.other) h2 += '<p class="hint">Other way, ' + esc(pl.other.name.toLowerCase()) + ': arrive ' + esc(tm(cc, pl.other.s.end)) + ', long/night used ' + hm(pl.other.s.ln) + '.</p>';
        if (pl.tips.length) h2 += '<div><h3>Smart tips</h3><ul class="triptips">' + pl.tips.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></div>';
        h2 += '<div class="tools"><button class="btn pri" id="tp-add">Add to my diary as a plan</button>' + (navigator.share ? '<button class="btn" id="tp-share">Send plan</button>' : '') + '<button class="btn" id="tp-copy">Copy plan</button></div><p class="note warn">Legal limits only. It assumes your diary is up to date and you do no other work before leaving. Delays use up hours. Never drive tired.</p>';
        out.innerHTML = h2;
        out.querySelector('#tp-add').addEventListener('click', function () { var tpl = Array.prototype.slice.call(b.W.subarray(pl.dep, b.end)); WD.addPlan(cc.n, pl.dep - cc.off, tpl); m.remove(); WD.toast(t.name + ' added to your diary as a plan. Undo is on the Diary screen.', 7000); render(); });
        var txt = tripLines(pl, t.name) + (pl.tips.length ? '\n\n' + pl.tips.join('\n') : '');
        var sh = out.querySelector('#tp-share'); if (sh) sh.addEventListener('click', function () { navigator.share({ title: t.name, text: txt }).catch(function () {}); });
        out.querySelector('#tp-copy').addEventListener('click', function () { (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject()).then(function () { WD.toast('Copied. Paste it into your message.'); }).catch(function () { WD.toast('Copy is not available here.'); }); });
      }, 20);
    }
    ['#tp-h', '#tp-dd', '#tp-dt', '#tp-ad', '#tp-at'].forEach(function (id) { g(id).addEventListener('change', run); });
    run();
  }
  /* ---------- optional: work out hours from two addresses (needs internet and a free key) ---------- */
  function jget(url, opt) { return fetch(url, opt).then(function (r) { if (!r.ok) { var e = new Error('http'); e.status = r.status; throw e; } return r.json(); }); }
  function geocode(q) { return jget('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=au&addressdetails=1&q=' + encodeURIComponent(q)).then(function (a) { if (!a.length) { var e = new Error('nf'); e.q = q; throw e; } var ad = a[0].address || {}; return { lat: +a[0].lat, lon: +a[0].lon, name: ad.suburb || ad.town || ad.city || ad.village || ad.municipality || q.split(',')[0] }; }); }
  function truckRoute(a, b, truck, noToll, key) {
    var v = TRUCKS[truck] || TRUCKS.semi, body = function (dims) { var o = { vehicle_type: 'hgv' }; if (dims) o.profile_params = { restrictions: { height: v[1], weight: v[2], length: v[3] } }; if (noToll) o.avoid_features = ['tollways']; return JSON.stringify({ coordinates: [[a.lon, a.lat], [b.lon, b.lat]], preference: 'recommended', units: 'km', instructions: false, geometry: false, options: o }); };
    var call = function (dims) { return jget('https://api.openrouteservice.org/v2/directions/driving-hgv', { method: 'POST', headers: { 'Authorization': key, 'Content-Type': 'application/json' }, body: body(dims) }).then(function (j) { var s = j.routes && j.routes[0] && j.routes[0].summary; if (!s || !s.duration) throw new Error('empty'); return { km: s.distance, sec: s.duration, dims: dims }; }); };
    return call(true).catch(function (e) { if (e.status === 401 || e.status === 403 || e.status === 429) throw e; return call(false); });
  }
  function routeSheet() {
    var p = P(), m = sheetBox('Hours from addresses'), bd = m.querySelector('.sheet-bd'), r = p.route || (p.route = { truck: 'semi', extra: 1 });
    bd.innerHTML = '<p class="hint">This looks up a truck route and its driving time, then fills in the work hours for you. It needs internet.</p><div class="form" style="grid-template-columns:1fr"><label>From<input id="rt-a" autocomplete="off" placeholder="Street and suburb, or just the suburb" value="' + esc(r.a || '') + '"></label><label>To<input id="rt-b" autocomplete="off" placeholder="Street and suburb, or just the suburb" value="' + esc(r.b || '') + '"></label>'
      + '<label>Truck<select id="rt-t">' + Object.keys(TRUCKS).map(function (k) { return '<option value="' + k + '"' + (r.truck === k ? ' selected' : '') + '>' + TRUCKS[k][0] + ' · ' + TRUCKS[k][1] + ' m high, ' + TRUCKS[k][2] + ' t, ' + TRUCKS[k][3] + ' m long</option>'; }).join('') + '</select></label>'
      + '<label>Extra hours for loading, fuel and checks<input id="rt-x" type="text" inputmode="decimal" autocomplete="off" value="' + esc(String(r.extra == null ? 1 : r.extra)) + '"></label>'
      + '<label class="rtcheck"><input type="checkbox" id="rt-toll"' + (r.noToll ? ' checked' : '') + '> Avoid toll roads (normally highways and toll roads are used)</label>'
      + '<label>Route service key<input id="rt-k" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Paste your openrouteservice key" value="' + esc(p.orsKey || '') + '"></label></div>'
      + '<p class="hint">The key is free. Sign up at openrouteservice.org, open the dashboard and copy the key. You only paste it once.</p><div class="tools"><button class="btn pri" id="rt-go">Find route</button><span class="hint" id="rt-s" role="status"></span></div><div id="rt-out" class="stack" style="gap:12px"></div>';
    var g = function (id) { return bd.querySelector(id); }, stat = g('#rt-s'), out = g('#rt-out');
    g('#rt-go').addEventListener('click', function () {
      var a = g('#rt-a').value.trim(), b = g('#rt-b').value.trim(), key = g('#rt-k').value.trim(), extra = Math.max(0, parseFloat(String(g('#rt-x').value).replace(',', '.')) || 0);
      r.a = a; r.b = b; r.truck = g('#rt-t').value; r.noToll = g('#rt-toll').checked; r.extra = extra; p.orsKey = key; WD.touch(); out.innerHTML = '';
      if (!a || !b) { stat.textContent = 'Enter both places.'; return; }
      if (!key) { stat.textContent = 'Paste the route service key first.'; return; }
      if (!navigator.onLine) { stat.textContent = 'No internet. Type the work hours yourself on the Plan page.'; return; }
      var btn = g('#rt-go'); btn.disabled = true; stat.textContent = 'Finding the places…';
      var A, B; geocode(a).then(function (x) { A = x; return new Promise(function (res) { setTimeout(res, 1100); }); }).then(function () { return geocode(b); }).then(function (x) { B = x; stat.textContent = 'Finding the truck route…'; return truckRoute(A, B, r.truck, r.noToll, key); }).then(function (rt) {
        btn.disabled = false; stat.textContent = '';
        var drive = rt.sec / 3600, total = Math.ceil((drive + extra) * 4) / 4, name = A.name + ' to ' + B.name;
        out.innerHTML = '<div class="tripstats"><div><small>Distance</small><b>' + Math.round(rt.km).toLocaleString('en-AU') + ' km</b></div><div><small>Driving time</small><b>' + hm(Math.round(drive * 4)) + '</b></div><div><small>Work hours with extra</small><b>' + hm(total * 4) + '</b></div></div>'
          + (rt.dims ? '' : '<p class="note warn">The service could not check height, weight and length on a route this long, so this is a general truck route.</p>')
          + '<p class="note warn">This is a time estimate only. It does not check approved B-double or road train roads. Use the NHVR route planner for that. Your real driving time can be longer.</p><div class="tools"><button class="btn pri" id="rt-use">Use ' + hm(total * 4) + ' for ' + esc(name) + '</button></div>';
        out.querySelector('#rt-use').addEventListener('click', function () { p.trips.push({ name: name, hours: total, km: Math.round(rt.km) }); WD.touch(); m.remove(); render(); setTimeout(function () { tripSheet(p.trips.length - 1); }, 60); });
      }).catch(function (e) {
        btn.disabled = false;
        stat.textContent = e && e.message === 'nf' ? 'Could not find "' + e.q + '". Add the suburb and state.' : e && (e.status === 401 || e.status === 403) ? 'The key was not accepted. Check it and try again.' : e && e.status === 429 ? 'The free limit for today is used up. Try again later.' : 'The route could not be found. Check the internet, or type the work hours yourself.';
      });
    });
  }
  /* ---------- quick answer for one day: can I work, how long, how much long/night ---------- */
  function quick(n) {
    var c = tripCtx(), u = usual(c); if (n < c.n || n > c.n + DAYS) return null;
    var day0 = c.off + (n - c.n) * D, i, had = 0, dep = day0 + u.start, fromNow = false; if (dep < c.T) { dep = c.T; fromNow = true; }
    for (i = dep; i < dep + D && i < c.W.length; i++) if (c.W[i]) had++;
    var lnOf = function (W, T) { var m = null; FM.meters(W, c.opt, c.cfg, T).list.forEach(function (x) { if (x.ln) m = x; }); return m ? Math.max(0, m.max - m.used) : null; };
    if (had) { var e = dep + D; return { planned: had, lnLeft: lnOf(c.W, e) }; }
    var W = c.W.slice(); for (i = dep; i < W.length; i++) W[i] = 0;
    var out = { fromNow: fromNow, start: dep, lnBefore: lnOf(W, dep) }, base = keys(W, c), work = 0, restRun = 0, first = -1, last = dep, waitWhy = '', stopWhy = '';
    for (var pos = dep; pos < dep + D; pos++) {
      W[pos] = 1; var f = firstNew(W, base, c);
      if (!f) { if (first < 0) first = pos; work++; restRun = 0; last = pos + 1; }
      else { W[pos] = 0; if (first < 0) { if (!waitWhy) waitWhy = reason(f); } else { restRun++; stopWhy = reason(f); if (restRun >= c.major) break; } }
    }
    out.work = work; out.first = first; out.end = last; out.waitWhy = waitWhy; out.stopWhy = work ? stopWhy : waitWhy; out.wait = first > dep ? first - dep : 0;
    if (work) { var res = FM.analyse(W, c.opt, c.cfg), ln = 0, night = 0; for (i = first; i < last; i++) if (res.ln[i]) { ln++; if ((((i - c.off) % D) + D) % D < 24) night++; } out.ln = ln; out.night = night; out.long = ln - night; out.firstS = (((first - c.off) % D) + D) % D; out.nextDay = Math.floor((first - c.off) / D) > n - c.n; }
    return out;
  }
  window.WDPlan = { quick: quick, render: render, tabs: tabs, _trip: tripPlan, _tripText: tripLines, _compute: compute, _text: function (d) { return reportText(report(compute(), d || 7)); } };
  if (/^#(plan|fortnight)$/.test(location.hash || '')) window.dispatchEvent(new Event('hashchange')); else if (/^#diary/.test(location.hash || '')) WD.render();
})();
