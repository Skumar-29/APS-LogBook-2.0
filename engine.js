/* Fatigue rules engine. Time unit: one slot = 15 minutes. Timeline W: Uint8Array, 1 = work, 0 = rest.
   Source of rules: NHVR National Driver Work Diary v1.4 (2026), Part 3 (counting time) and Part 4 (Tables 1-5). */
(function (root) {
  'use strict';
  var D = 96, HR = 4, BIG = 1e9;

  var OPTIONS = {
    std: { id: 'std', name: 'Standard', long: 'Standard hours, solo driver', table: 'Table 1',
      short: [[22, 21], [32, 30], [44, 40]], dayMax: 48, dayRest: 28, major: 28 },
    bus: { id: 'bus', name: 'Standard Bus', long: 'Standard hours, bus and coach driver', table: 'Table 2',
      short: [[22, 21], [32, 30], [44, 40]], dayMax: 48, dayRest: 28, major: 28 },
    std2: { id: 'std2', name: 'Standard Two-up', long: 'Standard hours, two-up driver', table: 'Table 3',
      short: [[22, 21], [32, 30], [44, 40]], dayMax: 48, dayRest: 20, major: 20 },
    bfm: { id: 'bfm', name: 'BFM', long: 'Basic Fatigue Management, solo driver', table: 'Table 4',
      short: [[25, 24], [36, 34], [48, 44]], dayMax: 56, dayRest: 28, major: 28 },
    bfm2: { id: 'bfm2', name: 'BFM Two-up', long: 'Basic Fatigue Management, two-up driver', table: 'Table 5',
      short: [], dayMax: 56, dayRest: 0, major: 1 },
    custom: { id: 'custom', name: 'AFM / ACH', long: 'AFM, ACH or exemption hours (your certificate)', table: 'Certificate',
      short: [], dayMax: 56, dayRest: 28, major: 28 }
  };

  function hm(slots) { var h = Math.floor(slots / 4), m = (slots % 4) * 15; return h + 'h' + (m ? ' ' + m + 'm' : ''); }

  function buildCtx(Win) {
    // pad 29 blank days after the last work slot so windows that run into the future see rest
    var last = -1, i;
    for (i = Win.length - 1; i >= 0; i--) if (Win[i]) { last = i; break; }
    var N = Math.max(Win.length, last + 1) + 29 * D;
    var W = new Uint8Array(N); W.set(Win.subarray ? Win.subarray(0, Math.min(Win.length, N)) : Win);
    var pre = new Int32Array(N + 1);
    for (i = 0; i < N; i++) pre[i + 1] = pre[i] + W[i];
    var runs = [], starts = [];
    i = 0;
    if (W[0]) runs.push({ s: -BIG, e: 0, len: BIG });
    while (i < N) {
      if (!W[i]) {
        var s = i; while (i < N && !W[i]) i++;
        runs.push({ s: s === 0 ? -BIG : s, e: i === N ? BIG : i, len: (s === 0 || i === N) ? BIG : i - s });
      } else {
        starts.push({ i: i, run: runs.length - 1, rb: runs[runs.length - 1].len });
        while (i < N && W[i]) i++;
      }
    }
    if (W[N - 1]) runs.push({ s: N, e: BIG, len: BIG });
    // night rest breaks: 7 continuous hours between 10pm and 8am, or 24 continuous hours
    var nights = [];
    runs.forEach(function (r, ri) {
      r.nights = 0;
      var s = Math.max(r.s, -2 * D), e = Math.min(r.e, N + D);
      var k0 = Math.floor(s / D) - 1, k1 = Math.floor(e / D) + 1, found = 0;
      for (var k = k0; k <= k1; k++) {
        var a = Math.max(s, k * D + 88), b = Math.min(e, k * D + 128);
        if (b - a >= 28) { nights.push({ k: k, ps: a, pe: a + 28, run: ri }); found++; }
      }
      if (!found && r.len >= D) { nights.push({ k: Math.floor(s / D), ps: s, pe: s + D, run: ri }); found = 1; }
      r.nights = found;
    });
    return { W: W, N: N, pre: pre, runs: runs, starts: starts, nights: nights };
  }

  function work(c, a, b) { a = Math.max(0, Math.min(c.N, a)); b = Math.max(0, Math.min(c.N, b)); return b > a ? c.pre[b] - c.pre[a] : 0; }
  function restIn(c, a, b) { // clipped rest runs inside [a,b)
    var out = [];
    for (var i = 0; i < c.runs.length; i++) {
      var r = c.runs[i]; if (r.e <= a) continue; if (r.s >= b) break;
      var cs = Math.max(r.s, a), ce = Math.min(r.e, b);
      if (ce > cs) out.push({ s: cs, e: ce, len: ce - cs });
    }
    return out;
  }
  function maxRest(c, a, b) { var m = 0; restIn(c, a, b).forEach(function (r) { if (r.len > m) m = r.len; }); return m; }
  function nightsIn(c, a, b) { return c.nights.filter(function (n) { return n.ps >= a && n.pe <= b; }); }
  function hasPair(list) { var ks = {}; list.forEach(function (n) { ks[n.k] = 1; }); for (var k in ks) if (ks[+k + 1]) return true; return false; }
  function excess(c, a, b, max) { var out = [], n = 0, e = Math.min(b, c.N); for (var i = Math.max(a, 0); i < e; i++) if (c.W[i]) { n++; if (n > max) out.push(i); } return out; }
  function workSlotsIn(c, a, b) { var out = [], e = Math.min(b, c.N); for (var i = Math.max(a, 0); i < e; i++) if (c.W[i]) out.push(i); return out; }
  function count24(c, a, b) { var n = 0; restIn(c, a, b).forEach(function (r) { n += Math.floor(Math.min(r.len, b - a) / D); }); return n; }

  // BFM split rest: 6 continuous hours plus a separate 2 continuous hours in a 24-hour period (defence only)
  function splitPartner(c, run) {
    if (run.len < 24 || run.len >= 28) return false;
    for (var i = 0; i < c.runs.length; i++) {
      var r = c.runs[i]; if (r === run || r.len < 8) continue;
      if (r.s >= run.e - D && r.e <= run.e + D) return true;
    }
    return false;
  }

  // Anchors: periods are counted forward from the end of the relevant rest break. If the period holds no
  // such break, count from the end of any rest break (fallback).
  function anchors(c, P, isRelevantEnd, windowHasRelevant) {
    var out = [];
    c.starts.forEach(function (st) {
      if (isRelevantEnd(st)) out.push({ a: st.i, fb: false });
      else if (!windowHasRelevant(st.i, st.i + P)) out.push({ a: st.i, fb: true });
    });
    return out;
  }

  function rulesFor(optId, cfg) {
    var o = OPTIONS[optId] || OPTIONS.std, R = [];
    var dayMax = o.dayMax, dayRest = o.dayRest, major = o.major;
    if (optId === 'custom' && cfg) { dayMax = Math.round((cfg.dayWork || 14) * 4); dayRest = major = Math.round((cfg.dayRest || 7) * 4); }

    o.short.forEach(function (sr) {
      R.push({ id: 's' + sr[0], group: 'break', P: sr[0], max: sr[1], label: 'Short rest break',
        text: 'No more than ' + hm(sr[1]) + ' work in any ' + hm(sr[0]) + ' (at least ' + hm(sr[0] - sr[1]) + ' rest)',
        anchor: function (c) { return c.starts.map(function (st) { return { a: st.i, fb: false }; }); } });
    });

    var isMajor = function (c) { return function (st) { var r = c.runs[st.run]; return r.len >= major || (optId === 'bfm' && splitPartner(c, r)); }; };
    R.push({ id: 'd24', group: 'day', P: D, max: dayMax, label: '24-hour period',
      text: 'No more than ' + hm(dayMax) + ' work in any 24 hours' + (dayRest ? ', with ' + hm(dayRest) + ' continuous rest' : ''),
      anchor: function (c) { return anchors(c, D, isMajor(c), function (a, b) { return major <= 1 ? true : maxRest(c, a, b) >= major; }); },
      rest: !dayRest ? null : function (c, a, b) {
        var m = maxRest(c, a, b);
        if (m >= dayRest) return null;
        if (optId === 'bfm') {
          var rs = restIn(c, a, b), six = false, two = 0;
          rs.sort(function (x, y) { return y.len - x.len; });
          if (rs.length && rs[0].len >= 24) { six = true; for (var i = 1; i < rs.length; i++) if (rs[i].len >= 8) two++; }
          if (six && two) return { at: b - dayRest, warn: true, msg: 'Split rest (6h + 2h) in this 24-hour period. This is only a defence if it was unplanned and you had 7 continuous hours rest in the previous 24 hours.' };
        }
        return { at: b - dayRest, msg: 'No ' + hm(dayRest) + ' continuous rest in this 24-hour period (longest rest was ' + hm(m) + ').' };
      } });

    var is24 = function (c) { return function (st) { return st.rb >= D; }; };
    var has24 = function (c) { return function (a, b) { return maxRest(c, a, b) >= D; }; };
    var isNight = function (c) { return function (st) { return c.runs[st.run].nights > 0; }; };
    var hasNight = function (c) { return function (a, b) { return nightsIn(c, a, b).length > 0; }; };
    var is24orNight = function (c) { return function (st) { return st.rb >= D || c.runs[st.run].nights > 0; }; };
    var has24orNight = function (c) { return function (a, b) { return maxRest(c, a, b) >= D || nightsIn(c, a, b).length > 0; }; };
    function nightRule(need, pair) {
      return function (c, a, b) {
        var ns = nightsIn(c, a, b);
        if (ns.length >= need && (!pair || hasPair(ns))) return null;
        return { at: b - 1, noFlag: true, msg: ns.length < need
          ? 'Only ' + ns.length + ' of ' + need + ' night rest breaks in this period.'
          : need + ' night rest breaks taken, but no 2 on consecutive days.' };
      };
    }
    function nightMeter(need, pair) { return function (c, a, b, T) { var ns = nightsIn(c, a, Math.min(b, T)); return { got: ns.length, need: need, pair: pair ? hasPair(ns) : null }; }; }

    if (optId === 'std') {
      R.push({ id: 'w7', group: 'week', P: 7 * D, max: 72 * HR, label: '7-day period', text: 'No more than 72h work in any 7 days, with 24 continuous hours rest',
        anchor: function (c) { return anchors(c, 7 * D, is24(c), has24(c)); },
        rest: function (c, a, b) { return maxRest(c, a, b) >= D ? null : { at: b - D, msg: 'No 24 continuous hours rest in this 7-day period.' }; },
        restMeter: function (c, a, b, T) { return { got: Math.min(1, count24(c, a, Math.min(b, T))), need: 1, unit: '24h rest' }; } });
      R.push({ id: 'w14', group: 'fort', P: 14 * D, max: 144 * HR, label: '14-day period', text: 'No more than 144h work in any 14 days, with 4 night rest breaks (2 on consecutive days)',
        anchor: function (c) { return anchors(c, 14 * D, isNight(c), hasNight(c)); }, rest: nightRule(4, true), nightMeter: nightMeter(4, true) });
    }
    if (optId === 'bus') {
      R.push({ id: 'n7', group: 'week', P: 7 * D, max: null, label: '7-day period', text: '6 night rest breaks in any 7 days',
        anchor: function (c) { return anchors(c, 7 * D, isNight(c), hasNight(c)); }, rest: nightRule(6, false), nightMeter: nightMeter(6, false) });
      R.push({ id: 'w28', group: 'month', P: 28 * D, max: 288 * HR, label: '28-day period', text: 'No more than 288h work in any 28 days, with 4 x 24 continuous hours rest',
        anchor: function (c) { return anchors(c, 28 * D, is24(c), has24(c)); },
        rest: function (c, a, b) { var n = count24(c, a, b); return n >= 4 ? null : { at: b - (4 - n) * D, msg: 'Only ' + n + ' of 4 rest breaks of 24 continuous hours in this 28-day period.' }; },
        restMeter: function (c, a, b, T) { return { got: Math.min(4, count24(c, a, Math.min(b, T))), need: 4, unit: '24h rests' }; } });
    }
    if (optId === 'std2' || optId === 'bfm2') {
      var bf = optId === 'bfm2', PL = bf ? 82 * HR : 52 * HR;
      R.push({ id: 'r10', group: 'day', P: PL, max: null, label: (bf ? '82' : '52') + '-hour period', text: '10 continuous hours stationary rest in any ' + (bf ? '82' : '52') + ' hours',
        anchor: function (c) { return anchors(c, PL, function (st) { return st.rb >= 40; }, function (a, b) { return maxRest(c, a, b) >= 40; }); },
        rest: function (c, a, b) { return maxRest(c, a, b) >= 40 ? null : { at: b - 40, msg: 'No 10 continuous hours rest in this ' + (bf ? '82' : '52') + '-hour period.' }; },
        restMeter: function (c, a, b, T) { return { got: maxRest(c, a, Math.min(b, T)) >= 40 ? 1 : 0, need: 1, unit: '10h rest' }; } });
      var blocksOk = function (c, a, b) {
        var rs = restIn(c, a, b).sort(function (x, y) { return y.len - x.len; });
        if (!rs.length || rs[0].len < D) return 'No 24 continuous hours rest in this 7-day period.';
        var sum = rs[0].len - D >= 28 ? rs[0].len - D : 0;
        for (var i = 1; i < rs.length; i++) if (rs[i].len >= 28) sum += rs[i].len;
        return sum >= D ? null : 'Only ' + hm(sum) + ' of the extra 24h rest in blocks of 7h or more.';
      };
      R.push({ id: 'w7', group: 'week', P: 7 * D, max: (bf ? 70 : 60) * HR, label: '7-day period', text: 'No more than ' + (bf ? 70 : 60) + 'h work in any 7 days, with 24 continuous hours rest and another 24h rest in blocks of 7h or more',
        anchor: function (c) { return anchors(c, 7 * D, is24(c), has24(c)); },
        rest: function (c, a, b) { var m = blocksOk(c, a, b); return m ? { at: b - D, msg: m } : null; },
        restMeter: function (c, a, b, T) { return { got: Math.min(1, count24(c, a, Math.min(b, T))), need: 1, unit: '24h rest' }; } });
      R.push({ id: 'w14', group: 'fort', P: 14 * D, max: (bf ? 140 : 120) * HR, label: '14-day period', text: 'No more than ' + (bf ? 140 : 120) + 'h work in any 14 days, with 4 night rest breaks' + (bf ? '' : ' (2 on consecutive days)'),
        anchor: function (c) { return anchors(c, 14 * D, isNight(c), hasNight(c)); }, rest: nightRule(4, !bf), nightMeter: nightMeter(4, !bf) });
    }
    if (optId === 'bfm') {
      R.push({ id: 'ln7', group: 'week', P: 7 * D, max: 36 * HR, ln: true, label: 'Long/night work', text: 'No more than 36h long/night work in any 7 days',
        anchor: function (c) { return anchors(c, 7 * D, is24orNight(c), has24orNight(c)); } });
      R.push({ id: 'w14', group: 'fort', P: 14 * D, max: 144 * HR, label: '14-day period', text: 'No more than 144h work in any 14 days, with 2 x 24 continuous hours rest and 4 night rest breaks (2 on consecutive days)',
        anchor: function (c) { return anchors(c, 14 * D, is24orNight(c), has24orNight(c)); },
        rest: function (c, a, b) { var n = count24(c, a, b); return n >= 2 ? null : { at: b - (2 - n) * D, msg: 'Only ' + n + ' of 2 rest breaks of 24 continuous hours in this 14-day period.' }; },
        restMeter: function (c, a, b, T) { return { got: Math.min(2, count24(c, a, Math.min(b, T))), need: 2, unit: '24h rests' }; },
        nightMeter: nightMeter(4, true), extra: [nightRule(4, true)],
        r84: true });
    }
    if (optId === 'custom' && cfg) {
      [[7, cfg.w7, 'week'], [14, cfg.w14, 'fort'], [28, cfg.w28, 'month']].forEach(function (x) {
        if (!x[1]) return;
        R.push({ id: 'w' + x[0], group: x[2], P: x[0] * D, max: Math.round(x[1] * 4), label: x[0] + '-day period', text: 'No more than ' + x[1] + 'h work in any ' + x[0] + ' days (from your certificate)',
          anchor: function (c) { return anchors(c, x[0] * D, is24(c), has24(c)); } });
      });
    }
    return R;
  }

  // long/night work time: work between midnight and 6am, or work beyond 12 hours in a 24-hour period
  function longNight(c, dayRule) {
    var ln = new Uint8Array(c.N), i;
    for (i = 0; i < c.N; i++) if (c.W[i] && (i % D) < 24) ln[i] = 1;
    dayRule.anchor(c).forEach(function (an) { excess(c, an.a, an.a + D, 48).forEach(function (s) { ln[s] = 2; }); });
    for (i = 0; i < c.N; i++) if (ln[i] === 2 && (i % D) < 24) ln[i] = 1; // night slots stay "night"
    var pre = new Int32Array(c.N + 1);
    for (i = 0; i < c.N; i++) pre[i + 1] = pre[i] + (ln[i] ? 1 : 0);
    c.ln = ln; c.lnPre = pre;
  }
  function lnExcess(c, a, b, max) { var out = [], n = 0, e = Math.min(b, c.N); for (var i = Math.max(a, 0); i < e; i++) if (c.ln[i]) { n++; if (n > max) out.push(i); } return out; }
  function lnCount(c, a, b) { a = Math.max(0, Math.min(c.N, a)); b = Math.max(0, Math.min(c.N, b)); return b > a ? c.lnPre[b] - c.lnPre[a] : 0; }

  function analyse(Win, optId, cfg) {
    var c = buildCtx(Win), R = rulesFor(optId, cfg), F = [], seen = {};
    var flags = new Uint8Array(c.N);
    longNight(c, R.filter(function (r) { return r.id === 'd24'; })[0]);
    function add(f) {
      var key = f.rule + ':' + f.kind + ':' + f.at; if (seen[key]) return; seen[key] = 1; F.push(f);
      (f.slots || []).forEach(function (s) { if (s < c.N) flags[s] = Math.max(flags[s], f.warn ? 1 : 2); });
    }
    R.forEach(function (r) {
      r.anchor(c).forEach(function (an) {
        var a = an.a, b = a + r.P;
        if (r.max != null) {
          var ex = r.ln ? lnExcess(c, a, b, r.max) : excess(c, a, b, r.max);
          if (ex.length) {
            var used = r.ln ? lnCount(c, a, b) : work(c, a, b);
            add({ rule: r.id, group: r.group, label: r.label, kind: 'work', from: a, to: b, at: ex[0], slots: ex, used: used, max: r.max,
              msg: hm(used) + (r.ln ? ' long/night work' : ' work') + ' in this ' + (r.P < D ? hm(r.P) : r.P === D ? '24-hour' : (r.P / D) + '-day') + ' period. The limit is ' + hm(r.max) + '.' });
          }
        }
        var checks = (r.rest ? [r.rest] : []).concat(r.extra || []);
        checks.forEach(function (fn, ci) {
          var v = fn(c, a, b); if (!v) return;
          add({ rule: r.id + (ci ? 'n' : ''), group: r.group, label: r.label, kind: 'rest', from: a, to: b, at: v.at, warn: !!v.warn,
            slots: v.noFlag ? [] : workSlotsIn(c, v.at, b), msg: v.msg });
        });
        if (r.r84) { // 24 continuous hours rest must come after no more than 84 hours work
          var first = null; restIn(c, a, b).some(function (x) { if (x.len >= D) { first = x; return true; } return false; });
          var ex84 = excess(c, a, first ? first.s : b, 84 * HR);
          if (ex84.length) add({ rule: 'r84', group: 'fort', label: '84-hour rule', kind: 'work', from: a, to: b, at: ex84[0], slots: ex84, used: work(c, a, first ? first.s : b), max: 84 * HR,
            msg: 'More than 84h work before a rest break of 24 continuous hours.' });
        }
      });
    });
    F.sort(function (x, y) { return x.at - y.at; });
    return { findings: F, flags: flags, ln: c.ln, ctx: c, rules: R };
  }

  // Standing at time T (records after T are ignored)
  function meters(Win, optId, cfg, T) {
    var W = new Uint8Array(Math.max(Win.length, T + 1)); W.set(Win.subarray(0, Math.min(Win.length, T)));
    var c = buildCtx(W), R = rulesFor(optId, cfg), out = [];
    var d24 = R.filter(function (r) { return r.id === 'd24'; })[0];
    longNight(c, d24);
    R.forEach(function (r) {
      var act = r.anchor(c).filter(function (an) { return an.a <= T && T < an.a + r.P; });
      var m = { id: r.id, group: r.group, label: r.label, text: r.text, P: r.P, max: r.max, used: 0, from: null, to: null, ln: !!r.ln };
      if (act.length) {
        var worst = act[0], wu = -1;
        act.forEach(function (an) { var u = r.ln ? lnCount(c, an.a, T) : work(c, an.a, T); if (u > wu) { wu = u; worst = an; } });
        m.used = wu; m.from = worst.a; m.to = worst.a + r.P;
        var old = act[0]; m.restFrom = old.a; m.restTo = old.a + r.P;
        if (r.id === 'd24' && r.rest) {
          var due = null; act.forEach(function (an) { if (maxRest(c, an.a, T) < d24Rest(r, optId, cfg)) { var x = an.a + D - d24Rest(r, optId, cfg); if (due == null || x < due) due = x; } });
          m.restDue = due; m.restLen = d24Rest(r, optId, cfg);
        }
        if (r.restMeter) m.rest = r.restMeter(c, old.a, old.a + r.P, T);
        if (r.nightMeter) m.nights = r.nightMeter(c, old.a, old.a + r.P, T);
      } else {
        if (r.restMeter) m.rest = { got: 0, need: r.restMeter(c, 0, 0, 0).need, unit: r.restMeter(c, 0, 0, 0).unit, idle: true };
        if (r.nightMeter) m.nights = { got: 0, need: r.nightMeter(c, 0, 0, 0).need, pair: r.nightMeter(c, 0, 0, 0).pair, idle: true };
      }
      out.push(m);
    });
    if (optId === 'bfm') {
      var lastEnd = 0;
      c.runs.forEach(function (x) { if (x.len >= D && x.e <= T && x.e > lastEnd) lastEnd = x.e; if (x.len >= D && x.s < T && x.e >= T) lastEnd = T; });
      out.push({ id: 'r84', group: 'fort', label: 'Work since last 24h rest', text: 'Take 24 continuous hours rest after no more than 84h work', P: 0, max: 84 * HR, used: work(c, lastEnd, T), from: lastEnd, to: null });
    }
    var cur = T > 0 && c.W[T - 1] ? 1 : 0, since = T;
    while (since > 0 && (c.W[since - 1] ? 1 : 0) === cur) since--;
    return { list: out, working: !!cur, since: since, ctx: c };
  }
  function d24Rest(r, optId, cfg) { return optId === 'custom' && cfg ? Math.round((cfg.dayRest || 7) * 4) : OPTIONS[optId].dayRest; }

  function keyset(res) { var k = {}; res.findings.forEach(function (f) { if (!f.warn) k[f.rule + ':' + f.kind + ':' + f.at] = f; }); return k; }
  // How long can I keep working from T, and when can I start again?
  function forecast(Win, optId, cfg, T) {
    var base = new Uint8Array(T + 60 * HR + 2 * D); base.set(Win.subarray(0, Math.min(Win.length, T)));
    var b0 = keyset(analyse(base, optId, cfg));
    function firstNew(W) { var k = keyset(analyse(W, optId, cfg)); for (var x in k) if (!b0[x]) return k[x]; return null; }
    var W = base.slice(), can = 0, stop = null, i;
    for (i = 0; i < 15 * HR; i++) { W[T + i] = 1; var f = firstNew(W); if (f) { stop = f; break; } can++; }
    var restart = null, why = stop;
    if (can === 0) {
      for (i = 1; i <= 2 * D; i++) { var W2 = base.slice(); W2[T + i] = 1; if (!firstNew(W2)) { restart = T + i; break; } }
    }
    return { can: can, stop: stop, restart: restart, why: why };
  }

  root.FM = { OPTIONS: OPTIONS, analyse: analyse, meters: meters, forecast: forecast, hm: hm, D: D };
})(typeof window !== 'undefined' ? window : globalThis);
