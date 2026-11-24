/* APS Logbook: offline support. The cache name changes with every build. */
var CACHE = 'work-diary-fbeee42edd';
var FILES = ["./", "index.html", "app.css", "engine.js", "app.js", "office.js", "drive.js", "plan.js", "coach.js", "aps-core.js", "fonts/WorkspaceSans-Regular.ttf", "fonts/WorkspaceSans-Bold.ttf", "templates/safe-driving-original-v1.pdf", "templates/safe-driving-original-v1-page-1.svg", "templates/safe-driving-original-v1-page-2.svg", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png", "fonts/barlow-latin-400-normal.woff2", "fonts/barlow-latin-500-normal.woff2", "fonts/barlow-latin-600-normal.woff2", "fonts/barlow-condensed-latin-600-normal.woff2", "fonts/barlow-condensed-latin-700-normal.woff2"];
self.addEventListener('install', function (e) { e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(FILES); }).then(function () { return self.skipWaiting(); })); });
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) { return Promise.all(ks.filter(function (k) { return k.indexOf('work-diary-') === 0 && k !== CACHE; }).map(function (k) { return caches.delete(k); })); }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== self.location.origin) return; // map lookups always go to the network
  e.respondWith(caches.open(CACHE).then(function (c) {
    return c.match(e.request, { ignoreSearch: true }).then(function (hit) {
      var net = fetch(e.request).then(function (r) { if (r && r.ok) c.put(e.request, r.clone()); return r; }).catch(function () { return hit || c.match('index.html'); });
      return hit || net;
    });
  }));
});
