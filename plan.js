/* Plan ahead: usual shift from the last four weeks, what fits in the next two weeks, trip checks,
   and a one-page availability report. Every check runs the same rules engine as the diary. */
(function () {
  'use strict';
  var WD = window.WD, FM = window.FM, D = 96, hm = FM.hm, esc = WD.esc, main = WD.main;
  var DAYS = 14, MAXROW = 6, cache = null;
  function P() { var s = WD.S.settings; if (!s.plan) s.plan = { own: false, start: '20:00', work: 12, days: 7, trips: [{ name: 'Melbourne to Sydney', shifts: 2 }, { name: 'Melbourne to Brisbane', shifts: 4 }] }; return s.plan; }
  function tabs(v) { return '<div class="subnav">' + [['plan', 'Plan ahead'], ['fortnight', 'Last 14 days']].map(function (t) { return '<a href="#' + t[0] + '"' + (t[0] === v ? ' aria-current="page"' : '') + '>' + t[1] + '</a>'; }).join('') + '</div>'; }

  /* ---------- rules helpers ---------- */
  function keys(W, c) { var k = {}; FM.analyse(W, c.opt, c.cfg).findings.forEach(function (f) { if (!f.warn) k[f.rule + ':' + f.kind + ':' + f.at] = f; }); return k; }
  function firstNew(W, base, c) { var k = keys(W, c); for (var x in k) if (!base[x]) return k[x]; return null; }
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
      var fit = tripFit(pl, t.shifts), txt = fit.length ? (fit[0] === 0 ? 'Can start today at ' + WD.clock(u.start) : 'Earliest start ' + WD.fmtDay(n0 + fit[0]) + ' ' + WD.clock(u.start)) : 'Does not fit in the next ' + DAYS + ' days';
      return '<div class="rowcard"><div class="rowhd"><b>' + esc(t.name) + '</b><span class="chip ' + (fit.length ? 'ok' : 'bad') + '">' + t.shifts + ' shift' + (t.shifts > 1 ? 's' : '') + '</span><button class="btn sm danger" data-rmtrip="' + i + '">Remove</button></div><div>' + esc(txt) + (fit.length > 1 ? '<small class="hint" style="display:block">Start days that fit: ' + fit.slice(0, 7).map(function (d) { return WD.fmtDay(n0 + d).split(' ')[0] + ' ' + WD.fmtDay(n0 + d).split(' ')[1]; }).join(', ') + '</small>' : '') + '</div>' + (fit.length ? '<div><button class="btn sm" data-plantrip="' + i + '">Add to my diary as a plan</button></div>' : '') + '</div>';
    }).join('') + '<div class="form" style="grid-template-columns:1fr 90px auto;align-items:end"><label>Trip name<input id="pl-tn" placeholder="Melbourne to Adelaide"></label><label>Shifts<input id="pl-ts" type="text" inputmode="numeric" pattern="[0-9]*" value="2"></label><button class="btn" id="pl-addtrip">Add trip</button></div></div>';
    h += '<p class="note warn">This is a forecast of the legal limits only. It assumes your diary is up to date and that you do no other work. Delays use up hours, so leave a margin. Never drive tired.</p>';
    h += '</div></div></div>';
    main.innerHTML = h;
    var redo = function () { WD.touch(); render(); };
    document.getElementById('pl-useown').addEventListener('change', function (e) { p.own = e.target.checked; redo(); });
    document.getElementById('pl-start').addEventListener('change', function (e) { if (e.target.value) { p.start = e.target.value; p.own = true; redo(); } });
    document.getElementById('pl-work').addEventListener('change', function (e) { p.work = Math.max(1, Math.min(14, +e.target.value || 12)); p.own = true; redo(); });
    main.querySelectorAll('[data-rmtrip]').forEach(function (b) { b.addEventListener('click', function () { p.trips.splice(+b.dataset.rmtrip, 1); redo(); }); });
    main.querySelectorAll('[data-plantrip]').forEach(function (b) { b.addEventListener('click', function () { var t = p.trips[+b.dataset.plantrip], fit = tripFit(pl, t.shifts); if (!fit.length) return; for (var k = 0; k < t.shifts; k++) WD.addPlan(n0 + fit[0] + k, u.start, u.tpl); WD.toast(t.name + ' added to your diary from ' + WD.fmtDay(n0 + fit[0]) + ' as a plan. Undo is on the Diary screen.', 7000); render(); }); });
    document.getElementById('pl-addtrip').addEventListener('click', function () { var n = document.getElementById('pl-tn').value.trim(), s = Math.max(1, Math.min(MAXROW, Math.round(+document.getElementById('pl-ts').value || 1))); if (!n) return WD.toast('Enter a trip name.'); p.trips.push({ name: n, shifts: s }); redo(); });
    document.getElementById('pl-send').addEventListener('click', function () { sendSheet(pl); });
  }

  /* ---------- availability report ---------- */
  function report(pl, days) {
    var c = pl.c, u = pl.u, p = P(), st = WD.S.settings, o = FM.OPTIONS[c.opt];
    var rows = pl.avail.slice(0, days).map(function (a) {
      var d = WD.fmtDay(c.n + a.day);
      return { day: d, n: a.n, text: a.n ? a.n + ' shift' + (a.n > 1 ? 's' : '') + ' in a row from ' + WD.clock(u.start) + (a.n >= MAXROW ? ' or more' : '') : 'Not available' + (a.note ? ' (' + a.note + ')' : a.why ? ' (' + a.why + ')' : ''), work: a.n * u.work };
    });
    var trips = p.trips.map(function (t) { var fit = tripFit(pl, t.shifts).filter(function (d) { return d < days; }); return { name: t.name, shifts: t.shifts, days: fit.map(function (d) { return WD.fmtDay(c.n + d).split(' ').slice(0, 2).join(' '); }) }; });
    return { name: st.name || 'Driver', option: o.name, base: st.base, made: WD.fmtDay(c.n, true) + ' ' + WD.clock(c.T - c.off), from: WD.fmtDay(c.n), to: WD.fmtDay(c.n + days - 1), shift: shiftText(u), rows: rows, trips: trips, limits: limits(c), days: days };
  }
  function reportText(r) {
    var L = ['DRIVER AVAILABILITY', r.name + ' · ' + r.option + ' · ' + r.base + ' time', r.from + ' to ' + r.to + ' (made ' + r.made + ')', 'Usual shift: ' + r.shift, ''];
    r.rows.forEach(function (x) { L.push(x.day + ': ' + x.text); });
    if (r.trips.length) { L.push('', 'TRIPS'); r.trips.forEach(function (t) { L.push(t.name + ' (' + t.shifts + ' shift' + (t.shifts > 1 ? 's' : '') + '): ' + (t.days.length ? 'can start ' + t.days.join(', ') : 'does not fit in this period')); }); }
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
    if (r.trips.length) { h += T(x0, y, 'TRIPS', 9, true, 'start', '#566475'); y += 16; r.trips.slice(0, 6).forEach(function (t) { var ok = t.days.length > 0; h += R(x0, y - 10, 5, 13, ok ? '#17794a' : '#c32222') + T(c1, y, t.name + ' (' + t.shifts + ' shift' + (t.shifts > 1 ? 's' : '') + ')', 11, true) + T(x0 + 250, y, ok ? 'Can start: ' + t.days.slice(0, 5).join(', ') + (t.days.length > 5 ? ' and ' + (t.days.length - 5) + ' more days' : '') : 'Does not fit in this period', 10.5, false, 'start', ok ? '#131e2b' : '#c32222'); y += 18; }); y += 10; }
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
  window.WDPlan = { render: render, tabs: tabs, _compute: compute, _text: function (d) { return reportText(report(compute(), d || 7)); } };
  if (/^#(plan|fortnight)$/.test(location.hash || '')) window.dispatchEvent(new Event('hashchange'));
})();
