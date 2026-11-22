(function () {
  'use strict';
  var FM = window.FM, D = 96, hm = FM.hm;
  var ZONES = { ACT: 'Australia/Sydney', NSW: 'Australia/Sydney', VIC: 'Australia/Melbourne', QLD: 'Australia/Brisbane', SA: 'Australia/Adelaide', TAS: 'Australia/Hobart', NT: 'Australia/Darwin', WA: 'Australia/Perth' };
  var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var BLANK = new Array(D + 1).join('r');
  var KEY = 'workdiary.v1', VERSION = '2.4.2';
  var HOSTED = !!(window.claude && window.claude.use); // true inside Claude, false on your own site

  /* ---------- state ---------- */
  var S = { v: 1, settings: { name: '', plate: '', accr: '', base: 'VIC', opt: 'bfm', clock: 24, theme: 'auto', custom: { dayWork: 14, dayRest: 7, w7: 0, w14: 144, w28: 0 }, t: 0 }, days: {}, live: null };
  var view = 'diary', focus = null, fortStart = null, undo = [], rulesOpt = null;
  try { var raw = localStorage.getItem(KEY); if (raw) { var p = JSON.parse(raw); if (p && p.days) S = merge(S, p); } } catch (e) {}
  function merge(a, b) { b.settings = Object.assign({}, a.settings, b.settings || {}); b.settings.custom = Object.assign({}, a.settings.custom, b.settings.custom || {}); return Object.assign({}, a, b); }

  /* ---------- dates ---------- */
  function dayNum(key) { var p = key.split('-'); return Math.round(Date.UTC(+p[0], +p[1] - 1, +p[2]) / 864e5); }
  function keyOf(n) { var d = new Date(n * 864e5); return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()); }
  function pad(x) { return (x < 10 ? '0' : '') + x; }
  function dow(n) { return new Date(n * 864e5).getUTCDay(); }
  function fmtDay(n, long) { var d = new Date(n * 864e5); return DOW[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + MON[d.getUTCMonth()] + (long ? ' ' + d.getUTCFullYear() : ''); }
  function nowBase() {
    var z = ZONES[S.settings.base] || 'Australia/Melbourne', d = new Date(), o = {};
    try {
      new Intl.DateTimeFormat('en-AU', { timeZone: z, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(d).forEach(function (x) { o[x.type] = +x.value; });
    } catch (e) { o = { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), hour: d.getHours(), minute: d.getMinutes() }; }
    return { n: Math.round(Date.UTC(o.year, o.month - 1, o.day) / 864e5), i: (o.hour % 24) * 4 + Math.floor(o.minute / 15) };
  }
  function clock(i) { // slot within a day -> label
    i = ((i % D) + D) % D; var h = Math.floor(i / 4), m = (i % 4) * 15;
    if (S.settings.clock == 12) { var s = h < 12 ? 'am' : 'pm', hh = h % 12 || 12; return hh + (m ? ':' + pad(m) : '') + s; }
    return pad(h) + ':' + pad(m);
  }
  function hourLab(h) { if (S.settings.clock == 12) return (h % 12 || 12) + (h < 12 ? 'am' : 'pm'); return pad(h) + ':00'; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  /* ---------- records ---------- */
  function getS(n) { var d = S.days[keyOf(n)]; return d && d.s && d.s.length === D ? d.s : BLANK; }
  function day(n) { var k = keyOf(n); if (!S.days[k]) S.days[k] = { s: BLANK, t: 0 }; return S.days[k]; }
  function setRange(n, a, b, ch) { // [a,b) within day n
    var d = day(n), s = d.s || BLANK; d.s = s.slice(0, a) + new Array(b - a + 1).join(ch) + s.slice(b); d.t = Date.now(); dirty(n);
  }
  function setAbsRange(n0, a, b, ch) { // slots relative to day n0, may span days
    for (var x = a; x < b;) { var dn = n0 + Math.floor(x / D), i = ((x % D) + D) % D, e = Math.min(b - x, D - i); setRange(dn, i, i + e, ch); x += e; }
  }
  function optOf(n) {
    var k = keyOf(n), d = S.days[k]; if (d && d.opt) return d.opt;
    var best = null, bk = '';
    for (var kk in S.days) if (S.days[kk].opt && kk < k && kk > bk) { bk = kk; best = S.days[kk].opt; }
    return best || S.settings.opt;
  }
  function snapshot(label) { undo.push({ label: label, days: JSON.stringify(S.days) }); if (undo.length > 25) undo.shift(); }

  /* ---------- storage ---------- */
  var col = null, dirtyMonths = {}, dirtySettings = false, saveTimer = null, syncState = 'device', flushing = false;
  function dirty(n) { dirtyMonths['m-' + keyOf(n).slice(0, 7)] = 1; }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {}
    if (window.WDDrive) window.WDDrive.changed();
    clearTimeout(saveTimer); saveTimer = setTimeout(flush, 1200);
  }
  function monthDoc(id) { var pre = id.slice(2), days = {}; for (var k in S.days) if (k.slice(0, 7) === pre) days[k] = S.days[k]; return { days: days, t: Date.now() }; }
  function flush() {
    if (!col || flushing) return; flushing = true;
    var ids = Object.keys(dirtyMonths), ds = dirtySettings; dirtyMonths = {}; dirtySettings = false;
    var chain = Promise.resolve();
    ids.forEach(function (id) { chain = chain.then(function () { return col.doc(id).set(monthDoc(id)); }); });
    if (ds) chain = chain.then(function () { return col.doc('settings').set({ v: S.settings, live: S.live || null, t: Date.now() }); });
    chain.then(function () { setSync('account'); }, function () { ids.forEach(function (id) { dirtyMonths[id] = 1; }); setSync('device'); })
      .then(function () { flushing = false; if (Object.keys(dirtyMonths).length || dirtySettings) saveTimer = setTimeout(flush, 4000); });
  }
  function setSync(s) { syncState = s; var e = document.getElementById('sync'); if (e) e.textContent = syncText(); }
  function syncText() { if (!HOSTED) return 'Saved on this device, in this browser only. Save a backup file often.'; return syncState === 'account' ? 'Saved to your Claude account and this device.' : syncState === 'loading' ? 'Checking for saved records…' : 'Saved on this device only.'; }
  function initSync() {
    if (!window.claude || !window.claude.use) return;
    setSync('loading');
    var timer = setTimeout(function () { if (syncState === 'loading') setSync('device'); }, 10000);
    Promise.all([window.claude.use('db'), window.claude.use('user')]).then(function (r) {
      if (!r[0] || !r[1]) throw 0;
      return r[1].id().then(function (id) { if (!id) throw 0; col = r[0].collection('data/users/' + id); return col.get(); });
    }).then(function (snap) {
      clearTimeout(timer); var changed = false;
      snap.docs.forEach(function (d) {
        var x = d.data() || {};
        if (d.id === 'settings' && x.v) { if ((x.v.t || 0) > (S.settings.t || 0)) { S.settings = merge({ settings: S.settings }, { settings: x.v }).settings; S.live = x.live || null; changed = true; } }
        else if (d.id.indexOf('m-') === 0 && x.days) for (var k in x.days) { var r = x.days[k], l = S.days[k]; if (!l || (r.t || 0) > (l.t || 0)) { S.days[k] = r; changed = true; } }
      });
      var remote = {}; snap.docs.forEach(function (d) { var x = d.data() || {}; if (x.days) for (var k in x.days) remote[k] = x.days[k].t || 0; });
      for (var k in S.days) if ((S.days[k].t || 0) > (remote[k] || -1) && S.days[k].t) dirty(dayNum(k));
      if (S.settings.t) dirtySettings = true;
      try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {}
      setSync('account'); flush(); if (changed) render();
    }).catch(function () { clearTimeout(timer); col = null; setSync('device'); });
  }

  /* ---------- analysis ---------- */
  var AN = null;
  function timeline(d0, d1) { var W = new Uint8Array((d1 - d0 + 1) * D); for (var n = d0; n <= d1; n++) { var s = getS(n), o = (n - d0) * D; if (s !== BLANK) for (var i = 0; i < D; i++) if (s.charCodeAt(i) === 119) W[o + i] = 1; } return W; }
  function cfgOf(opt) { return opt === 'custom' ? S.settings.custom : null; }
  function segmentW(W, d0, segStart, segEnd, total) { // view of the records for one hours option
    var X = W.slice(), a = (segStart - d0) * D, b = (segEnd - d0 + 1) * D, i;
    for (i = b; i < X.length; i++) X[i] = 0;
    var reset = false;
    if (segStart > d0) { // changing option: full compliance with the new option, or a 48-hour reset rest break
      var fw = a; while (fw < b && !X[fw]) fw++;
      var back = fw; while (back > 0 && !X[back - 1]) back--;
      if (fw - back >= 2 * D || back === 0) { reset = true; for (i = 0; i < back; i++) X[i] = 0; }
    }
    return { W: X, a: a, b: b, reset: reset };
  }
  function analyseAll(f) {
    var d0 = f - 35, d1 = f + 16, W = timeline(d0, d1), N = W.length;
    var flags = new Uint8Array(N), ln = new Uint8Array(N), findings = [], opts = [], n;
    for (n = d0; n <= d1; n++) opts.push(optOf(n));
    var s = 0;
    while (s < opts.length) {
      var e = s; while (e + 1 < opts.length && opts[e + 1] === opts[s]) e++;
      var seg = segmentW(W, d0, d0 + s, d0 + e), res = FM.analyse(seg.W, opts[s], cfgOf(opts[s]));
      for (var i = seg.a; i < seg.b; i++) { flags[i] = res.flags[i]; ln[i] = res.ln[i]; }
      res.findings.forEach(function (fd) { if (fd.at >= seg.a && fd.at < seg.b) { fd.opt = opts[s]; findings.push(fd); } });
      if (s > 0 && opts[s - 1] === 'custom' && !seg.reset) findings.push({ rule: 'reset', label: 'Changing hours option', kind: 'rest', warn: true, at: seg.a, from: seg.a, to: seg.a, slots: [], msg: 'To change from AFM, ACH or exemption hours you must first take a reset rest break of 48 continuous hours.' });
      s = e + 1;
    }
    AN = { d0: d0, d1: d1, W: W, flags: flags, ln: ln, findings: findings, opts: opts };
    return AN;
  }
  function standing(n, T) { // meters for the option in force on day n, at absolute slot T (relative to AN.d0)
    var opt = optOf(n), s = n, e = n;
    while (s - 1 >= AN.d0 && optOf(s - 1) === opt) s--;
    var seg = segmentW(AN.W, AN.d0, s, e);
    return { opt: opt, seg: seg, m: FM.meters(seg.W, opt, cfgOf(opt), T) };
  }
  function absT(abs, ref) { // absolute slot -> text
    var n = AN.d0 + Math.floor(abs / D), i = ((abs % D) + D) % D;
    return (ref != null && n === ref ? '' : DOW[dow(n)] + ' ') + clock(i);
  }

  /* ---------- live tracking ---------- */
  function tickLive() {
    if (!S.live) return false;
    var nw = nowBase(), span = (nw.n - S.live.n) * D + nw.i - S.live.i;
    if (span < 0) return false;
    if (span > 16 * 4) { setAbsRange(S.live.n, S.live.i, S.live.i + 16 * 4, 'w'); S.live = null; touchSettings(); save(); toast('Live work stopped after 16 hours. Check your entries.'); return true; }
    setAbsRange(S.live.n, S.live.i, S.live.i + span + 1, 'w'); save(); return true;
  }
  function touchSettings() { S.settings.t = Date.now(); dirtySettings = true; }

  /* ---------- rendering ---------- */
  var main = document.getElementById('main');
  window.WD = { get S() { return S; }, esc: esc, main: main, toast: function (m, t) { toast(m, t); }, nowBase: nowBase, keyOf: keyOf, dayNum: dayNum, clock: clock, ZONES: ZONES, optOf: optOf, render: function () { if (!document.querySelector('.modal')) render(); }, fmtDay: fmtDay, absT: function (abs, ref) { return absT(abs, ref); }, addPlan: function (n, start, tpl) { snapshot(); for (var i = 0; i < tpl.length; i++) if (tpl[i]) setAbsRange(n, start + i, start + i + 1, 'w'); save(); }, touch: function () { touchSettings(); save(); },
    // For the planner: records for the hours option in force today, history plus any planned days ahead
    planCtx: function () {
      var nw = nowBase(), A = analyseAll(nw.n), opt = optOf(nw.n), s = nw.n; while (s - 1 >= A.d0 && optOf(s - 1) === opt) s--;
      var seg = segmentW(A.W, A.d0, s, A.d1), off = (nw.n - A.d0) * D, working = getS(nw.n)[nw.i] === 'w', T = off + nw.i + (working ? 1 : 0);
      return { W: seg.W, d0: A.d0, n: nw.n, off: off, T: T, working: working, opt: opt, cfg: cfgOf(opt), st: standing(nw.n, T) };
    },
    // Drive sync: take newer diary days and newer settings from another device
    applyRemote: function (days, settings) {
      var ch = false, k;
      for (k in (days || {})) if (/^\d{4}-\d\d-\d\d$/.test(k) && days[k] && typeof days[k].s === 'string' && days[k].s.length === D && (!S.days[k] || (days[k].t || 0) > (S.days[k].t || 0))) { S.days[k] = days[k]; ch = true; }
      if (settings && (settings.t || 0) > (S.settings.t || 0)) { S.settings = merge({ settings: S.settings }, { settings: settings }).settings; applyTheme(); ch = true; }
      if (ch) { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {} }
      return ch;
    } };
  function render() {
    var nw = nowBase(); if (focus == null) focus = nw.n;
    var office = window.WDOffice && window.WDOffice.views.indexOf(view) >= 0, navView = office ? 'invoices' : (view === 'rules' && !document.querySelector('nav a[href="#rules"]') ? 'more' : view === 'fortnight' && window.WDPlan ? 'plan' : view);
    document.querySelectorAll('nav a').forEach(function (a) { a.setAttribute('aria-current', a.getAttribute('href') === '#' + navView ? 'page' : 'false'); });
    if (window.WDOffice) { if (office) { var o0 = FM.OPTIONS[optOf(nw.n)]; document.getElementById('topopt').innerHTML = '<b>' + esc(o0.name) + '</b>Base ' + esc(S.settings.base); return window.WDOffice.render(view); } window.WDOffice.leave(); }
    var o = FM.OPTIONS[optOf(nw.n)]; document.getElementById('topopt').innerHTML = '<b>' + esc(o.name) + '</b>Base ' + esc(S.settings.base);
    if (view === 'plan' && window.WDPlan) return window.WDPlan.render();
    if (view === 'diary') renderDiary(); else if (view === 'now') renderNow(); else if (view === 'fortnight') renderFort(); else if (view === 'rules') renderRules(); else renderMore();
  }

  function optSelect(id, val) { return '<select id="' + id + '" aria-label="Hours option">' + Object.keys(FM.OPTIONS).map(function (k) { return '<option value="' + k + '"' + (k === val ? ' selected' : '') + '>' + esc(FM.OPTIONS[k].name) + '</option>'; }).join('') + '</select>'; }

  function meterHTML(m, ref) {
    var h = '';
    if (m.max != null) {
      var left = m.max - m.used, pc = Math.min(100, Math.round(100 * m.used / m.max)), cls = left < 0 ? 'bad' : (left <= (m.P && m.P <= D ? 4 : 16) ? 'warn' : '');
      h += '<div class="hd"><b>' + esc(m.label) + '</b><span>' + hm(m.used) + ' of ' + hm(m.max) + '</span></div><div class="bar ' + cls + '"><i style="width:' + pc + '%"></i></div>';
      h += '<small class="' + cls + '">' + (left >= 0 ? hm(left) + ' left' : hm(-left) + ' over the limit') + (m.from != null && m.to != null ? ' · period ' + absT(m.from, ref) + ' to ' + absT(m.to, ref) : m.id === 'r84' ? ' · counted from ' + absT(m.from, ref) : ' · no period running') + '</small>';
    } else h += '<div class="hd"><b>' + esc(m.label) + '</b></div>';
    if (m.restLen) h += m.restDue != null ? '<small class="warn">' + hm(m.restLen) + ' continuous rest must start by ' + absT(m.restDue, ref) + '</small>' : (m.from != null ? '<small class="ok">' + hm(m.restLen) + ' continuous rest taken in this period</small>' : '');
    if (m.rest) h += '<small class="' + (m.rest.got >= m.rest.need ? 'ok' : '') + '">' + m.rest.got + ' of ' + m.rest.need + ' ' + m.rest.unit + (m.restTo != null && m.rest.got < m.rest.need ? ' · needed before ' + absT(m.restTo, ref) : '') + '</small>';
    if (m.nights) h += '<small class="' + (m.nights.got >= m.nights.need && m.nights.pair !== false ? 'ok' : '') + '">' + m.nights.got + ' of ' + m.nights.need + ' night rest breaks' + (m.nights.pair == null ? '' : m.nights.pair ? ' · 2 on consecutive days: yes' : ' · 2 on consecutive days: not yet') + (m.restTo != null && (m.nights.got < m.nights.need || m.nights.pair === false) ? ' · needed before ' + absT(m.restTo, ref) : '') + '</small>';
    return '<div class="meter">' + h + '</div>';
  }
  function metersHTML(st, ref) {
    var L = st.m.list, br = L.filter(function (x) { return x.group === 'break'; }), rest = L.filter(function (x) { return x.group !== 'break'; }), h = '';
    if (br.length) {
      var worst = br[0]; br.forEach(function (x) { if (x.max - x.used < worst.max - worst.used) worst = x; });
      h += meterHTML({ id: 'brk', label: 'Short rest breaks', max: worst.max, used: worst.used, from: worst.from, to: worst.to, P: worst.P }, ref);
    }
    return h + rest.map(function (m) { return meterHTML(m, ref); }).join('');
  }
  function issueHTML(f) {
    return '<div class="issue' + (f.warn ? ' warn' : '') + '"><b>' + esc(f.label) + '</b>' + esc(f.msg) + '<small>' + (f.to > f.from ? 'Period ' + absT(f.from) + ' to ' + absT(f.to) + ' · ' : '') + (f.kind === 'work' ? 'over from ' : 'by ') + absT(f.at) + '</small></div>';
  }

  // Smart tips before work is recorded on today or a future day. go(start) records work from that slot.
  function coachGate(n, a, b, go) {
    var adv = S.settings.tips !== false && window.WDCoach && n >= nowBase().n ? window.WDCoach.check(n, a) : null;
    if (!adv) return go(a);
    if (adv.kind === 'tip') { go(a); toast(adv.text, 9000); return; }
    window.WDCoach.ask(adv, clock(a), function (choice) {
      if (choice === 'go') go(a);
      else if (choice === 'wait') { if (adv.rel != null && adv.rel < b) { go(adv.rel); toast('Work now starts at ' + clock(adv.rel) + '.'); } else toast('Rest kept. Add your work from ' + adv.untilText + '.', 7000); }
    });
  }
  /* ---------- diary ---------- */
  function renderDiary() {
    var nw = nowBase(), n = focus, A = analyseAll(n), off = (n - A.d0) * D, s = getS(n), opt = optOf(n), isToday = n === nw.n;
    var w = 0, lnc = 0, i; for (i = 0; i < D; i++) { if (s[i] === 'w') w++; if (A.ln[off + i]) lnc++; }
    var dayF = A.findings.filter(function (f) { return (f.at >= off && f.at < off + D) || (f.slots || []).some(function (x) { return x >= off && x < off + D; }); });
    var bad = dayF.filter(function (f) { return !f.warn; }).length;
    var T = isToday ? off + nw.i + (s[nw.i] === 'w' ? 1 : 0) : off + D, st = standing(n, T);
    var d = S.days[keyOf(n)] || {};
    var cells = '';
    for (var h = 0; h < 24; h++) {
      cells += '<div class="hr"><div class="t"><span>' + hourLab(h) + '</span></div><div class="bs">';
      for (var q = 0; q < 4; q++) { i = h * 4 + q; cells += '<button type="button" class="b" data-i="' + i + '" tabindex="' + (i === 0 ? 0 : -1) + '" aria-label="' + clock(i) + '"></button>'; }
      cells += '</div></div>';
    }
    var html = '<div class="wrap"><div class="daybar" id="daybar"><div class="day">' + fmtDay(n, true) + (n > nw.n ? ' <span class="chip">Plan</span>' : isToday ? ' <span class="chip ok">Today</span>' : '') + (bad ? ' <span class="chip bad">' + bad + ' issue' + (bad > 1 ? 's' : '') + '</span>' : w ? ' <span class="chip ok">Within limits</span>' : ' <span class="chip">No work</span>') + (function () { var pg = pageOf(n); return pg ? ' <span class="chip" id="pgchip">' + (pg.no ? 'Book ' + esc(pg.no) + ' · ' : '') + 'Page ' + pg.page + '</span>' : ''; })() + '</div>'
      + '<div class="daynav"><button class="btn" id="prev" aria-label="Previous day">‹</button><button class="btn" id="today">Today</button><input type="date" id="pick" aria-label="Go to date" value="' + keyOf(n) + '"><button class="btn" id="next" aria-label="Next day">›</button></div>' + (n >= nw.n && window.WDPlan && window.WDPlan.quick ? '<div class="canwork" id="canwork" role="status"><b>Checking…</b></div>' : '') + '</div>'
      + '<div class="cols"><div class="stack">'
      + '<div class="card stack sheetcard" style="gap:12px"><div class="dtools' + (window.WDOffice ? '' : ' five') + '">' + optSelect('dayopt', opt) + '<button class="btn" id="addshift">Add shift</button>' + (window.WDOffice ? '<button class="btn" id="bookview">Book view</button><button class="btn" id="sendpages">Send pages</button>' : '') + '<button class="btn" id="copyprev">Copy yesterday</button><button class="btn" id="undo"' + (undo.length ? '' : ' disabled') + '>Undo</button><button class="btn danger" id="clear"' + (w ? '' : ' disabled') + '>Clear day</button></div>'
      + '<div class="readout" id="readout"></div>'
      + '<div class="sheet" id="sheet" role="group" aria-label="15 minute blocks for ' + fmtDay(n) + '">' + cells + '</div>'
      + '<div class="legend"><span><i class="w"></i>Work</span><span><i></i>Rest</span><span><i class="n"></i>Night rest hours (10pm to 8am)</span>' + (opt === 'bfm' ? '<span><i class="l"></i>Long/night work</span>' : '') + '<span><i class="x"></i>Over a limit</span></div>'
      + '<p class="hint">Each row is 6 hours and each block is 15 minutes. Drag across the blocks to add work. Start the drag on a work block to remove it. On a phone, swipe sideways or press and hold to start, then move anywhere.</p></div>'
      + '<div class="card line"><h3>Daily sheet line</h3>' + sheetLine(s) + '</div>'
      + changesHTML(n, s, d)
      + '</div><div class="stack">'
      + '<div class="card"><h3>Checks for this day</h3><div class="issues">' + (function () { var dc = dstChange(n); return dc ? '<div class="issue warn"><b>Daylight saving</b>Clocks go ' + (dc > 0 ? 'forward' : 'back') + ' ' + hm(Math.abs(dc) / 15) + ' on this day in ' + esc(S.settings.base) + '. Keep recording in your base time and write the change in Comments. The app counts this day as 24 hours, so check your totals by hand.</div>' : ''; })() + dayNotes(n).map(function (x) { return '<div class="issue warn"><b>Finish your record</b>' + esc(x) + '</div>'; }).join('') + (dayF.length ? dayF.map(issueHTML).join('') : '<div class="clean">✓ ' + (w ? 'No limit is broken by this day\'s entries.' : 'No work recorded. Counted as rest.') + '</div>') + '</div></div>'
      + '<div class="card"><h3>' + (isToday ? 'Where you stand now' : 'Standing at the end of this day') + '</h3><div class="meters">' + metersHTML(st, n) + '</div></div>'
      + '<div class="card form" style="grid-template-columns:1fr"><h3>Day details</h3><label>Number plate<input id="plate" value="' + esc(d.plate != null ? d.plate : S.settings.plate) + '" autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false"></label><label>Time of daily check (if your employer needs it)<input type="time" id="d-chk" value="' + esc(d.chk || '') + '"></label>' + (opt === 'std2' || opt === 'bfm2' ? '<label>Two-up driver name<input id="d-co" value="' + esc(d.co || '') + '" autocomplete="off"></label><label>Two-up driver licence number<input id="d-colic" inputmode="numeric" value="' + esc(d.colic || '') + '" autocomplete="off"></label>' : '') + '<label class="chk" style="flex-direction:row"><input type="checkbox" id="d-fit"' + (d.fit ? ' checked' : '') + '> Fit for duty</label><label>Comments (delays, officer notes)<textarea id="note">' + esc(d.note || '') + '</textarea></label></div>'
      + '</div></div></div>';
    main.innerHTML = html;
    var db = document.getElementById('daybar'); if (db) main.style.setProperty('--dbh', db.offsetHeight + 'px');
    var cw = document.getElementById('canwork');
    if (cw) setTimeout(function () {
      if (!cw.isConnected) return; var q = null; try { q = window.WDPlan.quick(n); } catch (e) {}
      if (!q) { cw.remove(); } else {
        var cls = 'ok', top, sub;
        if (q.planned) { cls = 'info'; top = hm(q.planned) + ' work is already in the diary for this shift'; sub = q.lnLeft != null ? 'Long/night left after it: ' + hm(q.lnLeft) : ''; }
        else if (!q.work) { cls = 'bad'; top = 'You cannot work this day'; sub = q.stopWhy ? 'Reason: ' + q.stopWhy : ''; }
        else {
          if (q.work < 32) cls = 'warn';
          top = 'You can work ' + hm(q.work) + (q.fromNow ? ' from now' : ' from ' + clock(q.firstS) + (q.nextDay ? ' (after midnight)' : ''));
          sub = (q.ln ? 'Uses ' + [q.night ? hm(q.night) + ' night' : '', q.long ? hm(q.long) + ' long' : ''].filter(Boolean).join(' + ') : 'No long/night hours used') + (q.lnBefore != null ? ' · ' + hm(q.lnBefore) + ' long/night left before' : '') + (q.wait && q.waitWhy ? ' · starts late: ' + q.waitWhy : '') + (q.work < 56 && q.stopWhy ? ' · limit: ' + q.stopWhy : '');
        }
        cw.className = 'canwork ' + cls; cw.innerHTML = '<b>' + esc(top) + '</b>' + (sub ? '<small>' + esc(sub) + '</small>' : '');
      }
      if (db) main.style.setProperty('--dbh', db.offsetHeight + 'px');
    }, 30);
    paintCells(n, A, isToday ? nw.i : -1);
    setReadout(null, w, lnc, opt);
    bindDiary(n, w, lnc, opt);
  }
  function paintCells(n, A, nowI) {
    var off = (n - A.d0) * D, s = getS(n);
    main.querySelectorAll('.b').forEach(function (b) {
      var i = +b.dataset.i, c = 'b';
      if (s[i] === 'w') { c += ' w'; if (A.flags[off + i] === 2) c += ' x'; else if (A.flags[off + i] === 1) c += ' q'; else if (A.ln[off + i] && optOf(n) === 'bfm') c += ' ln'; }
      else if (i < 32 || i >= 88) c += ' n';
      if (i === nowI) c += ' now';
      b.className = c; b.setAttribute('aria-pressed', s[i] === 'w');
    });
  }
  function setReadout(sel, w, lnc, opt) {
    var r = document.getElementById('readout'); if (!r) return;
    if (sel) { r.className = 'readout ' + (sel.add ? 'act' : 'del'); r.innerHTML = '<span><span class="lab">' + (sel.add ? 'Add work' : 'Remove work') + '</span><b>' + clock(sel.a) + ' to ' + (sel.b === D ? clock(0) : clock(sel.b)) + '</b></span><span><b>' + hm(sel.b - sel.a) + '</b></span>'; }
    else { r.className = 'readout'; r.innerHTML = '<span><span class="lab">Work</span><b>' + hm(w) + '</b></span><span><span class="lab">Rest</span><b>' + hm(D - w) + '</b></span>' + (opt === 'bfm' ? '<span><span class="lab">Long/night</span><b>' + hm(lnc) + '</b></span>' : ''); }
  }
  function sheetLine(s) {
    var X0 = 86, CW = 9, yW = 26, yR = 62, x, i, p = '', cur = null, night = '';
    night += '<rect x="' + X0 + '" y="8" width="' + 32 * CW + '" height="72" fill="var(--night)" opacity=".7"/><rect x="' + (X0 + 88 * CW) + '" y="8" width="' + 8 * CW + '" height="72" fill="var(--night)" opacity=".7"/>';
    var ticks = '';
    for (i = 0; i <= 24; i++) { x = X0 + i * 4 * CW; ticks += '<line x1="' + x + '" y1="8" x2="' + x + '" y2="80" stroke="var(--line)" stroke-width="1"/><text x="' + x + '" y="94" text-anchor="middle" font-size="11" fill="var(--muted)">' + (i === 0 || i === 24 ? 'mid' : i === 12 ? 'noon' : (S.settings.clock == 12 ? (i % 12) : i)) + '</text>'; }
    for (i = 0; i < D; i++) { var y = s[i] === 'w' ? yW : yR; x = X0 + i * CW; if (cur === null) p += 'M' + x + ' ' + y; else if (y !== cur) p += 'V' + y; p += 'H' + (x + CW); cur = y; }
    return '<svg viewBox="0 0 960 100" role="img" aria-label="Work and rest line for the day" style="min-width:560px"><g font-family="Barlow, Arial, sans-serif">' + night + ticks
      + '<text x="4" y="' + (yW + 4) + '" font-size="12" font-weight="600" fill="var(--ink)">MY WORK</text><text x="4" y="' + (yR + 4) + '" font-size="12" font-weight="600" fill="var(--ink)">MY REST</text>'
      + '<line x1="' + X0 + '" y1="' + yW + '" x2="' + (X0 + 96 * CW) + '" y2="' + yW + '" stroke="var(--line)" stroke-dasharray="2 4"/><line x1="' + X0 + '" y1="' + yR + '" x2="' + (X0 + 96 * CW) + '" y2="' + yR + '" stroke="var(--line)" stroke-dasharray="2 4"/>'
      + '<path d="' + p + '" fill="none" stroke="var(--work)" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/></g></svg>';
  }
  function changesHTML(n, s, d) {
    var prev = getS(n - 1)[D - 1], rows = '', ev = d.ev || {};
    for (var i = 0; i < D; i++) { var before = i === 0 ? prev : s[i - 1]; if (s[i] !== before) { var e = ev[i] || {}; rows += '<tr><td class="num">' + clock(i) + '</td><td>' + (s[i] === 'w' ? 'Start work' : 'Start rest') + '</td><td><button type="button" class="place' + (e.p ? '' : ' empty') + '" data-place="' + i + '" aria-label="Place at ' + clock(i) + '">' + (e.p ? esc(e.p) + (e.k ? '<small>' + esc(KINDS[e.k] || '') + '</small>' : '') : 'Choose place') + '</button></td><td><input data-ev="' + i + '" data-f="o" inputmode="numeric" pattern="[0-9]*" value="' + esc(e.o || '') + '" placeholder="Odometer" aria-label="Odometer at ' + clock(i) + '"></td></tr>'; } }
    return '<div class="card"><h3>Work and rest changes</h3>' + (rows ? '<div class="tw"><table><thead><tr><th class="num">Time</th><th>Change</th><th>Place</th><th>Odometer</th></tr></thead><tbody>' + rows + '</tbody></table></div>' : '<p class="hint">No changes on this day.</p>') + '</div>';
  }

  function bindDiary(n, w, lnc, opt) {
    var sheet = document.getElementById('sheet'), s0 = getS(n);
    var sel = null, pend = null, holdT = null, lastPaint = [-1, -1];
    function idxAt(x, y) { var e = document.elementFromPoint(x, y); e = e && e.closest ? e.closest('.b') : null; return e && sheet.contains(e) ? +e.dataset.i : -1; }
    function nearest(x, y) { // pointer in a gap: use the closest block
      var best = -1, bd = 1e9; sheet.querySelectorAll('.b').forEach(function (b) { var r = b.getBoundingClientRect(), dx = Math.max(r.left - x, 0, x - r.right), dy = Math.max(r.top - y, 0, y - r.bottom), dd = dx * dx + dy * dy * 4; if (dd < bd) { bd = dd; best = +b.dataset.i; } }); return best;
    }
    function preview() {
      var a = Math.min(sel.start, sel.end), b = Math.max(sel.start, sel.end) + 1, bs = sheet.querySelectorAll('.b'), cls = sel.add ? 'pa' : 'pd';
      var lo = lastPaint[0] < 0 ? a : Math.min(a, lastPaint[0]), hi = lastPaint[1] < 0 ? b : Math.max(b, lastPaint[1]);
      for (var i = lo; i < hi; i++) bs[i].classList.toggle(cls, i >= a && i < b);
      lastPaint = [a, b]; setReadout({ a: a, b: b, add: sel.add }, w, lnc, opt);
    }
    function begin(i, pid) { sel = { start: i, end: i, add: s0[i] !== 'w', pid: pid, moved: false }; lastPaint = [-1, -1]; try { sheet.setPointerCapture(pid); } catch (e) {} preview(); }
    function commit() {
      var a = Math.min(sel.start, sel.end), b = Math.max(sel.start, sel.end) + 1, add = sel.add; sel = null;
      if (add) { renderDiary(); return coachGate(n, a, b, function (st) { snapshot(); setRange(n, st, b, 'w'); save(); renderDiary(); }); }
      snapshot(); setRange(n, a, b, 'r'); save(); renderDiary();
    }
    function cancel() { clearTimeout(holdT); pend = null; if (sel) { sel = null; renderDiary(); } }
    sheet.addEventListener('pointerdown', function (e) {
      var i = idxAt(e.clientX, e.clientY); if (i < 0 || (e.button && e.button !== 0)) return;
      if (e.pointerType === 'touch') {
        pend = { i: i, x: e.clientX, y: e.clientY, pid: e.pointerId };
        holdT = setTimeout(function () { if (pend) { var p = pend; pend = null; begin(p.i, p.pid); sel.moved = true; try { navigator.vibrate && navigator.vibrate(12); } catch (err) {} } }, 280);
      } else { e.preventDefault(); begin(i, e.pointerId); }
    });
    sheet.addEventListener('pointermove', function (e) {
      if (pend && e.pointerId === pend.pid) {
        var dx = Math.abs(e.clientX - pend.x), dy = Math.abs(e.clientY - pend.y);
        if (dx > 7 && dx > dy) { clearTimeout(holdT); var p = pend; pend = null; begin(p.i, p.pid); }
        else if (dy > 10) { clearTimeout(holdT); pend = null; }
      }
      if (!sel || e.pointerId !== sel.pid) return;
      var i = idxAt(e.clientX, e.clientY); if (i < 0) i = nearest(e.clientX, e.clientY);
      if (i >= 0 && i !== sel.end) { sel.end = i; sel.moved = true; preview(); }
    });
    sheet.addEventListener('pointerup', function (e) {
      clearTimeout(holdT);
      if (pend && e.pointerId === pend.pid) { var p = pend; pend = null; begin(p.i, p.pid); commit(); return; } // tap
      if (sel && e.pointerId === sel.pid) commit();
    });
    sheet.addEventListener('pointercancel', cancel);
    sheet.addEventListener('touchmove', function (e) { if (sel && e.cancelable) e.preventDefault(); }, { passive: false });
    sheet.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    sheet.addEventListener('keydown', function (e) {
      var b = e.target.closest('.b'); if (!b) return; var i = +b.dataset.i, cols = 24, j = i;
      if (e.key === 'ArrowRight') j = i + 1; else if (e.key === 'ArrowLeft') j = i - 1; else if (e.key === 'ArrowDown') j = i + cols; else if (e.key === 'ArrowUp') j = i - cols;
      else if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); snapshot(); setRange(n, i, i + 1, s0[i] === 'w' ? 'r' : 'w'); save(); renderDiary(); var nb = main.querySelector('.b[data-i="' + i + '"]'); if (nb) nb.focus(); return; }
      else return;
      e.preventDefault(); if (j >= 0 && j < D) { var t = sheet.querySelector('.b[data-i="' + j + '"]'); b.tabIndex = -1; t.tabIndex = 0; t.focus(); }
    });
    on('prev', function () { focus--; renderDiary(); }); on('next', function () { focus++; renderDiary(); });
    on('today', function () { focus = nowBase().n; renderDiary(); });
    document.getElementById('pick').addEventListener('change', function (e) { if (e.target.value) { focus = dayNum(e.target.value); renderDiary(); } });
    document.getElementById('dayopt').addEventListener('change', function (e) { snapshot(); day(n).opt = e.target.value; day(n).t = Date.now(); dirty(n); save(); render(); toast(FM.OPTIONS[e.target.value].name + ' applies from ' + fmtDay(n) + ' onward.'); });
    on('undo', function () { var u = undo.pop(); if (!u) return; S.days = JSON.parse(u.days); for (var k in S.days) dirty(dayNum(k)); save(); renderDiary(); });
    on('clear', function () { snapshot(); setRange(n, 0, D, 'r'); save(); renderDiary(); });
    on('copyprev', function () { snapshot(); var d = day(n); d.s = getS(n - 1); d.t = Date.now(); dirty(n); save(); renderDiary(); });
    on('addshift', function () { shiftDialog(n); });
    on('sendpages', function () { pagesDialog(n); });
    on('bookview', function () { window.WDOffice.core().then(function (APS) { return window.WDOffice.preview('Diary-' + keyOf(n), [pageSvg(APS, n)]); }).catch(function (e) { toast((e && e.message) || 'The page could not be made.'); }); });
    [['chk', 'value'], ['co', 'value'], ['colic', 'value'], ['fit', 'checked']].forEach(function (x) { var el = document.getElementById('d-' + x[0]); if (el) el.addEventListener('change', function () { day(n)[x[0]] = x[1] === 'checked' ? el.checked : el.value.trim(); day(n).t = Date.now(); dirty(n); save(); }); });
    document.getElementById('plate').addEventListener('change', function (e) { day(n).plate = e.target.value.trim().toUpperCase(); day(n).t = Date.now(); dirty(n); save(); });
    document.getElementById('note').addEventListener('change', function (e) { day(n).note = e.target.value; day(n).t = Date.now(); dirty(n); save(); });
    main.querySelectorAll('button[data-place]').forEach(function (b) { b.addEventListener('click', function () { placeDialog(n, +b.dataset.place); }); });
    main.querySelectorAll('input[data-ev]').forEach(function (inp) { inp.addEventListener('change', function () { var d = day(n); d.ev = d.ev || {}; d.ev[inp.dataset.ev] = d.ev[inp.dataset.ev] || {}; d.ev[inp.dataset.ev][inp.dataset.f] = inp.value.trim(); d.t = Date.now(); dirty(n); save(); }); });
  }
  function on(id, fn) { var e = document.getElementById(id); if (e) e.addEventListener('click', fn); }

  /* ---------- place picker ---------- */
  // The work diary asks for the name of the place at each work and rest change, for example a rest area, truck stop, suburb or town.
  var KINDS = { rest: 'Rest area', stop: 'Truck stop', fuel: 'Fuel station', town: 'Suburb or town', depot: 'Depot or customer' };
  var TOWNS = {
    VIC: 'Melbourne,Altona,Laverton,Derrimut,Truganina,Tottenham,Brooklyn,Sunshine,Campbellfield,Somerton,Epping,Thomastown,Tullamarine,Dandenong,Dandenong South,Hallam,Pakenham,Lyndhurst,Clayton,Port Melbourne,Footscray,Werribee,Geelong,Lara,Corio,Colac,Warrnambool,Portland,Hamilton,Ballarat,Ballan,Bacchus Marsh,Beaufort,Ararat,Stawell,Horsham,Nhill,Kaniva,Dimboola,Bendigo,Kyneton,Castlemaine,Echuca,Kerang,Swan Hill,Mildura,Ouyen,Sea Lake,Charlton,Wedderburn,St Arnaud,Shepparton,Nagambie,Seymour,Wallan,Kalkallo,Broadford,Avenel,Euroa,Violet Town,Benalla,Glenrowan,Wangaratta,Springhurst,Chiltern,Barnawartha,Wodonga,Cobram,Numurkah,Yarrawonga,Tocumwal,Traralgon,Morwell,Moe,Warragul,Sale,Bairnsdale,Lakes Entrance,Orbost,Cann River,Leongatha,Wonthaggi',
    NSW: 'Sydney,Eastern Creek,Wetherill Park,Smithfield,Prestons,Ingleburn,Minto,Chullora,Enfield,Port Botany,Banksmeadow,Erskine Park,St Marys,Penrith,Marulan,Goulburn,Yass,Jugiong,Gundagai,Tarcutta,Holbrook,Albury,Wagga Wagga,Narrandera,Hay,Balranald,Deniliquin,Finley,Jerilderie,West Wyalong,Forbes,Parkes,Dubbo,Gilgandra,Coonabarabran,Narrabri,Moree,Boggabilla,Tamworth,Armidale,Glen Innes,Tenterfield,Newcastle,Hexham,Beresfield,Tomago,Raymond Terrace,Bulahdelah,Taree,Kempsey,Port Macquarie,Coffs Harbour,Grafton,Ballina,Tweed Heads,Chinderah,Wollongong,Port Kembla,Nowra,Batemans Bay,Cooma,Bathurst,Orange,Lithgow,Cowra,Young,Griffith,Leeton,Broken Hill,Wilcannia,Cobar,Nyngan,Bourke,Pheasants Nest,Wyong,Ourimbah,Mittagong,Sutton Forest',
    QLD: 'Brisbane,Rocklea,Acacia Ridge,Wacol,Larapinta,Hemmant,Pinkenba,Lytton,Yatala,Stapylton,Ormeau,Ipswich,Gatton,Toowoomba,Warwick,Stanthorpe,Goondiwindi,Dalby,Miles,Roma,Charleville,Caboolture,Gympie,Maryborough,Childers,Gin Gin,Bundaberg,Gladstone,Rockhampton,Marlborough,Mackay,Proserpine,Bowen,Townsville,Ingham,Cairns,Emerald,Longreach,Mount Isa,Cloncurry,Charters Towers,Burpengary,Nudgee,Coomera',
    SA: 'Adelaide,Wingfield,Gepps Cross,Regency Park,Dry Creek,Port Adelaide,Gillman,Lonsdale,Murray Bridge,Tailem Bend,Keith,Bordertown,Mount Gambier,Naracoorte,Renmark,Berri,Port Augusta,Port Pirie,Whyalla,Ceduna,Coober Pedy,Port Wakefield,Nuriootpa,Two Wells,Monarto,Yamba,Pinnaroo,Lameroo',
    TAS: 'Hobart,Brighton,Launceston,Devonport,Burnie,Campbell Town,Oatlands,Bridgewater',
    ACT: 'Canberra,Fyshwick,Hume,Mitchell',
    WA: 'Perth,Kewdale,Welshpool,Hazelmere,Forrestfield,Kwinana,Northam,Kalgoorlie,Norseman,Eucla,Geraldton,Port Hedland',
    NT: 'Darwin,Katherine,Tennant Creek,Alice Springs'
  };
  var STATES = { 'Victoria': 'VIC', 'New South Wales': 'NSW', 'Queensland': 'QLD', 'South Australia': 'SA', 'Tasmania': 'TAS', 'Western Australia': 'WA', 'Northern Territory': 'NT', 'Australian Capital Territory': 'ACT' };
  var nearCache = null;
  function locate() { return new Promise(function (res, rej) { if (!navigator.geolocation) return rej({ code: 0 }); navigator.geolocation.getCurrentPosition(function (p) { res(p.coords); }, rej, { enableHighAccuracy: true, timeout: 20000, maximumAge: 60000 }); }); }
  function distKm(a, b, c, d) { var R = 6371, x = (c - a) * Math.PI / 180, y = (d - b) * Math.PI / 180, h = Math.sin(x / 2) * Math.sin(x / 2) + Math.cos(a * Math.PI / 180) * Math.cos(c * Math.PI / 180) * Math.sin(y / 2) * Math.sin(y / 2); return 2 * R * Math.asin(Math.sqrt(h)); }
  function getJSON(url, opt) { var ctl = new AbortController(), t = setTimeout(function () { ctl.abort(); }, 15000); return fetch(url, Object.assign({ signal: ctl.signal }, opt || {})).then(function (r) { clearTimeout(t); if (!r.ok) throw 0; return r.json(); }); }
  function nearby(lat, lon) { // suburb from Nominatim, rest areas / service centres / fuel from Overpass (OpenStreetMap)
    var rev = getJSON('https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=14&addressdetails=1&accept-language=en&lat=' + lat + '&lon=' + lon).then(function (j) {
      var a = j.address || {}, name = a.suburb || a.town || a.village || a.hamlet || a.city_district || a.city || a.locality || a.municipality;
      return name ? { p: name, k: 'town', dist: 0, st: STATES[a.state] || '', road: a.road || '' } : null;
    }).catch(function () { return null; });
    var q = '[out:json][timeout:12];(nwr(around:30000,' + lat + ',' + lon + ')[highway~"^(rest_area|services)$"];nwr(around:10000,' + lat + ',' + lon + ')[amenity=fuel];);out center tags 90;';
    var poi = getJSON('https://overpass-api.de/api/interpreter', { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }).then(function (j) {
      return (j.elements || []).map(function (e) {
        var t = e.tags || {}, la = e.lat != null ? e.lat : e.center && e.center.lat, lo = e.lon != null ? e.lon : e.center && e.center.lon; if (la == null) return null;
        var fuel = t.amenity === 'fuel', k = fuel ? (t.hgv === 'yes' || t.hgv === 'designated' || /truck|roadhouse/i.test(t.name || '') ? 'stop' : 'fuel') : t.highway === 'services' ? 'stop' : 'rest';
        return { name: (t.name || (fuel ? t.brand || t.operator : '') || '').trim(), k: k, dist: distKm(lat, lon, la, lo), sub: t['addr:suburb'] || t['addr:city'] || '' };
      }).filter(Boolean);
    }).catch(function () { return null; });
    return Promise.all([rev, poi]).then(function (r) {
      var town = r[0], pois = r[1], items = [], seen = {};
      if (!town && !pois) throw { net: true };
      if (town) items.push(town);
      (pois || []).sort(function (x, y) { return x.dist - y.dist; }).forEach(function (x) {
        var label = x.name;
        if (label && x.sub && label.toLowerCase().indexOf(x.sub.toLowerCase()) < 0) label += ', ' + x.sub;
        if (!label) { if (!town) return; label = (x.k === 'rest' ? 'Rest area' : x.k === 'stop' ? 'Truck stop' : 'Fuel station') + ' near ' + town.p; }
        if (x.k === 'rest') label = placeLabel(label, 'rest');
        var key = label.toLowerCase(); if (seen[key]) return; seen[key] = 1;
        items.push({ p: label, k: x.k, dist: x.dist });
      });
      return { items: items.slice(0, 16), partial: !town || !pois };
    });
  }
  function placeLabel(name, kind) {
    name = name.trim().replace(/\s+/g, ' ');
    if (kind === 'rest' && !/rest area|parking bay/i.test(name)) return name + ' rest area';
    if (kind === 'stop' && !/truck ?stop|roadhouse|service centre/i.test(name)) return name + ' truck stop';
    return name;
  }
  function placeDialog(n, slot, opts) {
    opts = opts || {}; var done = opts.after || renderDiary;
    var cur = ((S.days[keyOf(n)] || {}).ev || {})[slot] || {}, kind = cur.k || 'town', saved = S.settings.places || [];
    modal('<h2>' + esc(opts.title || 'Place at ' + clock(slot)) + '</h2>' + (opts.odo ? '<div class="form" style="grid-template-columns:1fr"><label>Odometer<input id="pk-odo" inputmode="numeric" pattern="[0-9]*" autocomplete="off" value="' + esc(cur.o || '') + '" placeholder="Odometer reading"></label></div>' : '') + '<p class="hint">' + (opts.odo ? 'Then choose the place: a rest area, truck stop, fuel station, suburb or town.' : 'Record the name of the place where you changed between work and rest: a rest area, truck stop, fuel station, suburb or town.') + '</p>'
      + '<div class="kinds" id="pk-k">' + Object.keys(KINDS).map(function (k) { return '<button type="button" data-k="' + k + '">' + KINDS[k] + '</button>'; }).join('') + '</div>'
      + (HOSTED || !navigator.geolocation ? '' : '<div class="pkgps"><button type="button" class="btn pri" id="pk-gps">Find places near me</button><span class="hint" id="pk-s" role="status"></span></div>')
      + '<input type="search" id="pk-q" placeholder="Type the name" autocomplete="off" value="' + esc(cur.p || '') + '"><div class="plist" id="pk-l"></div>'
      + '<div class="acts">' + (cur.p ? '<button class="btn danger" id="pk-x">Remove place</button>' : '') + (opts.odo ? '<button class="btn" id="pk-skip">Save without place</button>' : '<button class="btn" data-x>Cancel</button>') + '</div>', function (box, close) {
      var q = box.querySelector('#pk-q'), list = box.querySelector('#pk-l'), near = nearCache && Date.now() - nearCache.t < 180000 ? nearCache.items : null, gps = box.querySelector('#pk-gps'), stat = box.querySelector('#pk-s');
      if (gps) gps.addEventListener('click', function () {
        gps.disabled = true; stat.textContent = 'Finding your location…';
        locate().then(function (c) { stat.textContent = 'Looking up places…'; return nearby(c.latitude, c.longitude); }).then(function (r) {
          near = r.items; nearCache = { t: Date.now(), items: near }; gps.disabled = false; q.value = '';
          stat.textContent = near.length ? (r.partial ? 'Some results are missing. Check the name.' : 'Pick the place below.') : 'Nothing found near you. Type the name.'; draw();
        }).catch(function (e) {
          gps.disabled = false;
          stat.textContent = e && e.code === 1 ? 'Location is blocked for this app. Allow it in your phone settings, or type the name.' : e && e.net ? 'No internet, so names cannot be looked up. Type the name.' : 'Could not get your location. Try again outside, or type the name.';
        });
      });
      function pick(name, k, exact) {
        var label = exact ? name.trim() : placeLabel(name, k); if (!label) return;
        var d = day(n), oe = box.querySelector('#pk-odo'), rec = { p: label, k: k }; if (oe && oe.value.trim()) rec.o = oe.value.trim();
        d.ev = d.ev || {}; d.ev[slot] = Object.assign({}, d.ev[slot], rec); d.t = Date.now(); dirty(n);
        S.settings.places = [{ p: label, k: k, t: Date.now() }].concat(saved.filter(function (x) { return x.p.toLowerCase() !== label.toLowerCase(); })).slice(0, 150);
        touchSettings(); save(); close(); done();
      }
      function draw() {
        box.querySelectorAll('#pk-k button').forEach(function (b) { b.setAttribute('aria-pressed', b.dataset.k === kind); });
        q.placeholder = kind === 'rest' ? 'Rest area name' : kind === 'stop' ? 'Truck stop name' : kind === 'fuel' ? 'Fuel station name and town' : kind === 'town' ? 'Suburb or town' : 'Depot or customer name and suburb';
        var t = q.value.trim().toLowerCase(), h = '', seen = {}, cnt = 0;
        if (near) near.filter(function (x) { return !t || x.p.toLowerCase().indexOf(t) >= 0; }).forEach(function (x) { seen[x.p.toLowerCase()] = 1; h += '<button type="button" data-p="' + esc(x.p) + '" data-k="' + x.k + '" data-exact="1"><span>' + esc(x.p) + '</span><small>' + KINDS[x.k] + (x.k === 'town' ? ' · you are here' : ' · ' + (x.dist < 10 ? x.dist.toFixed(1) : Math.round(x.dist)) + ' km') + '</small></button>'; });
        if (t) h += '<button type="button" class="use" data-p="' + esc(q.value) + '" data-k="' + kind + '"><span>Use “' + esc(placeLabel(q.value, kind)) + '”</span><small>' + KINDS[kind] + '</small></button>';
        saved.filter(function (x) { return !seen[x.p.toLowerCase()] && (!t || x.p.toLowerCase().indexOf(t) >= 0) && (t || x.k === kind); }).slice(0, 8).forEach(function (x) { seen[x.p.toLowerCase()] = 1; h += '<button type="button" data-p="' + esc(x.p) + '" data-k="' + x.k + '" data-saved="1"><span>' + esc(x.p) + '</span><small>' + (KINDS[x.k] || '') + ' · used before</small></button>'; });
        if (t || kind === 'town') {
          var order = [S.settings.base].concat(Object.keys(TOWNS).filter(function (z) { return z !== S.settings.base; }));
          order.forEach(function (z) { (TOWNS[z] || '').split(',').forEach(function (name) {
            if (cnt >= 12 || seen[name.toLowerCase()]) return; var l = name.toLowerCase();
            if (t ? l.indexOf(t) === 0 || l.indexOf(' ' + t) >= 0 : z === S.settings.base) { cnt++; h += '<button type="button" data-p="' + esc(name) + '" data-k="' + kind + '"><span>' + esc(kind === 'town' ? name : placeLabel(name, kind)) + '</span><small>' + z + '</small></button>'; }
          }); });
        }
        list.innerHTML = h || '<button type="button" disabled><span style="color:var(--muted)">Type a name. Places you use are remembered for next time.</span></button>';
      }
      box.querySelector('#pk-k').addEventListener('click', function (e) { var b = e.target.closest('button'); if (b) { kind = b.dataset.k; draw(); q.focus(); } });
      q.addEventListener('input', draw);
      q.addEventListener('keydown', function (e) { if (e.key === 'Enter' && q.value.trim()) pick(q.value, kind); });
      list.addEventListener('click', function (e) { var b = e.target.closest('button[data-p]'); if (b) pick(b.dataset.p, b.dataset.k, !!b.dataset.exact || !!b.dataset.saved); });
      var rm = box.querySelector('#pk-x'); if (rm) rm.addEventListener('click', function () { var d = day(n); if (d.ev && d.ev[slot]) { delete d.ev[slot].p; delete d.ev[slot].k; d.t = Date.now(); dirty(n); save(); } close(); done(); });
      var sk = box.querySelector('#pk-skip'); if (sk) sk.addEventListener('click', function () { var oe = box.querySelector('#pk-odo'); if (oe && oe.value.trim()) { var d = day(n); d.ev = d.ev || {}; d.ev[slot] = Object.assign({}, d.ev[slot], { o: oe.value.trim() }); d.t = Date.now(); dirty(n); save(); } close(); done(); });
      draw(); setTimeout(function () { var oe = box.querySelector('#pk-odo'); if (oe) oe.focus(); else { q.focus(); q.select(); } if (opts.auto && gps && navigator.onLine) gps.click(); }, 0);
    });
  }

  // Diary pages as a PDF in the work diary sheet layout, one day per page (the original APS Logbook page)
  /* ---------- real work diary book and page numbers ---------- */
  function pageOf(n) {
    var books = S.settings.books || [], k = keyOf(n), b = null; books.forEach(function (x) { if (x.d <= k && (!b || x.d > b.d)) b = x; });
    if (!b) return null;
    var n0 = dayNum(b.d), page = b.p;
    if (S.settings.pageSkip) { if (getS(n).indexOf('w') < 0) return null; for (var i = n0; i < n; i++) if (getS(i).indexOf('w') >= 0) page++; } else page += n - n0;
    return { no: b.no || '', page: page };
  }
  function pageSvg(APS, n) { var pg = pageOf(n); return APS.diaryPage(diaryDay(n), pg ? { number: String(pg.page), status: 'Active' } : null, pg && pg.no ? { number: pg.no } : null); }
  /* ---------- saved trucks and trailers, capital letters, suggestions ---------- */
  var REGO = { 'plate': 'truck', 's-plate': 'truck', 'su-plate': 'truck', 'fv-pm': 'truck', 'fv-t1': 'trailer', 'fv-t2': 'trailer', 'fv-t3': 'trailer' }, UPPER = { 's-accr': 1, 's-book': 1, 'fv-accreditation': 1, 'ta-from': 1, 'ta-to': 1 };
  function regoKey(v) { return String(v).toUpperCase().replace(/[^A-Z0-9]/g, ''); }
  function regos(kind) { var r = S.settings.regos || (S.settings.regos = { truck: [], trailer: [] }); if (!r[kind]) r[kind] = []; return r[kind]; }
  function addRego(kind, v) {
    v = String(v || '').trim().toUpperCase().replace(/\s+/g, ' '); var key = regoKey(v); if (key.length < 3) return;
    var L = regos(kind), at = -1; L.forEach(function (x, i) { if (regoKey(x) === key) at = i; });
    if (at === 0) return; if (at > 0) L.splice(at, 1); L.unshift(v); if (L.length > 80) L.length = 80; touchSettings(); save();
  }
  var sugBox = null, sugFor = null;
  function sugHide() { if (sugBox) { sugBox.remove(); sugBox = null; sugFor = null; } }
  function sugShow(el) {
    var kind = REGO[el.id]; if (!kind || el.disabled || el.readOnly) return;
    var key = regoKey(el.value), L = regos(kind).filter(function (x) { var k = regoKey(x); return k.indexOf(key) === 0 && k !== key; }).slice(0, 6);
    sugHide(); if (!L.length) return;
    var r = el.getBoundingClientRect(); sugBox = document.createElement('div'); sugBox.className = 'sug'; sugFor = el;
    sugBox.style.left = r.left + 'px'; sugBox.style.width = r.width + 'px'; if (r.bottom + 230 > window.innerHeight && r.top > 240) sugBox.style.bottom = (window.innerHeight - r.top + 4) + 'px'; else sugBox.style.top = (r.bottom + 4) + 'px';
    sugBox.innerHTML = L.map(function (x) { return '<button type="button">' + esc(x) + '</button>'; }).join('');
    sugBox.addEventListener('pointerdown', function (e) { var b = e.target.closest('button'); if (!b) return; e.preventDefault(); var t = sugFor; t.value = b.textContent; sugHide(); t.dispatchEvent(new Event('input', { bubbles: true })); t.dispatchEvent(new Event('change', { bubbles: true })); sugHide(); });
    document.body.appendChild(sugBox);
  }
  document.addEventListener('input', function (e) {
    var el = e.target, id = el && el.id; if (!id || !(REGO[id] || UPPER[id])) return;
    var up = el.value.toUpperCase(); if (up !== el.value) { var p = el.selectionStart; el.value = up; try { el.setSelectionRange(p, p); } catch (x) {} }
    if (REGO[id]) sugShow(el);
  }, true);
  document.addEventListener('change', function (e) { var el = e.target, id = el && el.id; if (!id) return; if (REGO[id] || UPPER[id]) el.value = el.value.trim().toUpperCase(); if (REGO[id]) addRego(REGO[id], el.value); }, true);
  document.addEventListener('focusin', function (e) { if (e.target && REGO[e.target.id]) sugShow(e.target); });
  document.addEventListener('focusout', function (e) { if (e.target === sugFor) setTimeout(function () { if (document.activeElement !== sugFor) sugHide(); }, 150); });
  document.addEventListener('scroll', function (e) { if (sugBox && !(e.target && e.target.closest && e.target.closest('.sug'))) sugHide(); }, true);
  window.addEventListener('resize', sugHide);
  function diaryDay(n) {
    var k = keyOf(n), d = S.days[k] || {}, s = getS(n), opt = optOf(n), ev = d.ev || {}, changes = {}, plate = d.plate != null && d.plate !== '' ? d.plate : S.settings.plate || '';
    Object.keys(ev).forEach(function (sl) { if (ev[sl] && (ev[sl].p || ev[sl].o)) changes[sl] = { slot: +sl, location: ev[sl].p || '', odometer: ev[sl].o || '', restType: 'stationary', note: '', vehicle: plate }; });
    var scheme = opt === 'bfm' || opt === 'bfm2' ? 'BFM' : opt === 'custom' ? 'AFM' : 'Standard';
    return { date: k, slots: s.split('').map(function (c) { return c === 'w' ? 'work' : 'rest'; }), changes: changes, vehicle: plate, comments: d.note || '',
      dailyCheckTime: d.chk || '', fitForDuty: !!d.fit,
      profile: { name: S.settings.name || '', licence: S.settings.licence || '', base: S.settings.base, scheme: scheme, twoUp: opt === 'std2' || opt === 'bfm2', coDriver: d.co || '', coLicence: d.colic || '', coScheme: '', coBase: '' } };
  }
  function pagesDialog(n) {
    modal('<h2>Send diary pages</h2><p class="hint">Makes a PDF with one day on each page, in the work diary sheet layout, with total work and rest. For one day, use the same date twice.</p><div class="form"><label>From<input type="date" id="pg-a" value="' + keyOf(n) + '"></label><label>To<input type="date" id="pg-b" value="' + keyOf(n) + '"></label></div><p class="hint" id="pg-n"></p><div class="acts"><button class="btn" data-x>Cancel</button><button class="btn pri" id="pg-ok">Make PDF</button></div>', function (box, close) {
      var A = box.querySelector('#pg-a'), B = box.querySelector('#pg-b'), N = box.querySelector('#pg-n');
      function span() { if (!A.value || !B.value) return 0; return dayNum(B.value) - dayNum(A.value) + 1; }
      function show() { var c = span(); N.textContent = c < 1 ? 'The To date is before the From date.' : c > 31 ? 'Choose 31 days or fewer.' : c + (c === 1 ? ' page' : ' pages'); }
      A.addEventListener('change', function () { if (B.value < A.value) B.value = A.value; show(); }); B.addEventListener('change', show); show();
      box.querySelector('#pg-ok').addEventListener('click', function () {
        var c = span(); if (c < 1 || c > 31) return; var a0 = dayNum(A.value), name = 'Diary-' + A.value + (c > 1 ? '-to-' + B.value : '');
        if (!S.settings.name) toast('Tip: add your name and licence number under More so they print on the pages.', 6000);
        close(); window.WDOffice.core().then(function (APS) { var pages = []; for (var i = 0; i < c; i++) pages.push(pageSvg(APS, a0 + i)); return window.WDOffice.preview(name, pages); }).catch(function (e) { toast((e && e.message) || 'The pages could not be made.'); });
      });
    });
  }
  function shiftDialog(n) {
    modal('<h2>Add shift</h2><p class="hint">Starts on ' + fmtDay(n) + '. If the end time is earlier than the start, the shift runs into the next day. Work time is rounded up to the next 15 minutes.</p>'
      + '<div class="form"><label>Start<input type="time" id="sh-a" step="900" value="20:00"></label><label>End<input type="time" id="sh-b" step="900" value="06:00"></label>'
      + '<label>Rest break after (hours of work)<input type="number" id="sh-k" min="0" max="12" step="0.25" value="0"></label><label>Break length (minutes)<input type="number" id="sh-l" min="15" max="120" step="15" value="30"></label></div>'
      + '<p class="hint">Leave the break at 0 hours to add the shift as one block, then drag on the sheet to add breaks.</p>'
      + '<div class="acts"><button class="btn" data-x>Cancel</button><button class="btn pri" id="sh-ok">Add work</button></div>', function (box, close) {
      box.querySelector('#sh-ok').addEventListener('click', function () {
        var a = box.querySelector('#sh-a').value, b = box.querySelector('#sh-b').value; if (!a || !b) return;
        var sa = Math.floor((+a.slice(0, 2) * 60 + +a.slice(3)) / 15), sb = Math.ceil((+b.slice(0, 2) * 60 + +b.slice(3)) / 15); if (sb <= sa) sb += D;
        var k = Math.round((+box.querySelector('#sh-k').value || 0) * 4), l = Math.max(1, Math.round((+box.querySelector('#sh-l').value || 30) / 15));
        close();
        coachGate(n, sa, sb, function (st) { snapshot(); setAbsRange(n, st, sb, 'w'); if (k > 0) for (var x = st + k; x + l < sb; x += k + l) setAbsRange(n, x, x + l, 'r'); save(); renderDiary(); });
      });
    });
  }

  function why(f) {
    if (f.kind === 'work') return f.label.toLowerCase() + ' (' + hm(f.max) + (f.rule === 'ln7' ? ' long/night work' : f.rule === 'r84' ? ' work before a 24h rest' : ' work') + ').';
    return f.label.toLowerCase() + ', ' + (/night rest/.test(f.msg) ? 'you would lose a night rest break you need.' : 'you would miss a rest break you need.');
  }
  function driveOn() { return !!(window.WDDrive && window.WDDrive.connected && window.WDDrive.connected()); }
  function hasWork(n) { return getS(n).indexOf('w') >= 0; }
  function firstDay() { var f = null; for (var k in S.days) if (S.days[k].s && S.days[k].s.indexOf('w') >= 0 && (f === null || k < f)) f = k; return f ? dayNum(f) : null; }
  function emptyDays(today) { // days with no entry that were never confirmed as rest
    var f = firstDay(), out = []; if (f === null) return out;
    for (var n = Math.max(f, today - 28); n < today; n++) { var d = S.days[keyOf(n)]; if (!hasWork(n) && !(d && d.c)) out.push(n); }
    return out;
  }
  function dayNotes(n) { // things to fix in the record itself: missing places, odometer going backwards
    var s = getS(n), d = S.days[keyOf(n)] || {}, ev = d.ev || {}, prev = getS(n - 1)[D - 1], miss = 0, out = [], last = null, back = false;
    var nwN = nowBase(), lim = n === nwN.n ? nwN.i : n > nwN.n ? -1 : D; // changes that have not happened yet are not missing anything
    for (var i = 0; i < D; i++) { var before = i === 0 ? prev : s[i - 1]; if (i > lim) break; if (s[i] !== before) { var e = ev[i] || {}; if (!e.p) miss++; var o = parseFloat(String(e.o || '').replace(/[,\s]/g, '')); if (isFinite(o)) { if (last !== null && o < last) back = true; last = o; } } }
    if (miss && hasWork(n)) out.push(miss + (miss === 1 ? ' change has' : ' changes have') + ' no place. The work diary needs the place at each work and rest change.');
    if (back) out.push('An odometer reading is lower than the one before it. Check the numbers.');
    return out;
  }
  function zoneOffset(ms, zone) { var o = {}; new Intl.DateTimeFormat('en-AU', { timeZone: zone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(ms)).forEach(function (x) { o[x.type] = +x.value; }); return Math.round((Date.UTC(o.year, o.month - 1, o.day, o.hour % 24, o.minute) - ms) / 60000); }
  function dstChange(n) { // minutes the clock moves on this date in the base time zone (0 on normal days)
    try { var z = ZONES[S.settings.base], g = n * 864e5 - zoneOffset(n * 864e5 - 432e5, z) * 60000; return zoneOffset(g + 23 * 36e5, z) - zoneOffset(g + 6e4, z); } catch (e) { return 0; }
  }
  var alerted = {}, restGoal = null;
  function alertUser(key, msg) {
    if (alerted[key] || S.settings.alerts === false) return; alerted[key] = 1; toast(msg, 20000);
    try { if (navigator.vibrate) navigator.vibrate([200, 100, 200]); } catch (e) {}
    try { if (document.hidden && window.Notification && Notification.permission === 'granted') new Notification('APS Logbook', { body: msg, tag: key }); } catch (e) {}
  }
  function checkAlerts() { // runs once a minute while the app is open
    if (S.settings.alerts === false) return; var nw = nowBase();
    try {
      if (S.live) {
        restGoal = null; var A = analyseAll(nw.n), off = (nw.n - A.d0) * D, T = off + nw.i + 1, st = standing(nw.n, T), fc = FM.forecast(st.seg.W, st.opt, cfgOf(st.opt), T);
        var key = fc.stop ? fc.stop.rule + ':' + fc.stop.at : 'x';
        if (fc.can === 0) alertUser('stop:' + key, 'Limit reached. Stop work now. ' + (fc.stop ? fc.stop.label + '.' : ''));
        else if (fc.can <= 2) alertUser('soon:' + key, 'Stop in ' + hm(fc.can) + ' or less, at ' + clock(nw.i + 1 + fc.can) + '. Next limit: ' + (fc.stop ? why(fc.stop) : ''));
      } else if (window.WDCoach && getS(nw.n)[nw.i] !== 'w') {
        var tip = window.WDCoach.check(nw.n, nw.i);
        if (tip && tip.kind === 'popup' && tip.rel != null) restGoal = { n: nw.n, rel: tip.rel, title: tip.title.replace('Almost a ', '') };
        else if (restGoal && (nw.n - restGoal.n) * D + nw.i >= restGoal.rel) { alertUser('rest:' + restGoal.n + ':' + restGoal.rel, 'Your ' + restGoal.title + ' is complete.'); restGoal = null; }
      }
    } catch (e) {}
  }
  /* ---------- now ---------- */
  function renderNow() {
    var nw = nowBase(); tickLive();
    var A = analyseAll(nw.n), off = (nw.n - A.d0) * D, working = getS(nw.n)[nw.i] === 'w', T = off + nw.i + (working ? 1 : 0);
    var st = standing(nw.n, T), fc = FM.forecast(st.seg.W, st.opt, cfgOf(st.opt), T), head, sub, level;
    if (st.m.working) {
      if (fc.can > 0) { level = fc.can <= 4 ? 'amber' : 'green'; head = 'Drive until ' + absT(T + fc.can, nw.n); sub = hm(fc.can) + ' of work left before you must stop.' + (fc.stop ? ' Next limit: ' + why(fc.stop) : ' No limit reached in the next 15 hours.'); }
      else { level = 'red'; head = 'Stop work now'; sub = (fc.stop ? fc.stop.label + ': ' + fc.stop.msg : 'A limit has been reached.') + (fc.restart != null ? ' You can start again at ' + absT(fc.restart, nw.n) + '.' : ''); }
    } else {
      if (fc.can > 0) { level = 'green'; head = 'You can start work'; sub = 'If you start now you can work ' + hm(fc.can) + (fc.stop ? ' before the next limit. Next limit: ' + why(fc.stop) : ' or more.'); }
      else { level = 'amber'; head = fc.restart != null ? 'Rest until ' + absT(fc.restart, nw.n) : 'Keep resting'; sub = fc.stop ? fc.stop.label + ': ' + fc.stop.msg : ''; }
    }
    var by = {}; st.m.list.forEach(function (m) { by[m.id] = m; });
    var due = [];
    if (st.m.working && fc.can > 0 && fc.stop) due.push(['Next stop', absT(T + fc.can, nw.n), why(fc.stop)]);
    if (by.d24 && by.d24.restLen && by.d24.from != null) due.push([hm(by.d24.restLen) + ' continuous rest', by.d24.restDue != null ? 'start by ' + absT(by.d24.restDue, nw.n) : 'done', by.d24.restDue != null ? '' : 'taken in this 24-hour period']);
    if (by.d24) due.push(['Work left in 24 hours', hm(Math.max(0, by.d24.max - by.d24.used)), 'of ' + hm(by.d24.max)]);
    if (by.r84) due.push(['Before a 24-hour rest', hm(Math.max(0, by.r84.max - by.r84.used)), 'of work left (84h rule)']);
    if (by.w7 && by.w7.max) due.push(['Work left in 7 days', hm(Math.max(0, by.w7.max - by.w7.used)), 'of ' + hm(by.w7.max)]);
    if (by.ln7) due.push(['Long/night hours left', hm(Math.max(0, by.ln7.max - by.ln7.used)), 'of 36h']);
    var openF = A.findings.filter(function (f) { return !f.warn && f.at >= off - 14 * D && f.at < T; });
    // things that need your attention
    var att = '', empties = emptyDays(nw.n), notes = dayNotes(nw.n).concat(hasWork(nw.n - 1) ? dayNotes(nw.n - 1).map(function (x) { return 'Yesterday: ' + x; }) : []);
    if (empties.length) att += '<div class="attn"><b>' + empties.length + (empties.length === 1 ? ' day has' : ' days have') + ' no entry</b><span>' + empties.slice(-6).map(function (n) { return fmtDay(n); }).join(', ') + (empties.length > 6 ? ' and more' : '') + '. They are counted as rest. Were you resting?</span><div class="tools"><button class="btn sm pri" id="at-rest">Yes, all rest days</button><button class="btn sm" id="at-open">Open ' + fmtDay(empties[empties.length - 1]) + '</button></div></div>';
    if (notes.length) att += '<div class="attn"><b>Finish your record</b><span>' + notes.map(esc).join(' ') + '</span><div class="tools"><button class="btn sm" id="at-sheet">Open the sheet</button></div></div>';
    var recDays = Object.keys(S.days).filter(function (k) { return S.days[k].s && S.days[k].s.indexOf('w') >= 0; }).length, since = S.settings.lastBackup || S.settings.firstUse || Date.now(), bdays = Math.floor((Date.now() - since) / 864e5);
    if (!HOSTED && !driveOn() && recDays > 0 && bdays >= 7) att += '<div class="attn"><b>No backup for ' + bdays + ' days</b><span>Your records are only on this phone.</span><div class="tools"><button class="btn sm" id="at-backup">Go to backup</button></div></div>';
    var tipLine = (function () { if (st.m.working || S.settings.tips === false || !window.WDCoach) return ''; var tip = window.WDCoach.check(nw.n, nw.i); return tip && tip.kind !== 'warn' ? '<p class="note" style="border-color:var(--work);color:var(--ink)">' + esc(tip.kind === 'tip' ? tip.text : tip.text + ' ' + tip.gain) + '</p>' : ''; })();
    main.innerHTML = '<div class="wrap"><div class="hero ' + level + '"><div class="state ' + (st.m.working ? 'work' : '') + '"><i></i>' + (st.m.working && !S.live ? 'Rest starts at ' + clock(nw.i + 1) + ' · this 15 minute block counts as work' : (st.m.working ? 'Working' : 'Resting') + ' since ' + (st.m.since <= 0 ? 'before your records start' : absT(st.m.since, nw.n)) + (st.m.since > 0 ? ' (' + hm(T - st.m.since) + ')' : '')) + ' · ' + fmtDay(nw.n) + ' ' + clock(nw.i) + '</div>'
      + '<div class="big">' + esc(head) + '<small>' + esc(sub) + '</small></div>'
      + '<button class="bigbtn ' + (S.live ? 'rest' : 'work') + '" id="live">' + (S.live ? 'Start rest' : 'Start work') + '</button><p class="hint" style="text-align:center">Tap only when the truck is stopped. It records the time, then asks for the odometer and place.</p></div>'
      + tipLine + (att ? '<div class="stack" style="gap:10px">' + att + '</div>' : '')
      + '<div class="cols"><div class="stack"><div class="card"><h3>Coming up</h3><div class="due">' + due.map(function (x) { return '<div><span>' + esc(x[0]) + '</span><b>' + esc(x[1]) + '</b><small>' + esc(x[2] || '') + '</small></div>'; }).join('') + '</div><div class="tools" style="margin-top:12px"><button class="btn" id="godiary">Open today\'s sheet</button><button class="btn" id="goplan">Plan ahead</button></div></div>'
      + '<details class="card fold" id="now-all"><summary>All limits · ' + esc(FM.OPTIONS[st.opt].name) + '</summary><div class="meters">' + metersHTML(st, nw.n) + '</div></details></div>'
      + '<div class="stack"><div class="card"><h3>Issues in the last 14 days</h3><div class="issues">' + (openF.length ? openF.slice(-8).reverse().map(issueHTML).join('') : '<div class="clean">✓ No limit broken in your records.</div>') + '</div></div>'
      + '<p class="note warn">These are outer limits only. Never drive if you feel tired, whatever the numbers say. This app helps you count. It is not an approved Electronic Work Diary, so keep your written work diary up to date.</p></div></div></div>';
    on('live', function () {
      var x = nowBase();
      if (S.live) {
        snapshot(); tickLive(); S.live = null; touchSettings(); save();
        var rn = x.i === D - 1 ? x.n + 1 : x.n, ri = (x.i + 1) % D;
        return placeDialog(rn, ri, { odo: true, auto: true, title: 'Rest starts at ' + clock(ri), after: function () { renderNow(); if (window.WDOffice && window.WDOffice.tripAsk) setTimeout(function () { window.WDOffice.tripAsk(keyOf(rn) + ':' + ri, false).catch(function () {}); }, 250); } });
      }
      coachGate(x.n, x.i, x.i + 1, function (st2) {
        if (st2 !== x.i) return; snapshot(); S.live = { n: x.n, i: x.i }; setRange(x.n, x.i, x.i + 1, 'w'); touchSettings(); save();
        placeDialog(x.n, x.i, { odo: true, auto: true, title: 'Work started at ' + clock(x.i), after: renderNow });
      });
    });
    on('godiary', function () { focus = nowBase().n; location.hash = '#diary'; });
    on('goplan', function () { location.hash = window.WDPlan ? '#plan' : '#fortnight'; });
    on('at-rest', function () { empties.forEach(function (n) { var d = day(n); d.c = 1; d.t = Date.now(); dirty(n); }); save(); renderNow(); toast('Marked as rest days.'); });
    on('at-open', function () { focus = empties[empties.length - 1]; location.hash = '#diary'; });
    on('at-sheet', function () { focus = dayNotes(nw.n).length ? nw.n : nw.n - 1; location.hash = '#diary'; });
    on('at-backup', function () { location.hash = '#more'; });
  }

  /* ---------- fortnight ---------- */
  function strip(n, A) {
    var off = (n - A.d0) * D, s = getS(n), r = '<rect x="0" y="0" width="32" height="10" fill="var(--night)"/><rect x="88" y="0" width="8" height="10" fill="var(--night)"/><rect x="32" y="0" width="56" height="10" fill="var(--cell)"/>', i = 0;
    while (i < D) { if (s[i] !== 'w') { i++; continue; } var fl = A.flags[off + i], j = i; while (j < D && s[j] === 'w' && A.flags[off + j] === fl) j++; r += '<rect x="' + i + '" y="0" width="' + (j - i) + '" height="10" fill="var(' + (fl === 2 ? '--bad' : fl === 1 ? '--warn' : '--work') + ')"/>'; i = j; }
    return '<svg class="strip" viewBox="0 0 96 10" preserveAspectRatio="none" aria-hidden="true">' + r + '</svg>';
  }
  function renderFort() {
    var nw = nowBase(); if (fortStart == null) fortStart = nw.n - ((dow(nw.n) + 6) % 7) - 7;
    var A = analyseAll(fortStart + 7), rows = '', tw = 0, tl = 0, tf = 0, wk = [0, 0], wl = [0, 0];
    for (var k = 0; k < 14; k++) {
      var n = fortStart + k, off = (n - A.d0) * D, s = getS(n), w = 0, l = 0, i;
      for (i = 0; i < D; i++) { if (s[i] === 'w') w++; if (A.ln[off + i]) l++; }
      var fs = A.findings.filter(function (f) { return !f.warn && f.at >= off && f.at < off + D; }).length;
      tw += w; tl += l; tf += fs; wk[k < 7 ? 0 : 1] += w; wl[k < 7 ? 0 : 1] += l;
      rows += '<tr class="frow' + (n === nw.n ? ' today' : '') + '" data-n="' + n + '" tabindex="0"><td>' + fmtDay(n) + '</td><td>' + strip(n, A) + '</td><td class="num">' + (w ? hm(w) : '–') + '</td><td class="num">' + (l ? hm(l) : '–') + '</td><td>' + (fs ? '<span class="chip bad">' + fs + '</span>' : w ? '<span class="chip ok">OK</span>' : '') + '</td></tr>';
    }
    var st = standing(fortStart + 13, (fortStart + 14 - A.d0) * D);
    main.innerHTML = '<div class="wrap">' + (window.WDPlan ? window.WDPlan.tabs('fortnight') : '') + '<div class="datebar"><div class="day">' + fmtDay(fortStart) + ' to ' + fmtDay(fortStart + 13) + '</div><button class="btn" id="fp" aria-label="Back one week">‹ Week</button><button class="btn" id="fn" aria-label="Forward one week">Week ›</button></div>'
      + '<div class="tiles"><div class="tile"><b>' + hm(tw) + '</b><span>work in these 14 days</span></div><div class="tile"><b>' + hm(wk[0]) + ' / ' + hm(wk[1]) + '</b><span>work, week 1 / week 2</span></div><div class="tile"><b>' + hm(wl[0]) + ' / ' + hm(wl[1]) + '</b><span>long/night, week 1 / week 2</span></div><div class="tile"><b>' + tf + '</b><span>' + (tf === 1 ? 'issue' : 'issues') + ' found</span></div></div>'
      + '<div class="cols"><div class="card"><h3>Day by day</h3><div class="tw"><table><thead><tr><th>Day</th><th>Midnight to midnight</th><th class="num">Work</th><th class="num">Long/night</th><th>Check</th></tr></thead><tbody>' + rows + '</tbody></table></div><p class="hint" style="margin-top:10px">Tap a day to open its sheet. Days after today are your plan.</p></div>'
      + '<div class="card"><h3>Standing at the end of ' + fmtDay(fortStart + 13) + '</h3><div class="meters">' + metersHTML(st) + '</div></div></div></div>';
    on('fp', function () { fortStart -= 7; renderFort(); }); on('fn', function () { fortStart += 7; renderFort(); });
    main.querySelectorAll('.frow').forEach(function (r) { var go = function () { focus = +r.dataset.n; location.hash = '#diary'; }; r.addEventListener('click', go); r.addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); }); });
  }

  /* ---------- rules ---------- */
  function renderRules() {
    var opt = rulesOpt || optOf(nowBase().n), o = FM.OPTIONS[opt], R = FM.analyse(new Uint8Array(D), opt, cfgOf(opt)).rules;
    main.innerHTML = '<div class="wrap"><div class="datebar"><div class="day">' + esc(o.long) + '</div>' + optSelect('ropt', opt) + '</div><div class="cols"><div class="stack">'
      + '<div class="card rules"><h3>Limits (' + esc(o.table) + ', National Driver Work Diary)</h3><ul>' + R.map(function (r) { return '<li>' + esc(r.text) + '.</li>'; }).join('') + (opt === 'bfm' ? '<li>Take 24 continuous hours rest after no more than 84h work. A second 24 continuous hours rest is needed in the same 14 days.</li>' : '') + '</ul>'
      + (opt === 'custom' ? '<p class="note" style="margin-top:10px">Your real limits are on your AFM or ACA–Fatigue certificate. Enter them under More. This app only checks the numbers you enter.</p>' : '')
      + (opt === 'std2' || opt === 'bfm2' ? '<p class="note" style="margin-top:10px">Two-up: the app cannot tell stationary rest from rest in a moving sleeper berth. Check the 10 hour stationary rest yourself.</p>' : '') + '</div>'
      + '<div class="card rules"><h3>Words used</h3><ul><li><b>Night rest break:</b> 7 continuous hours of rest between 10pm and 8am, or 24 continuous hours of rest.</li><li><b>Long/night work:</b> any work between midnight and 6am, plus any work past 12 hours in a 24-hour period. An hour that is both is counted once.</li><li><b>Reset rest break:</b> 48 continuous hours of rest. You may need it when you change hours option.</li><li><b>Split rest (BFM only):</b> 6 continuous hours plus 2 continuous hours instead of 7. It is a defence for unplanned events only, so the app shows it in amber.</li></ul></div></div>'
      + '<div class="card rules"><h3>How this app counts</h3><ul><li>Time is counted in 15 minute blocks. Work is rounded up, rest is rounded down.</li><li>Periods shorter than 24 hours are counted forward from the end of any rest break.</li><li>A 24-hour period is counted forward from the end of a rest break of ' + (opt === 'std2' ? '5' : '7') + ' hours or more. A later long rest inside that period does not start it again early.</li><li>7, 14 and 28-day periods are counted forward from the end of the rest break named in the table (24 continuous hours, or a night rest break).</li><li>If the needed rest break is missing from a period, it is counted from the end of any rest break.</li><li>Periods overlap. Every limit must be met in every period.</li><li>No break sets a counter back to zero. Old work drops out only when the period it was counted in has ended.</li><li>All times use the time zone of your base (' + esc(S.settings.base) + '), also when you drive in another state.</li><li>Days with no entry are counted as rest.</li></ul></div></div></div>';
    document.getElementById('ropt').addEventListener('change', function (e) { rulesOpt = e.target.value; renderRules(); });
  }

  /* ---------- more ---------- */
  function renderMore() {
    var st = S.settings, c = st.custom;
    main.innerHTML = '<div class="wrap"><div class="cols"><div class="stack"><div class="card"><h3>Driver and base</h3><div class="form">'
      + '<label>Driver name<input id="s-name" value="' + esc(st.name) + '" autocomplete="name"></label><label>Usual number plate<input id="s-plate" value="' + esc(st.plate) + '" autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false"></label><label>Licence number (printed on diary pages)<input id="s-licence" inputmode="numeric" value="' + esc(st.licence || '') + '" autocomplete="off"></label>'
      + '<label>Base state (time zone)<select id="s-base">' + Object.keys(ZONES).map(function (z) { return '<option' + (z === st.base ? ' selected' : '') + '>' + z + '</option>'; }).join('') + '</select></label>'
      + '<label>Usual hours option' + optSelect('s-opt', st.opt) + '</label>'
      + '<label>Accreditation number (BFM, AFM, ACA)<input id="s-accr" value="' + esc(st.accr) + '" autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false"></label>'
      + '<label>Clock<select id="s-clock"><option value="24"' + (st.clock == 24 ? ' selected' : '') + '>24-hour (20:00)</option><option value="12"' + (st.clock == 12 ? ' selected' : '') + '>12-hour (8pm)</option></select></label>'
      + '<label>Alerts while the app is open<select id="s-alerts"><option value="1"' + (st.alerts !== false ? ' selected' : '') + '>On: warn 30 minutes before a limit, and when a rest is complete</option><option value="0"' + (st.alerts === false ? ' selected' : '') + '>Off</option></select></label>'
      + '<label>Smart tips<select id="s-tips"><option value="1"' + (st.tips !== false ? ' selected' : '') + '>On: suggest better rest and start times</option><option value="0"' + (st.tips === false ? ' selected' : '') + '>Off</option></select></label>'
      + (HOSTED ? '' : '<label>Screen<select id="s-theme"><option value="auto"' + (st.theme === 'auto' ? ' selected' : '') + '>Follow the phone</option><option value="night"' + (st.theme === 'night' ? ' selected' : '') + '>Dark from 7pm to 6am</option><option value="dark"' + (st.theme === 'dark' ? ' selected' : '') + '>Always dark</option><option value="light"' + (st.theme === 'light' ? ' selected' : '') + '>Light</option></select></label>') + '</div>'
      + (S.settings.base === 'WA' || S.settings.base === 'NT' ? '<p class="note warn" style="margin-top:12px">WA and the NT have their own fatigue rules. The limits in this app are the national (HVNL) rules, which apply in the other states and the ACT.</p>' : '') + '</div>'
      + (function () {
        var bk = (st.books || []).slice().sort(function (x, y) { return x.d < y.d ? 1 : -1; }), cur = pageOf(nowBase().n), rg = st.regos || {};
        var chips = function (kind, label) { var L = rg[kind] || []; return '<div><small class="hint">' + label + '</small><div class="regolist">' + (L.length ? L.map(function (x, i) { return '<span class="chip">' + esc(x) + '<button type="button" class="chipx" data-rgx="' + kind + ':' + i + '" aria-label="Remove ' + esc(x) + '">×</button></span>'; }).join('') : '<span class="hint">None saved yet. They are saved when you type them.</span>') + '</div></div>'; };
        return '<div class="card"><h3>My work diary book</h3><p class="hint">Enter the number of your paper work diary and the page you are on. The app then counts the page for every day after that, and prints both on the diary pages.</p>'
          + (cur ? '<p class="note" style="border-color:var(--work);color:var(--ink);margin:10px 0">Today: ' + (cur.no ? 'book ' + esc(cur.no) + ', ' : '') + 'page ' + cur.page + '</p>' : '')
          + '<div class="form" style="margin-top:10px"><label>Work diary number<input id="s-book" autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false" value="' + esc(bk.length ? bk[0].no || '' : '') + '"></label><label>Page number<input id="s-page" type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="off" placeholder="54"></label><label>That page is for this day<input id="s-pdate" type="date" value="' + keyOf(nowBase().n) + '"></label>'
          + '<label>Days with no work<select id="s-pskip"><option value="0"' + (st.pageSkip ? '' : ' selected') + '>Use a page every day</option><option value="1"' + (st.pageSkip ? ' selected' : '') + '>Do not use a page</option></select></label></div><div class="tools" style="margin-top:12px"><button class="btn pri" id="s-booksave">Save page number</button></div>'
          + (bk.length ? '<div class="stack" style="gap:6px;margin-top:12px">' + bk.map(function (x) { return '<div class="bookrow"><span>From ' + fmtDay(dayNum(x.d), true) + ': ' + (x.no ? 'book ' + esc(x.no) + ', ' : '') + 'page ' + x.p + '</span><button class="btn sm danger" data-bkx="' + x.d + '">Remove</button></div>'; }).join('') + '</div><p class="hint" style="margin-top:8px">New book, or the count is wrong? Save a new line with the right day and page. Days before it keep their old numbers.</p>' : '') + '</div>'
          + '<div class="card stack" style="gap:10px"><h3>Saved trucks and trailers</h3>' + chips('truck', 'Trucks') + chips('trailer', 'Trailers') + '</div>';
      })()
      + '<div class="card"><h3>AFM / ACH limits from your certificate</h3><div class="form">'
      + '<label>Most work in 24 hours (h)<input type="number" id="c-dayWork" min="1" max="24" step="0.25" value="' + c.dayWork + '"></label><label>Least continuous rest in 24 hours (h)<input type="number" id="c-dayRest" min="0" max="24" step="0.25" value="' + c.dayRest + '"></label>'
      + '<label>Most work in 7 days (h, 0 = none)<input type="number" id="c-w7" min="0" max="168" value="' + c.w7 + '"></label><label>Most work in 14 days (h, 0 = none)<input type="number" id="c-w14" min="0" max="336" value="' + c.w14 + '"></label>'
      + '<label>Most work in 28 days (h, 0 = none)<input type="number" id="c-w28" min="0" max="672" value="' + c.w28 + '"></label></div><p class="hint" style="margin-top:10px">Used only on days set to AFM / ACH.</p></div></div>'
      + '<div class="stack"><div class="card stack" style="gap:12px"><h3>Your records</h3><div class="sync" id="sync">' + syncText() + '</div>'
      + '<div class="tools"><button class="btn" id="exp">Save a backup file</button><button class="btn" id="copy">Copy backup</button><label class="btn" for="imp">Load a backup<input type="file" id="imp" accept=".json,application/json" hidden></label></div>'
      + '<div class="tools"><button class="btn" id="example">Load example fortnight</button><button class="btn danger" id="wipe">Delete all diary records</button>' + (document.querySelector('nav a[href="#rules"]') ? '' : '<button class="btn" id="gorules">Fatigue rules</button>') + '</div>'
      + '<p class="hint">' + Object.keys(S.days).filter(function (k) { return S.days[k].s && S.days[k].s.indexOf('w') >= 0; }).length + ' days with work recorded.</p></div>'
      + (window.WDDrive ? window.WDDrive.card() : '') + '<div class="card"><h3>About</h3><p class="note warn">This is a counting helper, not an approved Electronic Work Diary. You must still fill in your written work diary (or an NHVR approved EWD). Limits are outer limits: do not drive if you are tired.</p><p class="hint" style="margin-top:10px">Rules follow the NHVR National Driver Work Diary, version 1.4 (2026), Parts 3 and 4.</p>' + (HOSTED ? '' : '<p class="hint" style="margin-top:10px">Place lookup reads your location only when you tap “Find places near me”. Your position is sent to OpenStreetMap services to get nearby names. Map data © OpenStreetMap contributors.</p><p class="hint" style="margin-top:10px">Version ' + VERSION + '</p>') + '</div></div></div></div>';
    function bind(id, fn) { document.getElementById(id).addEventListener('change', function (e) { fn(e.target.value); touchSettings(); save(); render(); }); }
    bind('s-name', function (v) { st.name = v.trim(); }); bind('s-plate', function (v) { st.plate = v.trim().toUpperCase(); }); bind('s-licence', function (v) { st.licence = v.trim(); }); bind('s-base', function (v) { st.base = v; });
    bind('s-opt', function (v) { st.opt = v; }); bind('s-accr', function (v) { st.accr = v.trim().toUpperCase(); }); bind('s-clock', function (v) { st.clock = +v; }); bind('s-tips', function (v) { st.tips = v === '1'; }); bind('s-alerts', function (v) { st.alerts = v === '1'; if (st.alerts && window.Notification && Notification.permission === 'default') { try { Notification.requestPermission(); } catch (e) {} } });
    bind('s-pskip', function (v) { st.pageSkip = v === '1'; });
    on('s-booksave', function () {
      var no = document.getElementById('s-book').value.trim().toUpperCase(), p = parseInt(document.getElementById('s-page').value, 10), d = document.getElementById('s-pdate').value;
      if (!(p > 0)) return toast('Enter the page number.'); if (!d) return toast('Choose the day for that page.');
      st.books = (st.books || []).filter(function (x) { return x.d !== d; }).concat([{ d: d, no: no, p: p }]); touchSettings(); save(); render(); toast('Saved. Page ' + p + ' is ' + fmtDay(dayNum(d)) + '.');
    });
    main.querySelectorAll('[data-bkx]').forEach(function (b) { b.addEventListener('click', function () { st.books = (st.books || []).filter(function (x) { return x.d !== b.dataset.bkx; }); touchSettings(); save(); render(); }); });
    main.querySelectorAll('[data-rgx]').forEach(function (b) { b.addEventListener('click', function () { var q = b.dataset.rgx.split(':'); regos(q[0]).splice(+q[1], 1); touchSettings(); save(); render(); }); });
    if (!HOSTED) bind('s-theme', function (v) { st.theme = v; applyTheme(); });
    ['dayWork', 'dayRest', 'w7', 'w14', 'w28'].forEach(function (k) { bind('c-' + k, function (v) { c[k] = Math.max(0, +v || 0); }); });
    var json = function () { return JSON.stringify({ app: 'work-diary', v: 1, exported: new Date().toISOString(), settings: S.settings, days: S.days }); };
    on('exp', function () {
      var name = 'aps-logbook-backup-' + keyOf(nowBase().n) + '.json';
      if (!HOSTED && window.WDOffice) { window.WDOffice.exportData().catch(function () { return {}; }).then(function (x) { var full = JSON.parse(json()); full.office = x.office; full.files = x.files; var u2 = URL.createObjectURL(new Blob([JSON.stringify(full)], { type: 'application/json' })), l2 = document.createElement('a'); l2.href = u2; l2.download = name; document.body.appendChild(l2); l2.click(); l2.remove(); setTimeout(function () { URL.revokeObjectURL(u2); }, 60000); toast('Backup file saved. It includes your diary, paperwork and documents.'); S.settings.lastBackup = Date.now(); touchSettings(); save(); }); return; }
      if (!HOSTED) { try { var u = URL.createObjectURL(new Blob([json()], { type: 'application/json' })), l = document.createElement('a'); l.href = u; l.download = name; document.body.appendChild(l); l.click(); l.remove(); setTimeout(function () { URL.revokeObjectURL(u); }, 4000); toast('Backup file saved to your downloads.'); } catch (e) { backupDialog(json()); } return; }
      (window.claude && window.claude.use ? window.claude.use('downloads') : Promise.resolve(null)).then(function (dl) {
        if (!dl) throw { code: 'unavailable' };
        return dl.save({ filename: name, data: json() }).then(function () { toast('Backup saved.'); });
      }).catch(function (e) { if (e && e.code === 'declined') return; backupDialog(json()); });
    });
    on('copy', function () { var j = json(); (navigator.clipboard ? navigator.clipboard.writeText(j) : Promise.reject()).then(function () { toast('Backup copied. Paste it somewhere safe.'); }, function () { backupDialog(j); }); });
    document.getElementById('imp').addEventListener('change', function (e) {
      var f = e.target.files[0]; if (!f) return;
      f.text().then(function (t) { var p = JSON.parse(t); if (!p || !p.days) throw 0; snapshot(); for (var k in p.days) if (/^\d{4}-\d\d-\d\d$/.test(k) && p.days[k] && typeof p.days[k].s === 'string' && p.days[k].s.length === D) { S.days[k] = p.days[k]; S.days[k].t = Date.now(); dirty(dayNum(k)); } if (p.settings) { S.settings = merge({ settings: S.settings }, { settings: p.settings }).settings; touchSettings(); } save(); render(); if (p.office && window.WDOffice) return window.WDOffice.importData(p.office, p.files).then(function () { toast('Backup loaded, with paperwork and documents.'); }, function (er) { toast('Diary loaded. ' + er.message); }); toast('Backup loaded.'); })
        .catch(function () { toast('That file is not a work diary backup.'); });
    });
    on('gorules', function () { location.hash = '#rules'; });
    if (window.WDDrive) window.WDDrive.bind();
    on('example', function () { modal('<h2>Load example fortnight?</h2><p class="hint">This fills last week and this week with a BFM night roster: Monday to Thursday 8pm to 11am with rest breaks, and a short Friday shift. It replaces any entries on those 14 days.</p><div class="acts"><button class="btn" data-x>Cancel</button><button class="btn pri" id="ex-ok">Load example</button></div>', function (box, close) { box.querySelector('#ex-ok').addEventListener('click', function () { loadExample(); close(); focus = nowBase().n; location.hash = '#fortnight'; render(); }); }); });
    on('wipe', function () { modal('<h2>Delete all records?</h2><p class="hint">Every day\'s diary entries are removed. Invoices, forms, notes and documents are not touched. Save a backup first if you may need them.</p><div class="acts"><button class="btn" data-x>Cancel</button><button class="btn danger" id="w-ok">Delete everything</button></div>', function (box, close) { box.querySelector('#w-ok').addEventListener('click', function () { for (var k in S.days) { S.days[k] = { s: BLANK, t: Date.now() }; dirty(dayNum(k)); } S.live = null; undo = []; touchSettings(); save(); close(); render(); toast('All records deleted.'); }); }); });
  }
  function backupDialog(j) { modal('<h2>Your backup</h2><p class="hint">Copy all of this text and keep it somewhere safe.</p><textarea readonly style="min-height:160px" id="bk">' + esc(j) + '</textarea><div class="acts"><button class="btn pri" data-x>Done</button></div>', function (box) { var t = box.querySelector('#bk'); t.focus(); t.select(); }); }
  function loadExample() {
    snapshot(); var nw = nowBase(), mon = nw.n - ((dow(nw.n) + 6) % 7) - 7, k;
    for (k = 0; k < 14; k++) { var d = day(mon + k); d.s = BLANK; d.t = Date.now(); dirty(mon + k); if (k === 0) d.opt = 'bfm'; }
    for (var wk = 0; wk < 2; wk++) {
      for (k = 0; k < 4; k++) { var b = mon + wk * 7 + k; setAbsRange(b, 80, 104, 'w'); setAbsRange(b, 106, 126, 'w'); setAbsRange(b, 128, 140, 'w'); }
      var f = mon + wk * 7 + 4; setAbsRange(f, 80, 104, 'w'); setAbsRange(f, 106, 114, 'w');
    }
    save();
  }

  function applyTheme() { if (HOSTED) return; var t = S.settings.theme; if (t === 'night') { var hr = Math.floor(nowBase().i / 4); t = hr >= 19 || hr < 6 ? 'dark' : 'light'; } if (t === 'dark' || t === 'light') document.documentElement.setAttribute('data-theme', t); else document.documentElement.removeAttribute('data-theme'); }
  /* ---------- ui helpers ---------- */
  function modal(html, init) {
    var m = document.createElement('div'); m.className = 'modal'; m.innerHTML = '<div class="box" role="dialog" aria-modal="true">' + html + '</div>'; document.body.appendChild(m);
    function close() { m.remove(); }
    m.addEventListener('click', function (e) { if (e.target === m || e.target.hasAttribute('data-x')) close(); });
    m.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
    if (init) init(m.firstChild, close);
    var f = m.querySelector('input,button'); if (f) f.focus();
  }
  var toastT;
  function toast(msg, ms) { var t = document.getElementById('toast'); if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); } t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(function () { t.hidden = true; }, ms || 3800); }

  function route() { var h = (location.hash || '').replace('#', ''); view = !h && document.querySelector('nav a[href="#now"]') === document.querySelector('nav a') ? 'now' : ['diary', 'now', 'fortnight', 'rules', 'more'].concat(window.WDPlan ? ['plan'] : []).concat(window.WDOffice ? window.WDOffice.views : []).indexOf(h) >= 0 ? h : 'diary'; render(); main.scrollTop = 0; }
  window.addEventListener('hashchange', route);
  setInterval(function () { applyTheme(); checkAlerts(); var ch = tickLive(); if (view === 'now' && !document.querySelector('.modal')) renderNow(); else if (ch && view === 'diary' && !document.querySelector('.modal')) renderDiary(); }, 60000);
  if (!S.settings.firstUse) { S.settings.firstUse = Date.now(); try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {} }
  applyTheme(); tickLive(); route(); initSync();
  if (!HOSTED && !S.settings.setup) {
    if (S.settings.name || firstDay() !== null) { S.settings.setup = true; }
    else setTimeout(function () {
      modal('<h2>Set up your diary</h2><p class="hint">Four quick answers. You can change them later under More.</p><div class="form" style="grid-template-columns:1fr"><label>Your name<input id="su-name" autocomplete="name"></label><label>Base state (time zone)<select id="su-base">' + Object.keys(ZONES).map(function (z) { return '<option' + (z === S.settings.base ? ' selected' : '') + '>' + z + '</option>'; }).join('') + '</select></label><label>Hours option' + optSelect('su-opt', S.settings.opt) + '</label><label>Usual number plate<input id="su-plate" autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false"></label></div><div class="acts"><button class="btn" data-x>Later</button><button class="btn pri" id="su-ok">Save</button></div>', function (box, close) {
        box.querySelector('#su-ok').addEventListener('click', function () { var q = function (id) { return box.querySelector(id).value.trim(); }; S.settings.name = q('#su-name'); S.settings.base = q('#su-base'); S.settings.opt = q('#su-opt'); S.settings.plate = q('#su-plate'); S.settings.setup = true; touchSettings(); save(); close(); render(); });
      });
    }, 300);
  }
  if (!HOSTED) {
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}
    if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
      var hadSW = !!navigator.serviceWorker.controller;
      navigator.serviceWorker.register('service-worker.js').catch(function () {});
      navigator.serviceWorker.addEventListener('controllerchange', function () { if (hadSW) toast('App updated. Close and open it again to use the new version.'); });
    }
  }
  window.__wd = { S: S, loadExample: loadExample, render: render, pageOf: pageOf, pageSvg: pageSvg };
})();
