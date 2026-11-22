/* Google Drive sync. No server: the app signs in with Google in the browser and keeps one sync file,
   the document files and dated backup copies in a "APS Logbook" folder in the driver's own Drive.
   Scope drive.file: the app can only see files it created itself. */
(function () {
  'use strict';
  var WD = window.WD, K = 'workdiary.drive', OK = 'workdiary.oauth', SCOPE = 'https://www.googleapis.com/auth/drive.file';
  var AUTH = 'https://accounts.google.com/o/oauth2/v2/auth', API = 'https://www.googleapis.com', FOLDER = 'APS Logbook', MAIN = 'sync.json', KEEP = 10;
  var cfg = { clientId: '', connected: false, token: '', exp: 0, folderId: '', fileId: '', version: '', hash: '', lastSync: 0, backupDay: '' };
  try { Object.assign(cfg, JSON.parse(localStorage.getItem(K) || '{}')); } catch (e) {}
  var busy = false, again = false, timer = null, state = 'off', note = '';
  function keep() { try { localStorage.setItem(K, JSON.stringify(cfg)); } catch (e) {} }
  function tokenOk() { return !!cfg.token && Date.now() < cfg.exp; }
  function redirectUri() { return location.origin + location.pathname; }

  /* ---------- sign-in (OAuth 2.0 for client-side web apps, redirect) ---------- */
  function signIn(silent) {
    if (!cfg.clientId) { WD.toast('Paste your Google Client ID first.'); return; }
    if (!navigator.onLine) { WD.toast('No internet. Sign in when you are online.'); return; }
    var st = Math.random().toString(36).slice(2) + Date.now().toString(36);
    try { localStorage.setItem(OK, JSON.stringify({ state: st, silent: !!silent, back: location.hash || '#more' })); } catch (e) {}
    var q = new URLSearchParams({ client_id: cfg.clientId, redirect_uri: redirectUri(), response_type: 'token', scope: SCOPE, state: st, include_granted_scopes: 'true' });
    if (silent) q.set('prompt', 'none');
    location.assign(AUTH + '?' + q.toString());
  }
  (function comeBack() { // Google sends the driver back here with the token in the address
    var h = location.hash.slice(1); if (!/(^|&)state=/.test(h) || !/(^|&)(access_token|error)=/.test(h)) return;
    var p = new URLSearchParams(h), saved = null; try { saved = JSON.parse(localStorage.getItem(OK) || 'null'); } catch (e) {}
    try { localStorage.removeItem(OK); } catch (e) {}
    history.replaceState(null, '', location.pathname + location.search + ((saved && saved.back) || '#more'));
    if (!saved || p.get('state') !== saved.state) { note = 'Google sign-in could not be checked. Try again.'; }
    else if (p.get('access_token')) { cfg.token = p.get('access_token'); cfg.exp = Date.now() + ((+p.get('expires_in') || 3600) - 90) * 1000; cfg.connected = true; keep(); }
    else if (saved.silent && /interaction_required|login_required|consent_required|account_selection_required/.test(p.get('error') || '')) { setTimeout(function () { signIn(false); }, 0); return; }
    else note = p.get('error') === 'access_denied' ? 'Google sign-in was cancelled.' : 'Google sign-in failed (' + (p.get('error') || 'unknown') + ').';
    window.dispatchEvent(new Event('hashchange'));
  })();

  /* ---------- Drive calls ---------- */
  function api(path, opt) {
    opt = opt || {}; var headers = Object.assign({ Authorization: 'Bearer ' + cfg.token }, opt.headers || {});
    return fetch(API + path, Object.assign({}, opt, { headers: headers })).then(function (r) {
      if (r.status === 401) { cfg.token = ''; cfg.exp = 0; keep(); throw { auth: true }; }
      if (r.status === 404) throw { gone: true };
      if (!r.ok) return r.text().then(function (t) { var m = ''; try { m = JSON.parse(t).error.message; } catch (e) {} throw Error('Google Drive said: ' + (m || 'error ' + r.status)); });
      return r;
    });
  }
  function list(q, fields) { return api('/drive/v3/files?spaces=drive&pageSize=200&orderBy=name&q=' + encodeURIComponent(q + ' and trashed=false') + '&fields=' + encodeURIComponent('files(' + (fields || 'id,name,version') + ')')).then(function (r) { return r.json(); }).then(function (j) { return j.files || []; }); }
  function create(name, parent, text, mime) {
    var b = 'wd' + Date.now(), meta = { name: name, parents: parent ? [parent] : undefined, mimeType: mime || 'application/json' };
    var body = '--' + b + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(meta) + '\r\n--' + b + '\r\nContent-Type: ' + (mime || 'application/json') + '\r\n\r\n' + (text || '') + '\r\n--' + b + '--';
    return api('/upload/drive/v3/files?uploadType=multipart&fields=id,version', { method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + b }, body: body }).then(function (r) { return r.json(); });
  }
  function update(id, text) { return api('/upload/drive/v3/files/' + id + '?uploadType=media&fields=id,version', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: text }).then(function (r) { return r.json(); }); }
  function read(id) { return api('/drive/v3/files/' + id + '?alt=media').then(function (r) { return r.text(); }); }
  function folder() {
    if (cfg.folderId) return Promise.resolve(cfg.folderId);
    return list("name='" + FOLDER + "' and mimeType='application/vnd.google-apps.folder' and 'root' in parents").then(function (f) {
      if (f.length) return f[0];
      return api('/drive/v3/files?fields=id', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: FOLDER, mimeType: 'application/vnd.google-apps.folder' }) }).then(function (r) { return r.json(); });
    }).then(function (f) { cfg.folderId = f.id; keep(); return f.id; });
  }
  function hashOf(s) { var h = 5381, i = s.length; while (i) h = (h * 33) ^ s.charCodeAt(--i); return (h >>> 0).toString(36) + ':' + s.length; }

  /* ---------- sync ---------- */
  function sync(manual) {
    if (!cfg.connected) return Promise.resolve();
    if (!navigator.onLine) { set('wait', 'No internet. Will sync when you are back online.'); return Promise.resolve(); }
    if (!tokenOk()) { set('need', 'Tap to sign in to Google again.'); return Promise.resolve(); }
    if (busy) { again = true; return Promise.resolve(); }
    busy = true; set('sync', 'Syncing…');
    var fid, files, mainFile, pulled = false, office;
    return folder().then(function (id) { fid = id; return list("'" + fid + "' in parents"); }).then(function (all) {
      files = {}; all.forEach(function (f) { files[f.name] = f; }); mainFile = files[MAIN];
      if (!mainFile || (mainFile.id === cfg.fileId && String(mainFile.version) === String(cfg.version))) return null;
      return read(mainFile.id).then(function (t) { try { return JSON.parse(t); } catch (e) { return null; } });
    }).then(function (remote) {
      if (!remote || remote.app !== 'work-diary-sync') return;
      pulled = WD.applyRemote(remote.days, remote.settings);
      return (window.WDOffice && remote.office ? window.WDOffice.mergeRemote(remote.office) : Promise.resolve(false)).then(function (ch) { pulled = pulled || ch; });
    }).then(function () { return window.WDOffice ? window.WDOffice.syncState() : null; }).then(function (o) {
      office = o; if (!office) return;
      // document files travel as separate Drive files, one per document
      return office.documents.reduce(function (p, d) {
        var name = 'doc-' + d.hash + '.txt';
        return p.then(function () { return window.WDOffice.fileGet(d.hash); }).then(function (local) {
          if (local && !files[name]) return create(name, fid, local, 'text/plain');
          if (!local && files[name]) return read(files[name].id).then(function (t) { return window.WDOffice.filePut(d.hash, t); });
        });
      }, Promise.resolve());
    }).then(function () {
      var st = WD.S, body = JSON.stringify({ days: st.days, settings: st.settings, office: office }), h = hashOf(body);
      if (mainFile && h === cfg.hash && mainFile.id === cfg.fileId) { cfg.version = String(mainFile.version); return; }
      var text = JSON.stringify({ app: 'work-diary-sync', v: 1, saved: new Date().toISOString(), days: st.days, settings: st.settings, office: office });
      return (mainFile ? update(mainFile.id, text) : create(MAIN, fid, text)).then(function (f) { cfg.fileId = f.id; cfg.version = String(f.version); cfg.hash = h; mainFile = { id: f.id }; });
    }).then(function () { // one dated backup copy a day, newest ten kept
      var day = new Date().toISOString().slice(0, 10); if (cfg.backupDay === day || !mainFile) return;
      var name = 'backup-' + day + '.json';
      return (files[name] ? Promise.resolve() : api('/drive/v3/files/' + mainFile.id + '/copy?fields=id', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name, parents: [fid] }) })).then(function () {
        cfg.backupDay = day; var old = Object.keys(files).filter(function (n) { return /^backup-\d{4}-\d\d-\d\d\.json$/.test(n); }).sort().reverse().slice(KEEP - 1);
        return old.reduce(function (p, n) { return p.then(function () { return api('/drive/v3/files/' + files[n].id, { method: 'DELETE' }).catch(function () {}); }); }, Promise.resolve());
      });
    }).then(function () {
      cfg.lastSync = Date.now(); keep(); busy = false; set('ok', '');
      if (pulled) { WD.render(); if (manual) WD.toast('Synced. Newer records from another device were added.'); } else if (manual) WD.toast('Synced with Google Drive.');
      if (again) { again = false; return sync(); }
    }).catch(function (e) {
      busy = false; again = false;
      if (e && e.auth) set('need', 'Tap to sign in to Google again.');
      else if (e && e.gone) { cfg.folderId = ''; cfg.fileId = ''; cfg.version = ''; cfg.hash = ''; keep(); set('err', 'The Drive folder was moved or deleted. Tap Sync now to make it again.'); }
      else set('err', (e && e.message) || 'Sync failed. It will try again.');
    });
  }
  function changed() { if (!cfg.connected) return; clearTimeout(timer); timer = setTimeout(function () { sync(); }, 12000); }

  /* ---------- screen ---------- */
  var chip = document.createElement('button'); chip.type = 'button'; chip.id = 'drivechip'; chip.className = 'drivechip'; chip.hidden = true;
  var top = document.querySelector('.top'); if (top) top.insertBefore(chip, top.querySelector('.opt'));
  chip.addEventListener('click', function () { if (state === 'need') signIn(true); else if (state === 'err' || state === 'wait') sync(true); else location.hash = '#more'; });
  function set(s, m) {
    state = s; note = m || '';
    chip.hidden = !cfg.connected; chip.dataset.s = s;
    chip.textContent = s === 'need' ? 'Drive: sign in' : s === 'sync' ? 'Syncing…' : s === 'err' ? 'Drive: retry' : s === 'wait' ? 'Drive: offline' : 'Drive ✓';
    var el = document.getElementById('gd-status'); if (el) el.textContent = statusText();
  }
  function statusText() {
    if (!cfg.connected) return note || 'Not connected.';
    var last = cfg.lastSync ? 'Last synced ' + new Date(cfg.lastSync).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + '.' : 'Not synced yet.';
    return (note ? note + ' ' : state === 'ok' ? 'Connected. ' : '') + last;
  }
  window.WDDrive = {
    changed: changed, connected: function () { return !!cfg.connected; },
    card: function () {
      var e = WD.esc;
      return '<div class="card stack" style="gap:12px"><h3>Google Drive sync</h3><div class="sync" id="gd-status" role="status">' + e(statusText()) + '</div>'
        + (cfg.connected ? '<div class="tools"><button class="btn pri" id="gd-sync">Sync now</button>' + (tokenOk() ? '' : '<button class="btn" id="gd-in">Sign in again</button>') + '<button class="btn danger" id="gd-out">Disconnect</button></div><p class="hint">Changes sync by themselves about 12 seconds after you stop typing, and when you open the app. Google asks you to sign in again about once an hour: tap the Drive button at the top when it says “sign in”. Your files are in the “' + FOLDER + '” folder in your Google Drive, with one backup copy a day (newest ' + KEEP + ' kept).</p>'
          : '<div class="form" style="grid-template-columns:1fr"><label>Google Client ID<input id="gd-id" value="' + e(cfg.clientId) + '" placeholder="1234567890-abc.apps.googleusercontent.com" autocomplete="off" autocapitalize="off" spellcheck="false"></label></div><div class="tools"><button class="btn pri" id="gd-in">Connect Google Drive</button></div><p class="hint">Sign in with the same Google account on each phone or computer to see the same diary, invoices, forms, notes and documents. You need your own Google Client ID once; the steps are in the README file. Address to allow in Google Cloud: <b>' + e(redirectUri()) + '</b></p>') + '</div>';
    },
    bind: function () {
      var id = document.getElementById('gd-id'); if (id) id.addEventListener('change', function () { cfg.clientId = id.value.trim(); keep(); });
      var a = document.getElementById('gd-in'); if (a) a.addEventListener('click', function () { if (id) { cfg.clientId = id.value.trim(); keep(); } if (!/\.apps\.googleusercontent\.com$/.test(cfg.clientId)) return WD.toast('That does not look like a Google Client ID. It ends with .apps.googleusercontent.com'); signIn(false); });
      var s = document.getElementById('gd-sync'); if (s) s.addEventListener('click', function () { if (!tokenOk()) return signIn(true); sync(true); });
      var o = document.getElementById('gd-out'); if (o) o.addEventListener('click', function () { cfg.connected = false; cfg.token = ''; cfg.exp = 0; cfg.folderId = ''; cfg.fileId = ''; cfg.version = ''; cfg.hash = ''; keep(); set('off', 'Disconnected. Your records stay on this device and in your Drive.'); WD.render(); });
    }
  };
  if (cfg.connected) { set(tokenOk() ? 'ok' : 'need', tokenOk() ? '' : 'Tap to sign in to Google again.'); if (tokenOk()) setTimeout(function () { sync(); }, 1500); }
  window.addEventListener('online', function () { if (cfg.connected) sync(); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden && cfg.connected && Date.now() - cfg.lastSync > 120000) sync(); });
  if ((location.hash || '') === '#more') WD.render();
})();
