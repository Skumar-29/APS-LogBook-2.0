/* Smart tips: when work is about to start just short of a useful rest, say so before it is recorded.
   Popup for the 7-hour and 24-hour rests and for a start that breaks a rule; a quiet line for smaller tips. */
(function () {
  'use strict';
  var WD = window.WD, FM = window.FM, D = 96, hm = FM.hm, NEAR7 = 8, NEAR24 = 24;
  function keys(W, c) { var k = {}; FM.analyse(W, c.opt, c.cfg).findings.forEach(function (f) { if (!f.warn) k[f.rule + ':' + f.kind + ':' + f.at] = f; }); return k; }
  function firstNew(W, base, c) { var k = keys(W, c); for (var x in k) if (!base[x]) return k[x]; return null; }
  // n = day, a = slot in that day where work would start
  function check(n, a) {
    var c = WD.planCtx(); if (n < c.n) return null;
    var day0 = c.off + (n - c.n) * D, X = day0 + a, W = c.W; if (X >= W.length || X < 1 || W[X] || W[X - 1]) return null;
    var s = X; while (s > 0 && !W[s - 1]) s--; if (s === 0) return null; // no work before this rest in the records
    var L = X - s, major = c.opt === 'std2' ? 20 : c.opt === 'custom' && c.cfg ? Math.round((c.cfg.dayRest || 7) * 4) : c.opt === 'bfm2' ? 0 : 28;
    var at = function (abs) { return WD.absT(abs, n); }, out = function (kind, title, text, until, gain) { return { kind: kind, title: title, text: text, until: until, rel: until != null ? until - day0 : null, untilText: until != null ? at(until) : '', gain: gain || '' }; };
    var M = FM.meters(W, c.opt, c.cfg, X).list, by = {}; M.forEach(function (m) { by[m.id] = m; });
    // 1. starting now breaks a rule
    var base = keys(W, c), t = W.slice(); t[X] = 1; var bad = firstNew(t, base, c);
    if (bad) {
      var ok = null; for (var x = X + 1; x < X + 2 * D && x < W.length; x++) { if (W[x]) break; var t2 = W.slice(); t2[x] = 1; if (!firstNew(t2, base, c)) { ok = x; break; } }
      return out('warn', 'Starting at ' + WD.clock(a) + ' breaks a limit', bad.label + ': ' + bad.msg + (ok != null ? ' The earliest start that fits is ' + at(ok) + '.' : ''), ok);
    }
    // 2. close to 24 continuous hours
    var w = by.w14 || by.w28 || by.w7, need24 = (by.w7 && by.w7.rest && by.w7.rest.unit && /24h/.test(by.w7.rest.unit) && by.w7.rest.got < by.w7.rest.need) || (w && w.rest && /24h/.test(w.rest.unit || '') && w.rest.got < w.rest.need) || (by.r84 && by.r84.used > 0);
    if (L >= D - NEAR24 && L < D && need24) {
      var g = by.r84 ? 'Your 84-hour count starts again and it counts as one of your two 24-hour rests.' : 'It counts as your 24-hour rest for this period.';
      return out('popup', 'Almost a 24-hour rest', 'You have rested ' + hm(L) + '. Rest ' + hm(D - L) + ' more, until ' + at(s + D) + ', and this becomes a 24-hour rest.', s + D, g);
    }
    // 3. close to the major rest (7 hours, or 5 for two-up)
    var d = by.d24, owed = d && d.from != null && d.restDue != null;
    if (major && L >= major - NEAR7 && L < major && owed) {
      return out('popup', 'Almost a ' + hm(major) + ' rest', 'You have rested ' + hm(L) + '. Rest ' + hm(major - L) + ' more, until ' + at(s + major) + ', and this counts as your ' + hm(major) + ' continuous rest.', s + major, 'A new 24-hour period then starts when you begin work. If you start now, you still owe the full ' + hm(major) + ' rest by ' + at(d.restDue) + '.');
    }
    // 4. quiet tips
    var nights = (by.w14 || by.n7 || {}).nights;
    if (nights && nights.got < nights.need) {
      for (var k = Math.floor(s / D) - 1; k <= Math.floor(X / D); k++) { var na = Math.max(s, k * D + 88), ne = k * D + 128, have = Math.min(X, ne) - na; if (have >= 20 && have < 28 && na + 28 <= ne && na + 28 > X) return out('tip', '', 'Tip: rest until ' + at(na + 28) + ' (' + hm(na + 28 - X) + ' more) and this counts as a night rest break. You have ' + nights.got + ' of ' + nights.need + '.', na + 28); }
    }
    if (c.opt === 'bfm' && by.ln7 && by.ln7.max - by.ln7.used <= 48 && a < 24 && 24 - a <= 8) return out('tip', '', 'Tip: start at ' + WD.clock(24) + ' and this shift uses no night hours. You have ' + hm(Math.max(0, by.ln7.max - by.ln7.used)) + ' long/night left.', day0 + 24);
    if (by.r84 && by.r84.used >= 70 * 4) return out('tip', '', 'Tip: you have worked ' + hm(by.r84.used) + ' of 84h since your last 24-hour rest. Plan a 24-hour rest soon.', null);
    return null;
  }
  function ask(adv, startText, done) {
    var m = document.createElement('div'); m.className = 'modal'; var e = WD.esc, warn = adv.kind === 'warn';
    m.innerHTML = '<div class="box" role="alertdialog" aria-modal="true"><h2>' + e(adv.title) + '</h2><p style="margin:0">' + e(adv.text) + '</p>' + (adv.gain ? '<p class="note" style="margin:0">' + e(adv.gain) + '</p>' : '')
      + '<div class="acts" style="justify-content:stretch;flex-direction:column">' + (adv.until != null ? '<button class="btn pri" data-c="wait">' + (warn ? 'Start at ' : 'Keep resting until ') + e(adv.untilText) + '</button>' : '') + '<button class="btn' + (warn ? ' danger' : '') + '" data-c="go">Start work at ' + e(startText) + ' anyway</button><button class="btn" data-c="cancel">Cancel</button></div></div>';
    document.body.appendChild(m);
    m.addEventListener('click', function (ev) { var b = ev.target.closest('[data-c]'); if (!b) return; m.remove(); done(b.dataset.c); });
    var f = m.querySelector('button'); if (f) f.focus();
  }
  window.WDCoach = { check: function (n, a) { try { return check(n, a); } catch (e) { return null; } }, ask: ask };
})();
