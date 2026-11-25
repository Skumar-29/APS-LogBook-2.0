/* Paperwork: invoices, safe driving forms, notes and documents.
   Calculations, validation and the PDF pages come from the original APS Logbook code in aps-core.js. */
(function () {
  'use strict';
  var WD = window.WD, esc = WD.esc, main = WD.main, toast = WD.toast, S = WD.S;
  var APS = null, O = null, ready = null, db = null;
  var ui = { inv: '', invSearch: '', form: '', vehicle: 'pm', reviewed: false, saveSig: false, undo: null, noteSearch: '', shown: {}, docSearch: '', open: {} };
  var TABS = [['invoices', 'Invoices'], ['forms', 'Forms'], ['notes', 'Notes'], ['documents', 'Documents']];

  /* ---------- storage (IndexedDB) ---------- */
  function idb() {
    if (db) return Promise.resolve(db);
    return new Promise(function (res, rej) {
      var r = indexedDB.open('workdiary-office', 1);
      r.onupgradeneeded = function () { r.result.createObjectStore('kv'); r.result.createObjectStore('files'); };
      r.onsuccess = function () { db = r.result; res(db); }; r.onerror = function () { rej(r.error); };
    });
  }
  function tx(store, mode, fn) { return idb().then(function (d) { return new Promise(function (res, rej) { var t = d.transaction(store, mode), q = fn(t.objectStore(store)); t.oncomplete = function () { res(q && q.result); }; t.onerror = t.onabort = function () { rej(t.error || Error('Could not save on this device.')); }; }); }); }
  var kvGet = function (k) { return tx('kv', 'readonly', function (s) { return s.get(k); }); }, kvPut = function (k, v) { return tx('kv', 'readwrite', function (s) { return s.put(v, k); }); };
  var fileGet = function (h) { return tx('files', 'readonly', function (s) { return s.get(h); }); }, filePut = function (h, v) { return tx('files', 'readwrite', function (s) { return s.put(v, h); }); }, fileDel = function (h) { return tx('files', 'readwrite', function (s) { return s.delete(h); }); };

  function blank() {
    return { driverId: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())), contact: '', invoices: [],
      invoiceSettings: { profile: {}, nextInvoiceNo: 1, types: ['BD', 'RT', 'BT', 'AB', 'C/O'], cities: ['MEL', 'BNE', 'SYD', 'ADL', 'PER', 'DAR', 'HOB', 'CBR'], miscItems: ['Pick-up', 'Delivery', 'Waiting'], typeRates: {}, miscItemRates: {} },
      forms: [], formDefaults: {}, notes: [], documents: [], routeMap: {}, audit: [], stamp: {}, deleted: {}, metaT: 0 };
  }
  function loadScript(src) { return new Promise(function (res, rej) { if (window.APS) return res(); var s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = function () { rej(Error('Paperwork could not load. Open the app online once so it can finish its offline download.')); }; document.head.appendChild(s); }); }
  function load() {
    if (!ready) ready = Promise.all([loadScript('aps-core.js'), kvGet('office').catch(function () { return null; })]).then(function (r) {
      APS = window.APS; var b = blank(), st = r[1] || {};
      O = Object.assign(b, st); O.invoiceSettings = Object.assign(blank().invoiceSettings, st.invoiceSettings || {});
      attach(O);
    });
    ready.catch(function () { ready = null; });
    return ready;
  }
  // The original code expects a driver profile on the workspace. Build it from this app's settings.
  function attach(w) {
    var opt = WD.optOf(WD.nowBase().n), st = WD.S.settings;
    w.profile = { id: w.driverId, name: st.name || '', licence: '', licenceExpiry: '', contact: w.contact || '', base: st.base, zone: WD.ZONES[st.base] || 'Australia/Melbourne', operation: 'HVNL',
      scheme: opt === 'bfm' || opt === 'bfm2' ? 'BFM' : opt === 'custom' ? 'AFM' : 'Standard', twoUp: false, coDriver: '', coLicence: '', coScheme: 'Standard', coBase: '', operator: '', certificate: st.accr || '', certificateExpiry: '', recordKeeper: '', recordAddress: '', effectiveFrom: '', signature: '', logo: '' };
    w.profileHistory = []; w.ruleChanges = []; w.days = {};
    return w;
  }
  function stored(w) { var c = Object.assign({}, w); delete c.profile; delete c.profileHistory; delete c.ruleChanges; delete c.days; if (c.audit.length > 300) c.audit = c.audit.slice(-300); return c; }
  // Changes are made on a copy and kept only if nothing fails, like the original app.
  function mutate(fn) {
    var draft = attach(structuredClone(stored(O)));
    return Promise.resolve().then(function () { return fn(draft); }).then(function (v) { track(O, draft); O = draft; return kvPut('office', stored(O)).then(function () { if (window.WDDrive) window.WDDrive.changed(); return v; }); })
      .catch(function (e) { toast(e && e.message ? e.message : 'That could not be saved.'); throw e; });
  }
  // Remember when each record changed or was deleted, so two devices can be merged safely.
  var COLS = ['invoices', 'forms', 'notes', 'documents'];
  function metaOf(w) { return JSON.stringify([w.invoiceSettings, w.formDefaults, w.routeMap, w.contact]); }
  function track(before, after) {
    var now = Date.now(); after.stamp = after.stamp || {}; after.deleted = after.deleted || {};
    COLS.forEach(function (c) {
      var old = {}; before[c].forEach(function (r) { old[r.id] = r; });
      after[c].forEach(function (r) { if (!old[r.id] || JSON.stringify(old[r.id]) !== JSON.stringify(r)) after.stamp[r.id] = now; delete old[r.id]; });
      Object.keys(old).forEach(function (id) { after.deleted[id] = now; delete after.stamp[id]; });
    });
    if (metaOf(before) !== metaOf(after)) after.metaT = now;
  }
  function stampOf(w, r) { return (w.stamp && w.stamp[r.id]) || Date.parse(r.updatedAt || r.addedAt || r.createdAt || '') || 0; }
  function rekey(w, id) { if (!id || w.driverId === id) return; var old = w.driverId; w.forms.forEach(function (f) { if (f.driverId === old) f.driverId = id; }); if (w.formDefaults && w.formDefaults[old]) { if (!w.formDefaults[id]) w.formDefaults[id] = w.formDefaults[old]; delete w.formDefaults[old]; } w.driverId = id; }
  function mergeOffice(L, R) { // newest copy of each record wins; a delete wins over an older edit
    var out = structuredClone(L), rem = structuredClone(R), k;
    rem.stamp = rem.stamp || {}; rem.deleted = rem.deleted || {}; out.stamp = out.stamp || {}; out.deleted = out.deleted || {};
    if (rem.driverId && rem.driverId !== out.driverId) { var canon = rem.driverId < out.driverId ? rem.driverId : out.driverId; rekey(out, canon); rekey(rem, canon); }
    for (k in rem.deleted) if (!(out.deleted[k] >= rem.deleted[k])) out.deleted[k] = rem.deleted[k];
    COLS.forEach(function (c) {
      var by = {}, order = [];
      (out[c] || []).forEach(function (r) { by[r.id] = { r: r, t: stampOf(out, r) }; order.push(r.id); });
      (rem[c] || []).forEach(function (r) { var t = stampOf(rem, r); if (!by[r.id]) { by[r.id] = { r: r, t: t }; order.push(r.id); } else if (t > by[r.id].t) by[r.id] = { r: r, t: t }; });
      out[c] = order.filter(function (id) { return !(out.deleted[id] >= by[id].t); }).map(function (id) { out.stamp[id] = by[id].t; return by[id].r; });
    });
    var maxNo = Math.max(out.invoiceSettings.nextInvoiceNo || 1, (rem.invoiceSettings || {}).nextInvoiceNo || 1);
    if ((rem.metaT || 0) > (out.metaT || 0)) { out.invoiceSettings = Object.assign(blank().invoiceSettings, rem.invoiceSettings || {}); out.formDefaults = rem.formDefaults || {}; out.routeMap = rem.routeMap || {}; out.contact = rem.contact || ''; out.metaT = rem.metaT; }
    out.invoiceSettings.nextInvoiceNo = maxNo;
    return out;
  }
  var quiet = function (p) { return p.catch(function () {}); };
  function diaryDays() { // work and rest changes from the diary, in the shape the original trip import reads
    var days = {}, D = WD.S.days;
    Object.keys(D).forEach(function (k) {
      var d = D[k], ev = d.ev || {}, ch = {};
      Object.keys(ev).forEach(function (sl) { if (ev[sl] && (ev[sl].p || ev[sl].o)) ch[sl] = { slot: +sl, location: ev[sl].p || '', odometer: String(ev[sl].o || '').replace(/[,\s]/g, ''), vehicle: '' }; });
      if (Object.keys(ch).length) days[k] = { date: k, revision: d.t || 0, vehicle: d.plate || WD.S.settings.plate || '', changes: ch };
    });
    return days;
  }
  function withDays(w) { var c = Object.assign({}, w); c.days = diaryDays(); return c; }

  /* ---------- small UI helpers ---------- */
  function fld(id, label, value, o) {
    o = o || {}; var v = esc(value == null ? '' : value), dis = o.disabled ? ' disabled' : '', h;
    if (o.options) h = '<select id="' + id + '"' + dis + '>' + o.options.map(function (x) { var a = Array.isArray(x) ? x : [x, x]; return '<option value="' + esc(a[0]) + '"' + (String(a[0]) === String(value == null ? '' : value) ? ' selected' : '') + '>' + esc(a[1]) + '</option>'; }).join('') + '</select>';
    else if (o.type === 'textarea') h = '<textarea id="' + id + '"' + dis + '>' + v + '</textarea>';
    else h = '<input id="' + id + '" type="' + (o.type === 'number' ? 'text" inputmode="decimal' : o.type === 'digits' ? 'text" inputmode="numeric" pattern="[0-9]*' : o.type === 'tel' ? 'tel' : o.type || 'text') + '" value="' + v + '"' + (o.list ? ' list="' + o.list + '"' : '') + (/licence$/.test(id) ? ' inputmode="numeric"' : /^fv-(pm|t[123]|accreditation)$/.test(id) ? ' autocapitalize="characters" autocorrect="off" spellcheck="false"' : '') + dis + ' autocomplete="off">';
    return '<label' + (o.cls ? ' class="' + o.cls + '"' : '') + '>' + esc(label) + h + (o.after || '') + '</label>';
  }
  function chk(id, label, value, dis) { return '<label class="chk"><input type="checkbox" id="' + id + '"' + (value ? ' checked' : '') + (dis ? ' disabled' : '') + '> ' + esc(label) + '</label>'; }
  function partOn(v) { var p = (WD.S.settings.parts || {}); return !((v === 'invoices' && p.inv === false) || (v === 'forms' && p.forms === false)); }
  function tabs(view) { return '<div class="subnav" role="tablist">' + TABS.filter(function (t) { return partOn(t[0]); }).map(function (t) { return '<a href="#' + t[0] + '"' + (t[0] === view ? ' aria-current="page"' : '') + '>' + t[1] + '</a>'; }).join('') + '</div>'; }
  function on(id, ev, fn) { var e = document.getElementById(id); if (e) e.addEventListener(ev, fn); }
  function click(id, fn) { on(id, 'click', fn); }
  function each(sel, fn) { main.querySelectorAll(sel).forEach(fn); }
  function draw(view) {
    if (!partOn(view)) { var nx = TABS.filter(function (t) { return partOn(t[0]); })[0]; location.hash = '#' + nx[0]; return; } // re-render and keep the place: focus, scroll and which sections are open
    var act = document.activeElement && document.activeElement.id, top = main.scrollTop;
    main.querySelectorAll('details[id]').forEach(function (d) { ui.open[d.id] = d.open; });
    VIEWS[view]();
    main.querySelectorAll('details[id]').forEach(function (d) { if (ui.open[d.id] != null) d.open = ui.open[d.id]; });
    main.scrollTop = top;
    if (act) { var e = document.getElementById(act); if (e && e.focus) e.focus({ preventScroll: true }); }
  }
  function later(view) { setTimeout(function () { if (current === view) draw(view); }, 0); }
  function sheet(title, body, init, cls) {
    var m = document.createElement('div'); m.className = 'modal sheetm ' + (cls || ''); m.innerHTML = '<div class="box" role="dialog" aria-modal="true" aria-label="' + esc(title) + '"><div class="sheet-hd"><h2>' + esc(title) + '</h2><button class="btn sm" data-close>Close</button></div><div class="sheet-bd"></div></div>';
    document.body.appendChild(m); var bd = m.querySelector('.sheet-bd'), closers = [];
    function close() { closers.forEach(function (f) { f(); }); m.remove(); }
    m.querySelector('[data-close]').addEventListener('click', close);
    m.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
    bd.innerHTML = body || ''; if (init) init(bd, close, function (f) { closers.push(f); });
    return close;
  }
  function confirmBox(title, text, label, fn) {
    sheet(title, '<p>' + esc(text) + '</p><div class="tools"><button class="btn" id="cf-no">Cancel</button><button class="btn danger" id="cf-yes">' + esc(label) + '</button></div>', function (bd, close) {
      bd.querySelector('#cf-no').addEventListener('click', close);
      bd.querySelector('#cf-yes').addEventListener('click', function () { Promise.resolve(fn()).then(close, function () {}); });
    }, 'small');
  }
  function download(blob, name) { var url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(url); }, 60000); }
  function shareFile(blob, name, msg) {
    var file = new File([blob], name, { type: blob.type });
    if (navigator.canShare && navigator.canShare({ files: [file] })) return navigator.share(msg ? { files: [file], title: msg.subject, text: msg.text } : { files: [file], title: name }).catch(function (e) { if (!e || e.name !== 'AbortError') throw e; });
    download(blob, name); return Promise.resolve();
  }
  function readImage(file, max) { // same as the original: scale down and keep as PNG
    max = max || 1600;
    if (!/^image\//.test(file.type)) return Promise.reject(Error('Choose an image.'));
    if (file.size > 15 * 1024 * 1024) return Promise.reject(Error('Choose an image smaller than 15 MB.'));
    return createImageBitmap(file).then(function (bm) { var sc = Math.min(1, max / Math.max(bm.width, bm.height)), c = document.createElement('canvas'); c.width = bm.width * sc; c.height = bm.height * sc; c.getContext('2d').drawImage(bm, 0, 0, c.width, c.height); bm.close(); return c.toDataURL('image/png'); });
  }
  // Document preview with the original PDF engine
  // The short message that goes with an invoice in email, WhatsApp or a text message
  function invoiceMessage(d) {
    var I = APS.invoices, n2 = function (v) { return Number(v) || 0; }, $ = function (v) { return '$' + n2(v).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
    var dd = function (iso, long) { var p = String(iso || '').split('-'); return p.length === 3 ? p[2] + '/' + p[1] + '/' + (long ? p[0] : p[0].slice(2)) : ''; };
    var loads = d.loads.filter(I.activeLoad), misc = d.misc.filter(I.activeMisc), lt = loads.reduce(function (s, r) { return s + n2(r.amount); }, 0), mt = misc.reduce(function (s, r) { return s + n2(r.amount); }, 0);
    var km = loads.reduce(function (s, r) { return s + (I.isCO(r.type) ? 0 : n2(r.km)); }, 0), sub = lt + mt, g = Number(d.gst) > 0 ? Number(d.gst) : 0, tax = Math.round(sub * g) / 100;
    var L = ['Hi,', '', 'Please find attached invoice ' + d.invoiceNo + ' for the period ' + dd(d.dateFrom) + ' to ' + dd(d.dateTo) + '.', ''];
    if (loads.length) L.push('Loads: ' + loads.length + (km ? ' (' + km.toLocaleString('en-AU') + ' km)' : '') + ', ' + $(lt) + '.');
    if (misc.length) L.push('Miscellaneous: ' + misc.length + (misc.length === 1 ? ' item' : ' items') + ', ' + $(mt) + '.');
    if (g) { L.push('Subtotal: ' + $(sub) + '.'); L.push('GST ' + g + '%: ' + $(tax) + '.'); L.push('Total including GST: ' + $(sub + tax) + '.'); } else L.push('Total: ' + $(sub) + '.');
    if (d.yellowDate) { L.push(''); L.push('Yellow pages submitted to ' + dd(d.yellowDate, true) + '.'); }
    L.push(''); L.push('Thank you,'); if (d.nameSg) L.push(d.nameSg); if (d.mobile) L.push('Mobile: ' + d.mobile);
    return { subject: 'Invoice ' + d.invoiceNo + ' · ' + dd(d.dateFrom) + ' to ' + dd(d.dateTo) + (d.nameSg ? ' · ' + d.nameSg : ''), text: L.join('\n') };
  }
  function docPreview(name, pages, msg) {
    sheet(name, '<div class="tools"><button class="btn" id="dp-zoom">Enlarge</button><button class="btn pri" id="dp-dl" disabled>Download PDF</button><button class="btn" id="dp-sh" disabled>Share PDF</button>' + (msg ? '<button class="btn" id="dp-msg">Copy message</button>' : '') + '</div>' + (msg ? '<details class="fold msgfold"><summary>Message that goes with it</summary><pre class="msgpre" id="dp-msgt"></pre></details>' : '') + '<div class="paper-scroll" id="dp-pages"><p>Preparing document…</p></div>', function (bd) {
      var box = bd.querySelector('#dp-pages'), pdf = null, zoom = false;
      APS.preparePdfPages(pages).then(function (prep) {
        box.innerHTML = prep.map(function (p) { return '<div class="paper">' + p + '</div>'; }).join('');
        return APS.createPdf(prep, name);
      }).then(function (blob) { pdf = blob; bd.querySelector('#dp-dl').disabled = false; bd.querySelector('#dp-sh').disabled = false; })
        .catch(function (e) { box.insertAdjacentHTML('afterbegin', '<p role="alert" class="bad">' + esc(e.message || 'The document could not be prepared.') + '</p>'); });
      bd.querySelector('#dp-zoom').addEventListener('click', function (e) { zoom = !zoom; box.classList.toggle('zoom', zoom); e.target.textContent = zoom ? 'Fit page' : 'Enlarge'; });
      bd.querySelector('#dp-dl').addEventListener('click', function () { if (pdf) download(pdf, name + '.pdf'); });
      if (msg) { bd.querySelector('#dp-msgt').textContent = msg.subject + '\n\n' + msg.text; bd.querySelector('#dp-msg').addEventListener('click', function () { (navigator.clipboard ? navigator.clipboard.writeText(msg.text) : Promise.reject()).then(function () { toast('Message copied. Paste it into WhatsApp, a text or an email.'); }, function () { toast('Copy is not available here.'); }); }); }
      bd.querySelector('#dp-sh').addEventListener('click', function () { if (pdf) shareFile(pdf, name + '.pdf', msg).catch(function (e) { toast(e.message || 'Sharing did not work.'); }); });
    }, 'wide');
  }
  // Signature pad: 600 x 180 canvas, dark pen, saved as a PNG (same as the original)
  function sigPad(host, saveLabel, onSave, onCancel) {
    host.innerHTML = '<canvas class="sigpad" width="600" height="180" aria-label="Draw signature"></canvas><div class="tools"><button class="btn" data-a="clear">Clear</button><button class="btn pri" data-a="save">' + esc(saveLabel) + '</button><button class="btn" data-a="cancel">Cancel</button></div>';
    var c = host.querySelector('canvas'), ctx = c.getContext('2d'), drawing = false, ink = false;
    ctx.lineWidth = 2.3; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#17263c';
    function pt(e) { var r = c.getBoundingClientRect(); return [(e.clientX - r.left) * 600 / r.width, (e.clientY - r.top) * 180 / r.height]; }
    c.addEventListener('pointerdown', function (e) { e.preventDefault(); try { c.setPointerCapture(e.pointerId); } catch (x) {} drawing = true; var p = pt(e); ctx.beginPath(); ctx.moveTo(p[0], p[1]); });
    c.addEventListener('pointermove', function (e) { if (!drawing) return; var p = pt(e); ctx.lineTo(p[0], p[1]); ctx.stroke(); ink = true; });
    c.addEventListener('pointerup', function () { drawing = false; }); c.addEventListener('pointercancel', function () { drawing = false; });
    host.querySelector('[data-a="clear"]').addEventListener('click', function () { ctx.clearRect(0, 0, 600, 180); ink = false; });
    host.querySelector('[data-a="cancel"]').addEventListener('click', function () { host.innerHTML = ''; if (onCancel) onCancel(); });
    host.querySelector('[data-a="save"]').addEventListener('click', function () { if (!ink) return toast('Draw your signature first.'); onSave(c.toDataURL('image/png')); });
  }

  /* ================= INVOICES ================= */
  var INV_DETAILS = [['nameSg', 'Name / SG No.'], ['billTo', 'Bill to'], ['mobile', 'Mobile'], ['email', 'Email'], ['bsb', 'BSB'], ['accountNo', 'Account number'], ['abnAcn', 'ABN / ACN']];
  function invEdit(fn) {
    return mutate(function (w) { var i = w.invoices.find(function (x) { return x.id === ui.inv; }); if (!i) throw Error('Invoice not found.'); if (i.status === 'Issued') throw Error('Create a revision to change an issued invoice.'); fn(i, w); i.updatedAt = new Date().toISOString(); });
  }
  function viewInvoices() {
    var I = APS.invoices, inv = O.invoices.find(function (i) { return i.id === ui.inv; });
    if (!inv) { ui.inv = ''; return invoiceList(); }
    var locked = inv.status === 'Issued', total = 'Complete the rows to calculate', h;
    try { total = I.money(I.calculateInvoice(inv).total); } catch (e) {}
    var wd = withDays(O);
    h = '<div class="wrap">' + tabs('invoices') + '<div class="datebar"><div class="day">Invoice ' + esc(inv.invoiceNo) + ' <span class="chip ' + (locked ? 'ok' : '') + '">' + inv.status + ' · r' + inv.revision + '</span></div><button class="btn" id="iv-back">‹ Invoices</button><button class="btn" id="iv-dup">Duplicate</button></div>';
    h += '<div class="card"><div class="form three">' + fld('iv-invoiceNo', 'Invoice number', inv.invoiceNo, { disabled: locked }) + fld('iv-dateFrom', 'Date from', inv.dateFrom, { type: 'date', disabled: locked }) + fld('iv-dateTo', 'Date to', inv.dateTo, { type: 'date', disabled: locked }) + fld('iv-yellowDate', 'Yellow pages submitted to', inv.yellowDate, { type: 'date', disabled: locked }) + fld('iv-gst', 'GST', inv.gst || '', { options: [['', 'No GST'], ['10', 'Add 10% GST']], disabled: locked }) + '</div></div>';
    h += '<details class="card fold" id="iv-details"' + (ui.open['iv-details'] == null && !O.invoiceSettings.profile.billTo ? ' open' : '') + '><summary>Business, customer &amp; bank details</summary><div class="form">' + INV_DETAILS.map(function (x) { return fld('iv-' + x[0], x[1], inv[x[0]], { type: x[0] === 'mobile' ? 'tel' : x[0] === 'email' ? 'email' : 'text', disabled: locked }); }).join('') + '</div><div class="tools" style="margin-top:12px"><button class="btn" id="iv-savedef"' + (locked ? ' disabled' : '') + '>Save as defaults</button><span class="hint">Saved details are filled automatically for new invoices.</span></div></details>';
    h += '<div class="card stack"><div class="datebar"><h3 style="margin-right:auto">Load details</h3><button class="btn" id="iv-trip"' + (locked ? ' disabled' : '') + '>+ From diary</button></div>';
    inv.loads.forEach(function (r, n) {
      var co = I.isCO(r.type), amt = '—', src = '';
      try { amt = I.money(Number(I.calculateLoad(r).amount)); } catch (e) {}
      if (r.sourceId) { try { var ab = r.sourceId.split('|'); src = I.tripLoad(wd, ab[0], ab[1]).sourceRevision !== r.sourceRevision ? 'Diary changed · review' : 'From diary'; } catch (e) { src = 'Source needs review'; } }
      var p = 'ld-' + r.id + '-';
      h += '<div class="rowcard" aria-label="Load ' + (n + 1) + '"><div class="rowhd"><b>Load ' + (n + 1) + '</b>' + (src ? '<span class="chip ' + (src === 'From diary' ? '' : 'warn') + '">' + src + '</span>' : '') + '<button class="btn sm danger" data-rmload="' + r.id + '"' + (locked ? ' disabled' : '') + '>Remove</button></div><div class="form loads">'
        + fld(p + 'loadDate', 'Load date', r.loadDate, { type: 'date', disabled: locked }) + fld(p + 'from', 'From', r.from, { list: 'city-codes', disabled: locked }) + fld(p + 'to', 'To', r.to, { list: 'city-codes', disabled: locked })
        + fld(p + 'type', 'BD / RT / BT / AB / C/O', r.type, { list: 'load-types', disabled: locked }) + fld(p + 'odoStart', 'Start odometer', r.odoStart, { type: 'digits', disabled: locked }) + fld(p + 'odoFinish', 'Finish odometer', r.odoFinish, { type: 'digits', disabled: locked })
        + fld(p + 'km', 'Quantity / km', r.km, { type: 'number', disabled: locked || (!!r.odoStart && !!r.odoFinish) }) + fld(p + 'rate', co ? 'Fixed amount' : 'Rate per km', r.rate, { type: 'number', disabled: locked, after: co ? '<small class="fixed">FIXED RATE</small>' : '' })
        + (r.manualAmount ? fld(p + 'amount', 'Amount', r.amount, { type: 'number', disabled: locked }) : '<div class="amt"><span>Amount</span><strong>' + amt + '</strong></div>')
        + '</div>' + chk(p + 'manualAmount', 'Manual amount', r.manualAmount, locked) + '</div>';
    });
    h += '<div><button class="btn" id="iv-addload"' + (locked ? ' disabled' : '') + '>+ Add load</button></div></div>';
    h += '<details class="card fold" id="iv-misc"' + (inv.misc.length ? ' open' : '') + '><summary>Miscellaneous · ' + inv.misc.length + ' rows</summary><div class="stack">';
    inv.misc.forEach(function (r, n) {
      var amt = '—'; try { amt = I.money(Number(I.calculateMisc(r).amount)); } catch (e) {}
      var p = 'ms-' + r.id + '-';
      h += '<div class="rowcard" aria-label="Miscellaneous ' + (n + 1) + '"><div class="rowhd"><b>Item ' + (n + 1) + '</b><button class="btn sm danger" data-rmmisc="' + r.id + '"' + (locked ? ' disabled' : '') + '>Remove</button></div><div class="form loads">'
        + fld(p + 'date', 'Date', r.date, { type: 'date', disabled: locked }) + fld(p + 'item', 'Item', r.item, { list: 'misc-items', disabled: locked }) + fld(p + 'quantity', 'Quantity', r.quantity, { type: 'number', disabled: locked }) + fld(p + 'rate', 'Rate', r.rate, { type: 'number', disabled: locked })
        + (r.manualAmount ? fld(p + 'amount', 'Miscellaneous amount', r.amount, { type: 'number', disabled: locked }) : '<div class="amt"><span>Amount</span><strong>' + amt + '</strong></div>') + '</div>' + chk(p + 'manualAmount', 'Manual amount', r.manualAmount, locked) + '</div>';
    });
    h += '<div><button class="btn" id="iv-addmisc"' + (locked ? ' disabled' : '') + '>+ Add miscellaneous</button></div></div></details>';
    h += '<div class="card stack">' + '<div class="form" style="grid-template-columns:1fr">' + fld('iv-notes', 'Notes', inv.notes, { type: 'textarea', disabled: locked }) + '</div><div class="datebar"><div class="big" style="font-size:34px;margin-right:auto">' + esc(total) + '</div><button class="btn pri" id="iv-pdf">Preview PDF</button></div>'
      + '<div class="tools"><button class="btn" id="iv-csv">CSV</button><button class="btn" id="iv-xlsx">Excel</button>' + (locked ? '<button class="btn" id="iv-rev">Create revision</button>' : '<button class="btn" id="iv-issue">Mark issued</button><button class="btn danger" id="iv-del">Delete draft</button>') + '</div></div>';
    var dl = function (id, arr) { return '<datalist id="' + id + '">' + arr.map(function (x) { return '<option value="' + esc(x) + '">'; }).join('') + '</datalist>'; };
    h += dl('load-types', O.invoiceSettings.types) + dl('city-codes', O.invoiceSettings.cities) + dl('misc-items', O.invoiceSettings.miscItems) + '</div>';
    main.innerHTML = h;

    click('iv-back', function () { ui.inv = ''; draw('invoices'); main.scrollTop = 0; });
    on('iv-gst', 'change', function (e) { var v = e.target.value; quiet(invEdit(function (i) { i.gst = v; })).then(function () { return quiet(mutate(function (w) { w.invoiceSettings.gst = v; })); }).then(function () { later('invoices'); }); });
    ['invoiceNo', 'dateFrom', 'dateTo', 'notes', 'yellowDate'].concat(INV_DETAILS.map(function (x) { return x[0]; })).forEach(function (k) {
      on('iv-' + k, 'change', function (e) { var v = e.target.value; quiet(invEdit(function (i) { i[k] = v; })).then(function () { later('invoices'); }); });
    });
    each('[id^="ld-"]', function (el) {
      var m = /^ld-(.+)-([a-zA-Z]+)$/.exec(el.id), id = m[1], k = m[2];
      el.addEventListener('change', function () {
        var v = el.type === 'checkbox' ? el.checked : el.value;
        quiet(invEdit(function (i, w) { // same row logic as the original editor
          var r = i.loads.find(function (x) { return x.id === id; }); r[k] = v;
          if (k === 'type') { r.rate = w.invoiceSettings.typeRates[String(v)] || r.rate; if (I.isCO(String(v))) r.fixedAmount = r.rate; }
          if (k === 'rate' && I.isCO(r.type)) r.fixedAmount = String(v);
          try { Object.assign(r, I.calculateLoad(r)); } catch (e) { /* an unfinished row stays a draft */ }
        })).then(function () { later('invoices'); });
      });
    });
    each('[id^="ms-"]', function (el) {
      var m = /^ms-(.+)-([a-zA-Z]+)$/.exec(el.id), id = m[1], k = m[2];
      el.addEventListener('change', function () {
        var v = el.type === 'checkbox' ? el.checked : el.value;
        quiet(invEdit(function (i, w) { var r = i.misc.find(function (x) { return x.id === id; }); r[k] = v; if (k === 'item') r.rate = w.invoiceSettings.miscItemRates[String(v)] || r.rate; try { Object.assign(r, I.calculateMisc(r)); } catch (e) {} })).then(function () { later('invoices'); });
      });
    });
    each('[data-rmload]', function (b) { b.addEventListener('click', function () { quiet(invEdit(function (i) { i.loads = i.loads.filter(function (x) { return x.id !== b.dataset.rmload; }); })).then(function () { draw('invoices'); }); }); });
    each('[data-rmmisc]', function (b) { b.addEventListener('click', function () { quiet(invEdit(function (i) { i.misc = i.misc.filter(function (x) { return x.id !== b.dataset.rmmisc; }); })).then(function () { draw('invoices'); }); }); });
    click('iv-addload', function () { quiet(invEdit(function (i) { i.loads.push(I.blankLoad()); })).then(function () { draw('invoices'); }); });
    click('iv-addmisc', function () { ui.open['iv-misc'] = true; quiet(invEdit(function (i) { i.misc.push(I.blankMisc()); })).then(function () { draw('invoices'); var d = document.getElementById('iv-misc'); if (d) d.open = true; }); });
    click('iv-savedef', function () { quiet(mutate(function (w) { var i = w.invoices.find(function (x) { return x.id === ui.inv; }); INV_DETAILS.forEach(function (x) { w.invoiceSettings.profile[x[0]] = String(i[x[0]] || ''); }); })).then(function () { ui.open['iv-details'] = false; var d = document.getElementById('iv-details'); if (d) d.open = false; toast('Defaults saved.'); }); });
    click('iv-dup', function () {
      var id = ''; quiet(mutate(function (w) {
        var o = w.invoices.find(function (x) { return x.id === ui.inv; }), nx = I.newInvoice(w);
        Object.assign(nx, { nameSg: o.nameSg, billTo: o.billTo, mobile: o.mobile, email: o.email, bsb: o.bsb, accountNo: o.accountNo, abnAcn: o.abnAcn,
          loads: o.loads.map(function (r) { var c = APS.clone(r); c.id = APS.uid(); delete c.sourceId; delete c.sourceRevision; return c; }), misc: o.misc.map(function (r) { var c = APS.clone(r); c.id = APS.uid(); return c; }), notes: o.notes });
        id = nx.id; w.invoices.push(nx); w.invoiceSettings.nextInvoiceNo++;
      })).then(function () { if (id) { ui.inv = id; draw('invoices'); main.scrollTop = 0; toast('Copied to a new draft.'); } });
    });
    click('iv-pdf', function () { try { var d = I.validateInvoice(O.invoices.find(function (x) { return x.id === ui.inv; })).invoice; d.gst = (O.invoices.find(function (x) { return x.id === ui.inv; }) || {}).gst || ''; docPreview('Invoice-' + d.invoiceNo + '-' + d.dateFrom + '-to-' + d.dateTo, APS.invoicePages(d), invoiceMessage(d)); } catch (e) { toast(e.message); } });
    click('iv-csv', function () { try { download(new Blob(['﻿' + I.invoiceCsv(inv)], { type: 'text/csv;charset=utf-8' }), 'Invoice-' + inv.invoiceNo + '.csv'); } catch (e) { toast(e.message); } });
    click('iv-xlsx', function () { try { download(new Blob([APS.invoiceExcel(inv)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'Invoice-' + inv.invoiceNo + '-' + inv.dateFrom + '-' + inv.dateTo + '.xlsx'); } catch (e) { toast(e.message); } });
    click('iv-rev', function () {
      var id = ''; quiet(mutate(function (w) { var old = w.invoices.find(function (x) { return x.id === ui.inv; }), nx = APS.clone(old); nx.id = APS.uid(); id = nx.id; nx.status = 'Draft'; nx.revision++; nx.revises = old.id; nx.updatedAt = new Date().toISOString(); w.invoices.push(nx); APS.audit(w, 'Revise invoice', nx.id, old, nx); }))
        .then(function () { if (id) { ui.inv = id; draw('invoices'); toast('Revision created. The issued copy is kept.'); } });
    });
    click('iv-issue', function () {
      quiet(mutate(function (w) {
        var i = w.invoices.find(function (x) { return x.id === ui.inv; }), calc = I.validateInvoice(i).invoice;
        if (w.invoices.some(function (x) { return x.id !== i.id && x.invoiceNo === i.invoiceNo && x.status === 'Issued' && i.revises !== x.id; })) throw Error('This number has already been issued.');
        Object.assign(i, calc, { status: 'Issued' });
        i.loads.forEach(function (r) { if (r.type && w.invoiceSettings.types.indexOf(r.type) < 0) w.invoiceSettings.types.push(r.type); if (r.type && r.rate) w.invoiceSettings.typeRates[r.type] = r.rate; });
        i.misc.forEach(function (r) { if (r.item && w.invoiceSettings.miscItems.indexOf(r.item) < 0) w.invoiceSettings.miscItems.push(r.item); if (r.item && r.rate) w.invoiceSettings.miscItemRates[r.item] = r.rate; });
        APS.audit(w, 'Issue invoice', i.id, undefined, i);
      })).then(function () { draw('invoices'); });
    });
    click('iv-del', function () {
      confirmBox('Delete this draft?', 'Invoice ' + inv.invoiceNo + ' will be removed from this device.', 'Delete draft', function () {
        return mutate(function (w) { var i = w.invoices.find(function (x) { return x.id === inv.id; }); if (i && i.status === 'Issued') throw Error('Issued invoices are retained.'); APS.audit(w, 'Delete invoice draft', inv.id, i); w.invoices = w.invoices.filter(function (x) { return x.id !== inv.id; }); }).then(function () { ui.inv = ''; draw('invoices'); });
      });
    });
    click('iv-trip', function () {
      var ch = I.tripChoices(wd, inv.dateFrom || '0000-01-01', inv.dateTo || '9999-12-31'), opts = [['', 'Choose a diary change']].concat(ch.map(function (c) { return [c.key, APS.displayDate(c.date) + ' ' + APS.hhmm(c.slot) + ' · ' + c.location + ' · ' + c.odometer + ' · ' + c.vehicle]; }));
      sheet('Add a diary trip', (ch.length ? '' : '<p class="note warn">No diary changes with a place or odometer were found' + (inv.dateFrom ? ' in this invoice period' : '') + '. In the Diary, add the place, odometer and number plate to your work and rest changes first.</p>')
        + '<div class="form" style="grid-template-columns:1fr">' + fld('tr-a', 'Start change', '', { options: opts }) + fld('tr-b', 'Finish change', '', { options: opts }) + '</div><div class="tools" style="margin-top:12px"><button class="btn pri" id="tr-ok">Add trip for review</button></div>', function (bd, close) {
        bd.querySelector('#tr-ok').addEventListener('click', function () {
          var a = bd.querySelector('#tr-a').value, b = bd.querySelector('#tr-b').value;
          quiet(mutate(function (w) {
            var row = I.tripLoad(withDays(w), a, b), i = w.invoices.find(function (x) { return x.id === ui.inv; });
            if (w.invoices.some(function (x) { return x.id !== i.revises && x.loads.some(function (r) { return r.sourceId === row.sourceId; }); })) throw Error('This diary trip is already on an invoice.');
            i.loads = i.loads.filter(I.activeLoad); i.loads.push(row);
          }).then(function () { close(); draw('invoices'); }));
        });
      }, 'small');
    });
  }
  function invoiceList() {
    var I = APS.invoices, st = O.invoiceSettings, q = ui.invSearch.toLowerCase();
    var list = O.invoices.filter(function (i) { return (i.invoiceNo + ' ' + i.billTo + ' ' + i.dateFrom).toLowerCase().indexOf(q) >= 0; }).sort(function (a, b) { return b.updatedAt.localeCompare(a.updatedAt); });
    var h = '<div class="wrap">' + tabs('invoices') + '<div class="datebar"><div class="day">Invoices</div><button class="btn pri" id="iv-new">+ New invoice</button></div><div class="tools"><button class="btn" id="iv-auto">+ Add my last trip from the diary</button></div>'
      + '<div class="form" style="grid-template-columns:1fr">' + fld('iv-search', 'Search invoices', ui.invSearch, { type: 'search' }) + '</div><div class="stack" id="iv-list">'
      + list.map(function (i) { return '<button class="card listbtn" data-inv="' + i.id + '"><span><b>Invoice ' + esc(i.invoiceNo) + '</b><small>' + esc(i.billTo || 'Bill to not set') + ' · ' + (APS.displayDate(i.dateFrom) || 'No period') + '</small></span><span class="chip ' + (i.status === 'Issued' ? 'ok' : '') + '">' + i.status + (i.revision > 1 ? ' · r' + i.revision : '') + '</span></button>'; }).join('')
      + (O.invoices.length ? (list.length ? '' : '<p class="hint">No invoice matches that search.</p>') : '<div class="card empty">No invoices yet. Tap “New invoice” to make your first one. Your business and bank details are remembered after that.</div>') + '</div>'
      + '<details class="card fold" id="iv-defaults"><summary>Default invoice details &amp; rates</summary><div class="form">' + INV_DETAILS.map(function (x) { return fld('df-' + x[0], x[1], st.profile[x[0]], { type: x[0] === 'mobile' ? 'tel' : x[0] === 'email' ? 'email' : 'text' }); }).join('') + '</div><h3 style="margin:14px 0 8px">Load rates</h3><div class="form">'
      + st.types.map(function (t, n) { return fld('rt-' + n, t + (I.isCO(t) ? ' · fixed' : ' · per km'), st.typeRates[t], { type: 'number' }); }).join('') + '</div><div class="form" style="grid-template-columns:1fr;margin-top:12px">' + fld('df-types', 'Types (comma separated)', st.types.join(', ')) + fld('df-cities', 'City codes (comma separated)', st.cities.join(', ')) + '</div></details>'
      + (function () { var c = autoCfg(O), days = DOWN.map(function (d, i) { return [String(i), d]; }); return '<details class="card fold" id="iv-autoset" open><summary>Trips to invoice · my invoice week</summary><p class="hint">When you finish work, the app can ask if the trip is finished and put it on the right invoice.</p><div class="form">' + fld('au-start', 'My invoice week starts on', String(c.start), { options: days }) + fld('au-end', 'and ends on', String(c.end), { options: days }) + fld('au-ask', 'Ask when I finish work', c.ask ? '1' : '0', { options: [['1', 'Yes, ask me'], ['0', 'No, I add trips myself']] }) + '</div></details>'; })() + '</div>';
    main.innerHTML = h;
    click('iv-auto', function () { tripAsk('', true); });
    ['start', 'end', 'ask'].forEach(function (k) { on('au-' + k, 'change', function (e) { var v = e.target.value; quiet(mutate(function (w) { var a = Object.assign({}, w.invoiceSettings.auto); a[k] = k === 'ask' ? v === '1' : +v; w.invoiceSettings.auto = a; })); }); });
    click('iv-new', function () { var id = ''; quiet(mutate(function (w) { var i = I.newInvoice(w); i.gst = w.invoiceSettings.gst || ''; id = i.id; w.invoices.push(i); w.invoiceSettings.nextInvoiceNo++; })).then(function () { if (id) { ui.inv = id; delete ui.open['iv-details']; draw('invoices'); main.scrollTop = 0; } }); });
    on('iv-search', 'input', function (e) { ui.invSearch = e.target.value; var p = e.target.selectionStart; draw('invoices'); var n = document.getElementById('iv-search'); n.focus(); try { n.setSelectionRange(p, p); } catch (x) {} });
    each('[data-inv]', function (b) { b.addEventListener('click', function () { ui.inv = b.dataset.inv; delete ui.open['iv-details']; draw('invoices'); main.scrollTop = 0; }); });
    INV_DETAILS.forEach(function (x) { on('df-' + x[0], 'change', function (e) { var v = e.target.value; quiet(mutate(function (w) { w.invoiceSettings.profile[x[0]] = v; })); }); });
    st.types.forEach(function (t, n) { on('rt-' + n, 'change', function (e) { var v = e.target.value; quiet(mutate(function (w) { w.invoiceSettings.typeRates[t] = v; })); }); });
    var listOf = function (v) { return Array.from(new Set(v.split(',').map(function (x) { return x.trim(); }).filter(Boolean))); };
    on('df-types', 'change', function (e) { var v = listOf(e.target.value); quiet(mutate(function (w) { w.invoiceSettings.types = v; })).then(function () { later('invoices'); }); });
    on('df-cities', 'change', function (e) { var v = listOf(e.target.value); quiet(mutate(function (w) { w.invoiceSettings.cities = v; })); });
  }

  /* ================= SAFE DRIVING FORMS ================= */
  function formEdit(fn) { ui.reviewed = false; return mutate(function (w) { APS.forms.editForm(w, ui.form, fn); }); }
  function defaultsSheet() {
    var F = APS.forms, d = F.getFormDefaults(O);
    sheet('Form defaults', '', function (bd, close) {
      function paint() {
        bd.innerHTML = '<p class="hint">Used for new forms. Existing forms keep their saved details.</p><h3>Company</h3><div class="form" style="grid-template-columns:1fr">' + fld('fd-company', 'Default company name', d.company) + '</div><div class="tools">' + chk('fd-showCompany', 'Show company name by default', d.showCompany) + chk('fd-showLogo', 'Show logo by default', d.showLogo) + '<label class="btn" for="fd-logo">Choose default logo<input type="file" id="fd-logo" accept="image/*" hidden></label>' + (d.logo ? '<button class="btn" id="fd-rmlogo">Remove logo</button>' : '') + '</div>' + (d.logo ? '<img src="' + d.logo + '" alt="Default company logo" class="brandimg">' : '')
          + '<h3>My details</h3><div class="form">' + fld('fd-driver', 'Default driver name', d.driver) + fld('fd-contact', 'Default contact number', d.contact, { type: 'tel' }) + fld('fd-licence', 'Default licence number', d.licence) + fld('fd-expiry', 'Default licence expiry', d.expiry, { type: 'date' }) + '</div>'
          + '<h3>My form signature</h3><div class="signature">' + (d.signature ? '<img src="' + d.signature + '" alt="Saved driver signature" class="sigimg">' : '') + '<div id="fd-sig"></div><button class="btn" id="fd-draw">' + (d.signature ? 'Replace signature' : 'Draw my signature') + '</button></div><div class="tools" style="margin-top:14px"><button class="btn pri" id="fd-save">Save defaults</button></div>';
        ['company', 'driver', 'contact', 'licence', 'expiry'].forEach(function (k) { bd.querySelector('#fd-' + k).addEventListener('change', function (e) { d[k] = e.target.value; if (k === 'driver' || k === 'licence') { if (d.signature) { d.signature = ''; toast('Name or licence changed, so the saved signature was cleared. Draw it again.'); paint(); } } }); });
        ['showCompany', 'showLogo'].forEach(function (k) { bd.querySelector('#fd-' + k).addEventListener('change', function (e) { d[k] = e.target.checked; }); });
        bd.querySelector('#fd-logo').addEventListener('change', function (e) { var f = e.target.files[0]; if (f) readImage(f).then(function (v) { d.logo = v; d.showLogo = true; paint(); }, function (er) { toast(er.message); }); });
        var rm = bd.querySelector('#fd-rmlogo'); if (rm) rm.addEventListener('click', function () { d.logo = ''; d.showLogo = false; paint(); });
        bd.querySelector('#fd-draw').addEventListener('click', function (e) { e.target.hidden = true; sigPad(bd.querySelector('#fd-sig'), 'Save signature', function (v) { d.signature = v; paint(); }, function () { e.target.hidden = false; }); });
        bd.querySelector('#fd-save').addEventListener('click', function () { quiet(mutate(function (w) { w.contact = d.contact; F.saveFormDefaults(w, d); }).then(function () { close(); toast('Defaults saved.'); draw('forms'); })); });
      }
      paint();
    });
  }
  function viewForms() {
    var F = APS.forms, f = O.forms.find(function (x) { return x.id === ui.form; });
    if (!f) { ui.form = ''; return formList(); }
    var locked = f.status === 'Signed', veh = F.vehiclesInForm(f), key = veh.indexOf(ui.vehicle) >= 0 ? ui.vehicle : veh[0] || 'pm', dis = locked ? ' disabled' : '';
    var count = veh.reduce(function (n, k) { return n + Object.keys(f.checks[k] || {}).length; }, 0), max = veh.length * F.inspection.length, v = f.values, defs = F.getFormDefaults(O);
    var h = '<div class="wrap">' + tabs('forms') + '<div class="datebar"><div class="day">Safe driving plan <span class="chip ' + (locked ? 'ok' : '') + '">' + f.status + ' · ' + esc(v.base || O.profile.base) + ' time</span></div><button class="btn" id="fm-back">‹ Forms</button></div>';
    h += '<div class="card"><div class="form">' + fld('fv-from', 'Origin', v.from, { disabled: locked }) + fld('fv-to', 'Destination', v.to, { disabled: locked }) + fld('fv-date', 'Departure date', v.date, { type: 'date', disabled: locked }) + fld('fv-depart', 'Departure time', v.depart, { type: 'time', disabled: locked })
      + fld('fv-arrive', 'Estimated arrival', v.arrive, { type: 'datetime-local', disabled: locked }) + fld('fv-hours', 'Hours available', v.hours, { type: 'number', disabled: locked }) + fld('fv-pm', 'Truck registration', v.pm, { disabled: locked }) + fld('fv-odo', 'Odometer', v.odo, { type: 'digits', disabled: locked }) + '</div></div>';
    h += '<details class="card fold" id="fm-driver"><summary>Driver, trailers &amp; load</summary><div class="form">' + [['driver', 'Driver name'], ['contact', 'Contact'], ['licence', 'Licence'], ['expiry', 'Licence expiry'], ['t1', 'Trailer 1'], ['t2', 'Trailer 2'], ['t3', 'Trailer 3'], ['scheme', 'Work / rest scheme'], ['accreditation', 'Accreditation number'], ['vehicle-type', 'Vehicle type'], ['manifest', 'Manifest number'], ['weight-steer', 'Steer weight'], ['weight-drive', 'Drive weight'], ['weight-1', 'Trailer 1 weight'], ['weight-2', 'Trailer 2 weight'], ['weight-3', 'Trailer 3 weight']]
      .map(function (x) { return fld('fv-' + x[0], x[1], v[x[0]], { type: x[0] === 'expiry' ? 'date' : x[0] === 'contact' ? 'tel' : /^weight-/.test(x[0]) ? 'number' : 'text', disabled: locked, options: x[0] === 'scheme' ? ['Standard', 'BFM', 'AFM', 'ACH'] : null }); }).join('') + '</div>'
      + (v.scheme === 'AFM' || v.scheme === 'ACH' ? '<p class="note warn" style="margin-top:12px">This company template only has Standard and BFM boxes. Record your certificate arrangement in Comments and confirm the company accepts it.</p>' : '') + '</details>';
    h += '<div class="card stack"><div class="datebar"><h3 style="margin-right:auto">Vehicle check <span class="chip">' + count + '/' + max + '</span></h3><button class="btn" id="fm-allok"' + dis + '>All checked · OK</button></div><div class="form" style="grid-template-columns:1fr">'
      + fld('fm-veh', 'Inspect vehicle', key, { options: (veh.length ? veh : ['pm']).map(function (k) { return [k, (k === 'pm' ? 'Truck' : k.replace('t', 'Trailer ')) + ' · ' + (v[k] || 'not set')]; }) }) + '</div>'
      + F.inspection.map(function (q, i) { return '<div class="question"><span>' + (i + 1) + '. ' + esc(q) + '</span><div class="answers" role="group" aria-label="' + esc(q) + '">' + [['ok', 'OK'], ['issue', 'Fault'], ['na', 'N/A']].map(function (a) { return '<button data-chk="' + i + '" data-a="' + a[0] + '" aria-pressed="' + ((f.checks[key] || {})[i] === a[0]) + '"' + dis + '>' + a[1] + '</button>'; }).join('') + '</div></div>'; }).join('') + '</div>';
    h += '<details class="card fold" id="fm-decl" open><summary>Driver declarations · ' + Object.keys(f.declarations).length + '/' + F.declarations.length + '</summary><div class="stack"><div><button class="btn" id="fm-allclear"' + dis + '>Reviewed all · all clear</button></div>'
      + F.declarations.map(function (q, i) { return '<div class="question"><span>' + (i + 1) + '. ' + esc(q[0]) + '</span><div class="answers yn" role="group" aria-label="' + esc(q[0]) + '">' + ['Yes', 'No'].map(function (a) { return '<button data-decl="' + i + '" data-a="' + a + '" aria-pressed="' + (f.declarations[i] === a) + '"' + dis + '>' + a + '</button>'; }).join('') + '</div></div>'; }).join('') + '</div></details>';
    if (ui.undo && !locked) h += '<div><button class="btn" id="fm-undo">Undo last all-clear action</button></div>';
    h += '<div class="card"><div class="form" style="grid-template-columns:1fr">' + fld('fv-comments', 'Comments / faults and action taken', v.comments, { type: 'textarea', disabled: locked }) + '</div></div>';
    h += '<details class="card fold" id="fm-brand"><summary>Company name &amp; logo (this form)</summary><div class="form" style="grid-template-columns:1fr">' + fld('fm-company', 'Company name', f.company, { disabled: locked }) + '</div><div class="tools" style="margin-top:10px">' + chk('fm-showCompany', 'Show company name', f.showCompany, locked) + chk('fm-showLogo', 'Show logo', f.showLogo, locked) + (locked ? '' : '<label class="btn" for="fm-logo">Choose logo<input type="file" id="fm-logo" accept="image/*" hidden></label>') + '</div>' + (f.logo && f.showLogo ? '<img src="' + f.logo + '" alt="Company logo" class="brandimg">' : '') + '</details>';
    h += '<div class="card stack"><h3>Review &amp; signature</h3>';
    if (locked) h += '<p>Signed by ' + esc(f.signedName) + '. This saved form is read only.</p><div class="tools"><button class="btn" id="fm-revise">Edit form</button><button class="btn" id="fm-newfrom">New trip from this form</button></div>';
    else h += chk('fm-reviewed', 'I have reviewed this form and these answers for this trip', ui.reviewed) + '<div class="tools"><button class="btn" id="fm-applysig"' + (ui.reviewed && defs.signature ? '' : ' disabled') + '>Apply my saved signature</button>' + (ui.reviewed ? '<button class="btn" id="fm-signnow">Sign now</button>' : '') + '</div><div id="fm-sig"></div>' + (ui.reviewed ? chk('fm-savesig', 'Save this signature for future forms', ui.saveSig) : '<p class="hint">Review this trip to sign now or use your saved signature.' + (defs.signature ? '' : ' No saved signature yet: add one in Form defaults.') + '</p>');
    h += '</div><div class="savebar"><span role="status">Saved on this device</span><div class="tools"><button class="btn" id="fm-pdf">Share / PDF</button><button class="btn pri" id="fm-save">Save form</button></div></div></div>';
    main.innerHTML = h;

    click('fm-back', function () { ui.form = ''; ui.undo = null; draw('forms'); main.scrollTop = 0; });
    each('[id^="fv-"]', function (el) { var k = el.id.slice(3); el.addEventListener('change', function () { var val = el.value; quiet(formEdit(function (r) { r.values[k] = val; })).then(function () { later('forms'); }); }); });
    on('fm-veh', 'change', function (e) { ui.vehicle = e.target.value; draw('forms'); });
    each('[data-chk]', function (b) { b.addEventListener('click', function () { var i = b.dataset.chk, a = b.dataset.a; quiet(formEdit(function (r) { r.checks[key] = r.checks[key] || {}; r.checks[key][i] = a; })).then(function () { draw('forms'); }); }); });
    each('[data-decl]', function (b) { b.addEventListener('click', function () { var i = b.dataset.decl, a = b.dataset.a; quiet(formEdit(function (r) { r.declarations[i] = a; })).then(function () { draw('forms'); }); }); });
    function clearAll(part) { var old = APS.clone(O.forms.find(function (x) { return x.id === ui.form; })); quiet(formEdit(function (r) { F.allClear(r, part); }).then(function () { ui.undo = old; })).then(function () { draw('forms'); }); }
    click('fm-allok', function () { clearAll('checks'); }); click('fm-allclear', function () { clearAll('declarations'); });
    click('fm-undo', function () { var u = ui.undo; quiet(mutate(function (w) { var ix = w.forms.findIndex(function (x) { return x.id === ui.form; }); if (ix >= 0) w.forms[ix] = APS.clone(u); })).then(function () { ui.undo = null; ui.reviewed = false; draw('forms'); }); });
    on('fm-company', 'change', function (e) { var val = e.target.value; quiet(formEdit(function (r) { r.company = val; })).then(function () { later('forms'); }); });
    on('fm-showCompany', 'change', function (e) { var val = e.target.checked; quiet(formEdit(function (r) { r.showCompany = val; })).then(function () { draw('forms'); }); });
    on('fm-showLogo', 'change', function (e) { var val = e.target.checked; quiet(formEdit(function (r) { r.showLogo = val; })).then(function () { draw('forms'); }); });
    on('fm-logo', 'change', function (e) { var file = e.target.files[0]; if (file) readImage(file).then(function (img) { return formEdit(function (r) { r.logo = img; r.showLogo = true; }); }).then(function () { draw('forms'); }, function (er) { if (er && er.message) toast(er.message); }); });
    on('fm-reviewed', 'change', function (e) { ui.reviewed = e.target.checked; draw('forms'); });
    on('fm-savesig', 'change', function (e) { ui.saveSig = e.target.checked; });
    var rev = f.revision;
    function sign(signature) {
      return mutate(function (w) {
        var r = w.forms.find(function (x) { return x.id === ui.form; });
        if (r.revision !== rev) throw Error('This form changed. Review it again before signing.');
        if (signature) { F.signForm(r, w, signature); if (ui.saveSig) { w.formDefaults = w.formDefaults || {}; if (!w.formDefaults[w.profile.id]) w.formDefaults[w.profile.id] = F.getFormDefaults(w); w.formDefaults[w.profile.id].signature = signature; } }
        else F.signForm(r, w);
        APS.audit(w, 'Sign driving form', ui.form, undefined, { status: 'Signed', revision: r.revision });
      }).then(function () { ui.undo = null; draw('forms'); toast('Form signed.'); });
    }
    click('fm-applysig', function () { quiet(sign()); });
    click('fm-signnow', function () { var b = document.getElementById('fm-signnow'); b.hidden = true; sigPad(document.getElementById('fm-sig'), 'Sign this form', function (sg) { quiet(sign(sg)); }, function () { b.hidden = false; }); });
    function preview(id) { var r = O.forms.find(function (x) { return x.id === id; }); if (!r) return toast('Form not found.'); try { docPreview('Safe-driving-' + r.values.date + '-' + (r.values.pm || 'draft'), APS.formPages(APS.clone(r))); } catch (e) { toast(e.message); } }
    click('fm-pdf', function () { preview(f.id); });
    click('fm-save', function () { quiet(mutate(function (w) { var r = w.forms.find(function (x) { return x.id === ui.form; }); if (!r) throw Error('Form not found.'); r.updatedAt = new Date().toISOString(); })).then(function () { ui.form = ''; ui.undo = null; draw('forms'); main.scrollTop = 0; toast('Form saved.'); }); });
    click('fm-revise', function () { reviseConfirm(f.id); });
    click('fm-newfrom', function () { addForm(f); });
  }
  function addForm(previous) {
    var id = ''; quiet(mutate(function (w) { var prev = previous || w.forms.slice().reverse().find(function (x) { return x.driverId === w.profile.id; }), r = APS.forms.newForm(w, prev); id = r.id; w.forms.push(r); }))
      .then(function () { if (id) { ui.form = id; ui.reviewed = false; ui.undo = null; draw('forms'); main.scrollTop = 0; } });
  }
  function reviseConfirm(id) {
    sheet('Edit signed form?', '<p>An editable revision will keep these trip details and answers. Review and sign it again; the original signed copy stays saved.</p><div class="tools"><button class="btn" id="rv-no">Cancel</button><button class="btn pri" id="rv-yes">Create editable revision</button></div>', function (bd, close) {
      bd.querySelector('#rv-no').addEventListener('click', close);
      bd.querySelector('#rv-yes').addEventListener('click', function () { var nx = ''; quiet(mutate(function (w) { nx = APS.forms.reviseForm(w, id); }).then(function () { ui.form = nx; ui.undo = null; ui.reviewed = false; close(); draw('forms'); main.scrollTop = 0; })); });
    }, 'small');
  }
  function formList() {
    var h = '<div class="wrap">' + tabs('forms') + '<div class="datebar"><div class="day">Safe driving &amp; daily check</div><button class="btn" id="fm-defaults">Form defaults</button><button class="btn pri" id="fm-new">+ New form</button></div><div class="stack">'
      + O.forms.slice().reverse().map(function (r) { return '<div class="card stack" style="gap:10px" aria-label="Form ' + APS.displayDate(r.values.date) + ' ' + esc(r.values.pm || 'Draft') + '"><button class="listbtn plain" data-open="' + r.id + '"><span><b>' + APS.displayDate(r.values.date) + ' · ' + esc(r.values.pm || 'Truck not set') + '</b><small>' + esc(r.values.from || 'Origin') + ' → ' + esc(r.values.to || 'Destination') + '</small></span><span class="chip ' + (r.status === 'Signed' ? 'ok' : '') + '">' + r.status + (r.revises ? ' · Revision' : '') + '</span></button><div class="tools"><button class="btn sm" data-edit="' + r.id + '">Edit</button><button class="btn sm" data-pdf="' + r.id + '">Share / PDF</button><button class="btn sm danger" data-del="' + r.id + '">Delete</button></div></div>'; }).join('')
      + (O.forms.length ? '' : '<div class="card empty">No forms yet. Your driver details and vehicles will be remembered for the next trip. Start with “Form defaults” to save your name, licence and signature.</div>') + '</div></div>';
    main.innerHTML = h;
    click('fm-defaults', defaultsSheet); click('fm-new', function () { addForm(); });
    each('[data-open]', function (b) { b.addEventListener('click', function () { ui.form = b.dataset.open; ui.reviewed = false; ui.undo = null; draw('forms'); main.scrollTop = 0; }); });
    each('[data-edit]', function (b) { b.addEventListener('click', function () { var r = O.forms.find(function (x) { return x.id === b.dataset.edit; }); if (r.status === 'Signed') reviseConfirm(r.id); else { ui.form = r.id; ui.reviewed = false; ui.undo = null; draw('forms'); main.scrollTop = 0; } }); });
    each('[data-pdf]', function (b) { b.addEventListener('click', function () { var r = O.forms.find(function (x) { return x.id === b.dataset.pdf; }); try { docPreview('Safe-driving-' + r.values.date + '-' + (r.values.pm || 'draft'), APS.formPages(APS.clone(r))); } catch (e) { toast(e.message); } }); });
    each('[data-del]', function (b) { b.addEventListener('click', function () { confirmBox('Delete form?', 'This removes this saved form from the device. Download its PDF first if you need a copy.', 'Delete form', function () { return mutate(function (w) { APS.forms.deleteForm(w, b.dataset.del); }).then(function () { draw('forms'); }); }); }); });
  }

  /* ================= NOTES ================= */
  function viewNotes() {
    var q = ui.noteSearch.toLowerCase();
    var list = O.notes.filter(function (n) { return (n.title + ' ' + n.tags + ' ' + n.body + ' ' + n.rows.map(function (r) { return r.join(' '); }).join(' ')).toLowerCase().indexOf(q) >= 0; })
      .sort(function (a, b) { return Number(b.favourite) - Number(a.favourite) || b.updatedAt.localeCompare(a.updatedAt); });
    var h = '<div class="wrap">' + tabs('notes') + '<div class="datebar"><div class="day">Notes</div><button class="btn pri" id="nt-new">+ New note</button></div><div class="form" style="grid-template-columns:1fr">' + fld('nt-search', 'Search notes', ui.noteSearch, { type: 'search' }) + '</div><div class="stack">';
    list.forEach(function (n) {
      h += '<article class="card stack" style="gap:8px"><div class="datebar"><h3 style="margin-right:auto;color:var(--ink)">' + (n.favourite ? '★ ' : '') + esc(n.title) + '</h3><button class="btn sm" data-pin="' + n.id + '">' + (n.favourite ? 'Unpin' : 'Pin') + '</button><button class="btn sm" data-edit="' + n.id + '">' + (n.sealed ? 'Unlock' : 'Edit') + '</button></div>';
      if (n.sealed) h += '<p class="hint">🔒 Encrypted contents</p>';
      else if (n.private && !ui.shown[n.id]) h += '<div class="tools"><span class="masked" aria-label="Hidden">••••••••</span><button class="btn sm" data-show="' + n.id + '">Reveal</button></div>';
      else {
        h += (n.body ? '<p class="notebody">' + esc(n.body) + '</p>' : '');
        if (n.rows.length) { var cols = Math.max.apply(null, n.rows.map(function (r) { return r.length; })); h += '<div class="tw"><table><thead><tr>' + Array.from({ length: cols }, function (_, i) { return '<th>' + (i === 0 ? 'Item' : i === 1 ? 'Detail' : 'Column ' + (i + 1)) + '</th>'; }).join('') + '</tr></thead><tbody>' + n.rows.map(function (r) { return '<tr>' + r.map(function (c) { return '<td>' + esc(c) + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table></div>'; }
        if (n.private) h += '<div><button class="btn sm" data-hide="' + n.id + '">Hide</button></div>';
      }
      h += (n.tags ? '<small class="hint">' + esc(n.tags) + '</small>' : '') + '</article>';
    });
    h += (O.notes.length ? (list.length ? '' : '<p class="hint">No note matches that search.</p>') : '<div class="card empty">No notes yet. Save depot access details, fuel codes and trip notes here.</div>') + '</div></div>';
    main.innerHTML = h;
    click('nt-new', function () { noteEditor({ id: APS.uid(), title: '', body: '', rows: [], tags: '', favourite: false, private: true, updatedAt: new Date().toISOString() }, false); });
    on('nt-search', 'input', function (e) { ui.noteSearch = e.target.value; var p = e.target.selectionStart; draw('notes'); var n = document.getElementById('nt-search'); n.focus(); try { n.setSelectionRange(p, p); } catch (x) {} });
    each('[data-pin]', function (b) { b.addEventListener('click', function () { quiet(mutate(function (w) { var x = w.notes.find(function (n) { return n.id === b.dataset.pin; }); x.favourite = !x.favourite; })).then(function () { draw('notes'); }); }); });
    each('[data-show]', function (b) { b.addEventListener('click', function () { ui.shown[b.dataset.show] = 1; draw('notes'); }); });
    each('[data-hide]', function (b) { b.addEventListener('click', function () { delete ui.shown[b.dataset.hide]; draw('notes'); }); });
    each('[data-edit]', function (b) { b.addEventListener('click', function () { var n = O.notes.find(function (x) { return x.id === b.dataset.edit; }); if (n.sealed) unlockNote(n); else noteEditor(APS.clone(n), false); }); });
  }
  function unlockNote(n) {
    sheet('Unlock ' + n.title, '<div class="form" style="grid-template-columns:1fr">' + fld('ul-pass', 'Note passphrase', '', { type: 'password' }) + '</div><p class="hint" id="ul-msg" role="status"></p><div class="tools"><button class="btn pri" id="ul-ok">Unlock note</button></div>', function (bd, close) {
      var go = function () {
        var btn = bd.querySelector('#ul-ok'); btn.disabled = true; bd.querySelector('#ul-msg').textContent = 'Unlocking…';
        APS.decryptBackup(n.sealed, bd.querySelector('#ul-pass').value).then(function (t) {
          var d = JSON.parse(t);
          if (typeof d.body !== 'string' || !Array.isArray(d.rows) || d.rows.some(function (r) { return !Array.isArray(r) || r.some(function (c) { return typeof c !== 'string'; }); })) throw Error('Invalid note contents.');
          close(); var c = APS.clone(n); c.body = d.body; c.rows = d.rows; noteEditor(c, true);
        }).catch(function (e) { btn.disabled = false; bd.querySelector('#ul-msg').textContent = /passphrase/i.test(e.message) ? 'Wrong passphrase. The note was not changed.' : e.message; });
      };
      bd.querySelector('#ul-ok').addEventListener('click', go); bd.querySelector('#ul-pass').addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });
    }, 'small');
  }
  function noteEditor(draft, wasSealed) {
    var enc = !!wasSealed, pass = '', exists = O.notes.some(function (n) { return n.id === draft.id; });
    sheet(exists ? 'Edit note' : 'New note', '', function (bd, close) {
      function paint() {
        bd.innerHTML = '<div class="form" style="grid-template-columns:1fr">' + fld('ne-title', 'Title', draft.title) + fld('ne-body', 'Note', draft.body, { type: 'textarea' }) + fld('ne-tags', 'Tags', draft.tags) + '</div>'
          + '<h3 style="margin-top:14px">Table (optional)</h3>' + (draft.rows.length ? '<div class="tw"><table class="edit"><tbody>' + draft.rows.map(function (r, i) { return '<tr>' + r.map(function (c, j) { return '<td><input data-r="' + i + '" data-c="' + j + '" value="' + esc(c) + '" aria-label="Row ' + (i + 1) + ', ' + (j === 0 ? 'item' : 'detail ' + j) + '" placeholder="' + (j === 0 ? 'Item' : 'Detail') + '"></td>'; }).join('') + '<td><button class="btn sm" data-rmrow="' + i + '">Remove</button></td></tr>'; }).join('') + '</tbody></table></div>' : '')
          + '<div class="tools" style="margin-top:8px"><button class="btn" id="ne-row">+ Row</button><button class="btn" id="ne-col"' + (draft.rows.length ? '' : ' disabled') + '>+ Column</button></div>'
          + '<div class="stack" style="gap:8px;margin-top:14px">' + chk('ne-fav', 'Pin to the top', draft.favourite) + chk('ne-private', 'Hide contents until revealed', draft.private) + chk('ne-enc', 'Encrypt note contents with a passphrase', enc) + '</div>'
          + (enc ? '<div class="form" style="grid-template-columns:1fr;margin-top:8px">' + fld('ne-pass', wasSealed ? 'Passphrase (enter it again to lock, or a new one to change it)' : 'Note passphrase (at least 12 characters)', pass, { type: 'password' }) + '</div>' : '')
          + '<p class="hint" style="margin-top:8px">' + (enc ? 'Title and tags remain visible. Keep your passphrase; it cannot be recovered.' : 'Hiding protects the screen view. The saved contents and backups remain readable.') + '</p>'
          + '<div class="tools" style="margin-top:12px"><button class="btn pri" id="ne-save">' + (enc ? 'Save & lock' : 'Save note') + '</button><button class="btn" id="ne-cancel">Cancel</button>' + (exists ? '<button class="btn danger" id="ne-del">Delete</button>' : '') + '</div>';
        var q = function (s) { return bd.querySelector(s); };
        q('#ne-title').addEventListener('input', function (e) { draft.title = e.target.value; }); q('#ne-body').addEventListener('input', function (e) { draft.body = e.target.value; }); q('#ne-tags').addEventListener('input', function (e) { draft.tags = e.target.value; });
        bd.querySelectorAll('input[data-r]').forEach(function (i) { i.addEventListener('input', function () { draft.rows[+i.dataset.r][+i.dataset.c] = i.value; }); });
        bd.querySelectorAll('[data-rmrow]').forEach(function (b) { b.addEventListener('click', function () { draft.rows.splice(+b.dataset.rmrow, 1); paint(); }); });
        q('#ne-row').addEventListener('click', function () { draft.rows.push(new Array((draft.rows[0] || []).length || 2).fill('')); paint(); });
        q('#ne-col').addEventListener('click', function () { draft.rows.forEach(function (r) { r.push(''); }); paint(); });
        q('#ne-fav').addEventListener('change', function (e) { draft.favourite = e.target.checked; }); q('#ne-private').addEventListener('change', function (e) { draft.private = e.target.checked; });
        q('#ne-enc').addEventListener('change', function (e) { enc = e.target.checked; paint(); });
        if (enc) q('#ne-pass').addEventListener('input', function (e) { pass = e.target.value; });
        q('#ne-cancel').addEventListener('click', close);
        if (exists) q('#ne-del').addEventListener('click', function () { confirmBox('Delete note?', '“' + (draft.title || 'Untitled') + '” will be removed from this device.', 'Delete note', function () { return mutate(function (w) { APS.audit(w, 'Delete note', draft.id, undefined, { title: (w.notes.find(function (n) { return n.id === draft.id; }) || {}).title }); w.notes = w.notes.filter(function (n) { return n.id !== draft.id; }); }).then(function () { close(); draw('notes'); }); }); });
        q('#ne-save').addEventListener('click', function () {
          if (!draft.title.trim()) return toast('Enter a note title.');
          var next = APS.clone(draft), btn = q('#ne-save'); btn.disabled = true;
          var p = enc ? APS.encryptBackup(JSON.stringify({ body: next.body, rows: next.rows }), pass).then(function (sealed) { next.sealed = sealed; next.body = ''; next.rows = []; }) : Promise.resolve().then(function () { delete next.sealed; });
          p.then(function () { next.updatedAt = new Date().toISOString(); return mutate(function (w) { var ix = w.notes.findIndex(function (n) { return n.id === next.id; }); if (ix >= 0) w.notes[ix] = next; else w.notes.push(next); }); })
            .then(function () { close(); draw('notes'); }, function (e) { btn.disabled = false; if (e && e.message) toast(e.message); });
        });
      }
      paint();
    });
  }
  document.addEventListener('visibilitychange', function () { if (document.hidden && Object.keys(ui.shown).length) { ui.shown = {}; if (current === 'notes') draw('notes'); } });

  /* ================= DOCUMENTS ================= */
  function viewDocuments() {
    var Dm = APS.documents, total = O.documents.reduce(function (n, d) { return n + d.size; }, 0), today = WD.keyOf(WD.nowBase().n), q = ui.docSearch.toLowerCase();
    var list = O.documents.filter(function (d) { return (d.title + ' ' + d.category).toLowerCase().indexOf(q) >= 0; }).sort(function (a, b) { return Number(b.pinned) - Number(a.pinned) || a.title.localeCompare(b.title); });
    var soon = WD.keyOf(WD.nowBase().n + 30);
    var h = '<div class="wrap">' + tabs('documents') + '<div class="datebar"><div class="day">Documents</div><label class="btn pri" for="dc-file">+ Add document<input type="file" id="dc-file" accept="application/pdf,image/jpeg,image/png,image/webp" hidden></label></div><div class="form" style="grid-template-columns:1fr">' + fld('dc-search', 'Search documents', ui.docSearch, { type: 'search' }) + '</div>'
      + '<p class="hint">Saved on this device · ' + (total / 1048576).toFixed(1) + ' / ' + (Dm.MAX_DOCUMENT_TOTAL / 1048576) + ' MB · PDF, JPG, PNG or WebP up to 8 MB each · Files are included in backups.</p><div class="stack">';
    list.forEach(function (d) {
      var exp = d.expiry ? (d.expiry < today ? '<span class="chip bad">Expired ' + APS.displayDate(d.expiry) + '</span>' : d.expiry <= soon ? '<span class="chip warn">Expires ' + APS.displayDate(d.expiry) + '</span>' : '<span class="chip">Expires ' + APS.displayDate(d.expiry) + '</span>') : '';
      h += '<section class="card stack" style="gap:10px"><div class="datebar"><div style="margin-right:auto"><h3 style="color:var(--ink)">' + (d.pinned ? '★ ' : '') + esc(d.title) + '</h3><span class="hint">' + esc(d.category) + ' · ' + (d.size / 1024).toFixed(0) + ' KB</span> ' + exp + '</div><button class="btn pri" data-show="' + d.id + '">Show document</button></div><div class="tools"><button class="btn sm" data-edit="' + d.id + '">Edit details</button><button class="btn sm" data-pin="' + d.id + '">' + (d.pinned ? 'Unpin' : 'Pin') + '</button><button class="btn sm danger" data-del="' + d.id + '">Delete</button></div></section>';
    });
    h += (O.documents.length ? (list.length ? '' : '<p class="hint">No document matches that search.</p>') : '<div class="card empty">No documents yet. Keep certificates, police checks and licences here, ready to show with no signal.</div>') + '</div></div>';
    main.innerHTML = h;
    on('dc-search', 'input', function (e) { ui.docSearch = e.target.value; var p = e.target.selectionStart; draw('documents'); var n = document.getElementById('dc-search'); n.focus(); try { n.setSelectionRange(p, p); } catch (x) {} });
    on('dc-file', 'change', function (e) {
      var file = e.target.files[0]; e.target.value = ''; if (!file) return;
      Dm.makeDocument(file).then(function (d) {
        if (O.documents.some(function (x) { return x.hash === d.hash; })) throw Error('This file is already in Documents.');
        if (total + d.size > Dm.MAX_DOCUMENT_TOTAL) throw Error('Documents are full (24 MB). Delete a document to make room.');
        docDetails(d, true);
      }).catch(function (er) { toast(er.message || 'That file could not be read.'); });
    });
    each('[data-edit]', function (b) { b.addEventListener('click', function () { docDetails(Object.assign({}, O.documents.find(function (x) { return x.id === b.dataset.edit; })), false); }); });
    each('[data-pin]', function (b) { b.addEventListener('click', function () { quiet(mutate(function (w) { var x = w.documents.find(function (d) { return d.id === b.dataset.pin; }); x.pinned = !x.pinned; })).then(function () { draw('documents'); }); }); });
    each('[data-del]', function (b) { b.addEventListener('click', function () { var d = O.documents.find(function (x) { return x.id === b.dataset.del; }); confirmBox('Delete document?', 'Remove ' + d.title + ' from your documents?', 'Delete document', function () { return mutate(function (w) { w.documents = w.documents.filter(function (x) { return x.id !== d.id; }); APS.audit(w, 'Delete document', d.id, { title: d.title }); }).then(function () { return fileDel(d.hash).catch(function () {}); }).then(function () { draw('documents'); }); }); }); });
    each('[data-show]', function (b) { b.addEventListener('click', function () { showDoc(O.documents.find(function (x) { return x.id === b.dataset.show; })); }); });
  }
  function docDetails(d, isNew) {
    sheet(isNew ? 'Save document' : 'Document details', '<div class="form" style="grid-template-columns:1fr">' + fld('dd-title', 'Document name', d.title) + fld('dd-cat', 'Document type', d.category, { options: APS.documents.documentCategories }) + fld('dd-exp', 'Expiry date (optional)', d.expiry, { type: 'date' }) + '</div><div style="margin:10px 0">' + chk('dd-pin', 'Pin for quick access', d.pinned) + '</div><div class="tools"><button class="btn pri" id="dd-save">Save document</button></div>', function (bd, close) {
      bd.querySelector('#dd-save').addEventListener('click', function () {
        var title = bd.querySelector('#dd-title').value.trim(); if (!title) return toast('Enter a document name.');
        var rec = Object.assign({}, d, { title: title, category: bd.querySelector('#dd-cat').value, expiry: bd.querySelector('#dd-exp').value, pinned: bd.querySelector('#dd-pin').checked }), data = rec.data; delete rec.data;
        // file bytes first: details are never saved as if the upload worked when the file is missing
        var p = isNew ? filePut(rec.hash, data) : Promise.resolve();
        quiet(p.then(function () { return mutate(function (w) {
          var ix = w.documents.findIndex(function (x) { return x.id === rec.id; });
          if (ix < 0) { if (w.documents.some(function (x) { return x.hash === rec.hash; })) throw Error('This file is already in Documents.'); APS.documents.validateDocument(rec); w.documents.push(rec); } else w.documents[ix] = rec;
          APS.audit(w, ix < 0 ? 'Add document' : 'Edit document details', rec.id, undefined, { title: rec.title, category: rec.category, expiry: rec.expiry });
        }); }, function () { toast('The file could not be saved on this device. Free some space and try again.'); throw 0; }).then(function () { close(); draw('documents'); }));
      });
    }, 'small');
  }
  function showDoc(d) {
    fileGet(d.hash).then(function (data) {
      if (!data) throw Error('The file for “' + d.title + '” is missing on this device. Its details are kept. Load a backup that includes it, or add the file again.');
      var bytes = APS.documents.decodeDocument(data);
      return APS.documents.fileHash(bytes).then(function (hh) { if (hh !== d.hash) throw Error('The saved file for “' + d.title + '” is damaged. Its details are kept. Load a backup or add the file again.'); return APS.documents.documentBlob(data, d.mime); });
    }).then(function (blob) {
      var url = URL.createObjectURL(blob);
      sheet(d.title, '<div class="tools"><button class="btn" id="dv-share">Share</button><button class="btn" id="dv-dl">Download</button><a class="btn" href="' + url + '" target="_blank" rel="noopener noreferrer">Open full screen</a></div><div class="docview">' + (d.mime === 'application/pdf' ? '<iframe title="' + esc(d.title) + '" src="' + url + '" referrerpolicy="no-referrer"></iframe>' : '<img src="' + url + '" alt="' + esc(d.title) + '">') + '</div>', function (bd, close, onClose) {
        onClose(function () { setTimeout(function () { URL.revokeObjectURL(url); }, 1000); });
        bd.querySelector('#dv-share').addEventListener('click', function () { shareFile(blob, d.filename).catch(function (e) { toast(e.message || 'Sharing did not work.'); }); });
        bd.querySelector('#dv-dl').addEventListener('click', function () { download(blob, d.filename); });
      }, 'wide');
    }).catch(function (e) { toast(e.message || 'The document could not be opened.'); });
  }

  /* ---------- entry points ---------- */
  var VIEWS = { invoices: viewInvoices, forms: viewForms, notes: viewNotes, documents: viewDocuments }, current = '';
  /* ---------- trips to invoices: ask when work finishes, fill the invoice from the diary ---------- */
  var DOWN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  function autoCfg(w) { var a = (w.invoiceSettings && w.invoiceSettings.auto) || {}; return { ask: a.ask !== false, start: a.start == null ? 1 : +a.start, end: a.end == null ? 6 : +a.end, type: a.type || '' }; }
  function ordKey(k) { var p = String(k).split(':'); return p[0] + ':' + ('00' + p[1]).slice(-3); }
  function changeKind(date, slot) { // 'start' = rest to work, 'end' = work to rest
    var d = WD.S.days[date], s = d && d.s; if (!s) return '';
    var prev = slot > 0 ? s[slot - 1] : ((WD.S.days[WD.keyOf(WD.dayNum(date) - 1)] || {}).s || '')[95] || 'r';
    return s[slot] === 'w' && prev !== 'w' ? 'start' : s[slot] !== 'w' && prev === 'w' ? 'end' : '';
  }
  function invPeriod(date, cfg) { var n = WD.dayNum(date), dow = new Date(n * 864e5).getUTCDay(), from = n - ((dow - cfg.start + 7) % 7), len = (cfg.end - cfg.start + 7) % 7, to = from + len; if (to < n) { from = n; to = n - ((dow - cfg.start + 7) % 7) + 7 + len; } return { from: WD.keyOf(from), to: WD.keyOf(to) }; }
  function draftFor(w, p, date) { return w.invoices.find(function (x) { return x.status === 'Draft' && x.dateFrom && x.dateTo && (x.dateTo === p.to || (x.dateFrom <= date && date <= x.dateTo)); }); }
  function placeKey(p) { return String(p || '').toLowerCase().trim().split(',')[0].trim(); }
  function tripAsk(endKey, manual) {
    return load().then(function () {
      attach(O); var I = APS.invoices, cfg = autoCfg(O); if (!manual && (!cfg.ask || !partOn('invoices'))) return;
      var all = I.tripChoices(withDays(O), '0000-01-01', '9999-12-31');
      var used = {}, lastEnd = ''; O.invoices.forEach(function (x) { x.loads.forEach(function (r) { if (r.sourceId) { var e = r.sourceId.split('|')[1]; used[e] = 1; if (ordKey(e) > lastEnd) lastEnd = ordKey(e); } }); });
      if (!endKey) { var ends = all.filter(function (c) { return changeKind(c.date, c.slot) === 'end' && c.location && c.odometer && !used[c.key]; }); if (!ends.length) { toast('No finished trip was found. In the Diary, add the place and odometer where you stopped work.'); return; } endKey = ends[ends.length - 1].key; }
      var end = all.find(function (c) { return c.key === endKey; });
      if (!end || !end.location || !end.odometer) { if (manual) toast('Add the place and odometer where you stopped work first.'); return; }
      if (used[endKey]) { if (manual) toast('That trip is already on an invoice.'); return; }
      var cands = all.filter(function (c) { return ordKey(c.key) < ordKey(endKey) && ordKey(c.key) >= lastEnd && c.location && c.odometer && changeKind(c.date, c.slot) === 'start' && WD.dayNum(end.date) - WD.dayNum(c.date) <= 6 && Number(c.odometer) <= Number(end.odometer); });
      if (!cands.length) { if (manual || O.invoices.length) toast('To put this trip on your invoice, add the place and odometer where the trip started in the Diary.', 7000); return; }
      var st = O.invoiceSettings, code = function (p) { return I.cityFor(p, O.routeMap || {}); }, types = st.types.length ? st.types : ['BD'], rateOf = function (item) { return st.miscItemRates[item] || '50'; };
      var yn = [['0', 'No'], ['1', 'Yes · 1'], ['2', 'Yes · 2'], ['3', 'Yes · 3'], ['4', 'Yes · 4']];
      sheet('Trip finished?', '<p class="hint">If your trip ends here, the app puts it on your invoice with the places and odometers from your diary. You can still change anything on the invoice.</p>'
        + '<div class="form" style="grid-template-columns:1fr">' + fld('ta-start', 'The trip started at', cands[0].key, { options: cands.map(function (c) { return [c.key, APS.displayDate(c.date) + ' ' + WD.clock(c.slot) + ' · ' + c.location + ' · ' + c.odometer]; }) }) + '</div>'
        + '<div class="form tripform" style="margin-top:12px">' + fld('ta-from', 'From', '', { list: 'ta-cities' }) + fld('ta-to', 'To', code(end.location), { list: 'ta-cities' }) + '</div><datalist id="ta-cities">' + st.cities.map(function (c) { return '<option value="' + esc(c) + '">'; }).join('') + '</datalist>'
        + '<div class="tripstats" style="margin-top:12px"><div><small>Start odometer</small><b id="ta-o1"></b></div><div><small>Finish odometer</small><b>' + esc(end.odometer) + '</b></div><div><small>Distance</small><b id="ta-km"></b></div></div>'
        + '<div class="form tripform" style="margin-top:12px">' + fld('ta-type', 'Load type', types.indexOf(cfg.type) >= 0 ? cfg.type : types[0], { options: types }) + '<span></span>'
        + fld('ta-pu', 'Pick-up on this trip?', '0', { options: yn }) + fld('ta-pur', 'Pick-up rate $', rateOf('Pick-up'), { type: 'number' }) + fld('ta-de', 'Delivery on this trip?', '0', { options: yn }) + fld('ta-der', 'Delivery rate $', rateOf('Delivery'), { type: 'number' }) + '</div>'
        + '<p class="note" id="ta-per" style="margin-top:12px;border-color:var(--work);color:var(--ink)"></p><div class="tools" style="margin-top:12px"><button class="btn pri" id="ta-ok">Add to my invoice</button><button class="btn" id="ta-no">Trip not finished yet</button></div>', function (bd, close) {
        var g = function (id) { return bd.querySelector(id); }, startOf = function () { return cands.find(function (c) { return c.key === g('#ta-start').value; }) || cands[0]; };
        function sync(setFrom) {
          var s = startOf(), p = invPeriod(s.date, cfg); if (setFrom) g('#ta-from').value = code(s.location);
          g('#ta-o1').textContent = s.odometer; g('#ta-km').textContent = (Number(end.odometer) - Number(s.odometer)).toLocaleString('en-AU') + ' km';
          var has = draftFor(O, p, s.date);
          g('#ta-per').textContent = has ? 'Goes on your draft invoice ' + has.invoiceNo + ' (' + APS.displayDate(has.dateFrom) + ' to ' + APS.displayDate(has.dateTo) + ').' : 'A new invoice is started for ' + APS.displayDate(p.from) + ' to ' + APS.displayDate(p.to) + '.';
        }
        g('#ta-start').addEventListener('change', function () { sync(true); }); sync(true);
        g('#ta-no').addEventListener('click', close);
        g('#ta-ok').addEventListener('click', function () {
          var s = startOf(), from = g('#ta-from').value.trim().toUpperCase(), to = g('#ta-to').value.trim().toUpperCase(), type = g('#ta-type').value, info = {};
          var extra = [['Pick-up', +g('#ta-pu').value, g('#ta-pur').value.trim()], ['Delivery', +g('#ta-de').value, g('#ta-der').value.trim()]];
          quiet(mutate(function (w) {
            var row = I.tripLoad(withDays(w), s.key, endKey), c2 = autoCfg(w), p = invPeriod(row.loadDate, c2);
            if (w.invoices.some(function (x) { return x.loads.some(function (r) { return r.sourceId === row.sourceId; }); })) throw Error('This diary trip is already on an invoice.');
            w.routeMap = w.routeMap || {};
            if (from) { if (from !== row.from) w.routeMap[placeKey(s.location)] = from; row.from = from; } if (to) { if (to !== row.to) w.routeMap[placeKey(end.location)] = to; row.to = to; }
            [from, to].forEach(function (c) { if (c && c.length <= 4 && w.invoiceSettings.cities.indexOf(c) < 0) w.invoiceSettings.cities.push(c); });
            row.type = type; row.rate = w.invoiceSettings.typeRates[type] || ''; if (I.isCO(type)) row.fixedAmount = row.rate;
            try { Object.assign(row, I.calculateLoad(row)); } catch (e) { /* no rate yet: the row stays a draft */ }
            var inv = draftFor(w, p, row.loadDate);
            if (!inv) { inv = I.newInvoice(w); inv.gst = w.invoiceSettings.gst || ''; inv.dateFrom = p.from; inv.dateTo = p.to; inv.loads = []; w.invoices.push(inv); w.invoiceSettings.nextInvoiceNo++; info.fresh = true; }
            if (inv.dateFrom > row.loadDate) inv.dateFrom = row.loadDate;
            inv.loads = inv.loads.filter(I.activeLoad); inv.loads.push(row);
            extra.forEach(function (x) { if (!(x[1] > 0)) return; var m = Object.assign(I.blankMisc(), { date: row.loadDate, item: x[0], quantity: String(x[1]), rate: x[2] }); try { Object.assign(m, I.calculateMisc(m)); } catch (e) {} inv.misc.push(m); if (x[2]) w.invoiceSettings.miscItemRates[x[0]] = x[2]; if (w.invoiceSettings.miscItems.indexOf(x[0]) < 0) w.invoiceSettings.miscItems.push(x[0]); });
            w.invoiceSettings.auto = Object.assign({}, w.invoiceSettings.auto, { type: type }); inv.updatedAt = new Date().toISOString();
            info.no = inv.invoiceNo; info.id = inv.id; info.noRate = !row.rate; info.route = row.from + ' to ' + row.to; info.km = row.km;
          })).then(function () { if (!info.id) return; close(); toast(info.route + ', ' + Number(info.km).toLocaleString('en-AU') + ' km, added to invoice ' + info.no + '.' + (info.noRate ? ' Set the rate for this load type on the invoice once. It is remembered.' : ''), 8000); if (current === 'invoices') draw('invoices'); });
        });
      });
    });
  }
  window.WDOffice = {
    tripAsk: tripAsk, sigPad: sigPad, readImage: readImage,
    // first set-up: company name, logo and signature become the form defaults (nothing is required)
    saveProfile: function (x) { return load().then(function () { return mutate(function (w) { var F = APS.forms, d = F.getFormDefaults(w); if (x.name) d.driver = x.name; if (x.licence) d.licence = x.licence; if (x.company != null) { d.company = x.company; d.showCompany = !!x.company; } if (x.logo) { d.logo = x.logo; d.showLogo = true; } if (x.signature) d.signature = x.signature; w.formDefaults = w.formDefaults || {}; w.formDefaults[w.profile.id] = d; }); }); },
    wipe: function () { return new Promise(function (res) { try { var r = indexedDB.deleteDatabase('workdiary-office'); r.onsuccess = r.onerror = r.onblocked = function () { res(); }; } catch (e) { res(); } setTimeout(res, 1500); }); },
    views: Object.keys(VIEWS),
    render: function (view) {
      if (!partOn(view)) { var nx = TABS.filter(function (t) { return partOn(t[0]); })[0]; if (nx[0] !== view) { location.hash = '#' + nx[0]; return; } }
      current = view;
      if (!O) main.innerHTML = '<div class="wrap">' + tabs(view) + '<p class="hint">Loading…</p></div>';
      load().then(function () { if (current === view) { attach(O); VIEWS[view](); } }, function (e) { main.innerHTML = '<div class="wrap">' + tabs(view) + '<p class="note warn">' + esc(e.message) + '</p></div>'; });
    },
    leave: function () { current = ''; },
    exportData: function () { // for the backup file: records plus document files
      return load().then(function () { var files = {}; return Promise.all(O.documents.map(function (d) { return fileGet(d.hash).then(function (v) { if (v) files[d.hash] = v; }); })).then(function () { return { office: stored(O), files: files }; }); });
    },
    importData: function (office, files) {
      return load().then(function () {
        if (!office || !Array.isArray(office.invoices) || !Array.isArray(office.forms) || !Array.isArray(office.notes) || !Array.isArray(office.documents)) throw Error('The paperwork in that backup could not be read.');
        var puts = Object.keys(files || {}).map(function (h) { return filePut(h, files[h]); });
        return Promise.all(puts).then(function () { O = attach(Object.assign(blank(), office)); return kvPut('office', stored(O)); });
      });
    },
    syncState: function () { return load().then(function () { var c = stored(O); delete c.audit; return structuredClone(c); }); },
    mergeRemote: function (remote) {
      return load().then(function () {
        if (!remote || !Array.isArray(remote.invoices) || !Array.isArray(remote.forms) || !Array.isArray(remote.notes) || !Array.isArray(remote.documents)) return false;
        var before = stored(O), merged = mergeOffice(before, remote); merged.audit = before.audit;
        var a = Object.assign({}, before), b = Object.assign({}, merged); delete a.audit; delete b.audit; delete a.stamp; delete b.stamp;
        var changed = JSON.stringify(a) !== JSON.stringify(b);
        O = attach(merged); return kvPut('office', stored(O)).then(function () { if (changed && current) draw(current); return changed; });
      });
    },
    fileGet: fileGet, filePut: filePut, busy: function () { return !!document.querySelector('.sheetm'); },
    core: function () { return load().then(function () { return APS; }); }, preview: function (name, pages) { return load().then(function () { docPreview(name, pages); }); }, download: download, shareFile: shareFile,
    counts: function () { return O ? { invoices: O.invoices.length, forms: O.forms.length, notes: O.notes.length, documents: O.documents.length } : null; }
  };
  if (window.WDOffice.views.indexOf((location.hash || '').slice(1)) >= 0) window.dispatchEvent(new Event('hashchange')); else WD.render();
})();
