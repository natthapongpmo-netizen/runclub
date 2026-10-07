/* Shared helpers: API calls to Apps Script + applying the branding from the Google Sheet. */
(function () {
  var CFG = window.APP_CONFIG || {};

  function configured() { return !!CFG.API_URL && CFG.API_URL.indexOf('PASTE') === -1; }

  // Apps Script web apps answer cross-origin fetches only for "simple" requests,
  // so the JSON goes out as text/plain (no CORS preflight).
  function api(action, data) {
    if (!configured()) return Promise.reject(new Error('not_configured'));
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 30000);
    return fetch(CFG.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({ action: action }, data || {})),
      signal: ctrl.signal
    }).then(function (r) {
      if (!r.ok) throw new Error('http_' + r.status);
      return r.json();
    }).then(function (j) {
      if (j && j.status === 'server_error') throw new Error('server_error');
      return j;
    }).finally(function () { clearTimeout(timer); });
  }

  function applyBrand(b) {
    if (!b) return;
    var s = document.documentElement.style;
    s.setProperty('--accent', b.primary);
    s.setProperty('--accent-text', b.primaryText);
    s.setProperty('--bg', b.bg);
    s.setProperty('--text', b.text);
    s.setProperty('--font', '"' + b.font.replace(/["']/g, '') + '", system-ui, -apple-system, "Segoe UI", "Sarabun", sans-serif');
    if (b.fontUrl) {
      var l = document.createElement('link');
      l.rel = 'stylesheet'; l.href = b.fontUrl; document.head.appendChild(l);
    }
    var banner = document.getElementById('banner'), logo = document.getElementById('logo');
    if (banner && b.banner) { banner.src = b.banner; banner.hidden = false; banner.onerror = function () { banner.hidden = true; }; }
    if (logo && b.logo) { logo.src = b.logo; logo.hidden = false; logo.onerror = function () { logo.hidden = true; }; }
    var meta = document.querySelector('meta[name=theme-color]');
    if (meta) meta.content = b.bg;
  }

  function el(id) { return document.getElementById(id); }

  function friendlyError(e) {
    if (e && e.message === 'not_configured') return 'This site is not connected to its backend yet (API_URL is missing in docs/config.js).';
    if (e && e.name === 'AbortError') return 'The server took too long to answer. Please try again.';
    if (!navigator.onLine) return 'You appear to be offline. Please check your connection and try again.';
    return 'Something went wrong talking to the server. Please try again.';
  }

  window.App = { api: api, applyBrand: applyBrand, el: el, configured: configured, friendlyError: friendlyError };
})();
