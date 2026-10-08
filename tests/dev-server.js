// Local stand-in for "Apps Script + Google Sheet + GitHub Pages".
//   node tests/dev-server.js        -> http://localhost:8787
// Runs the real backend/Code.gs against in-memory sheets and serves docs/.
// Dev-only helpers:  GET /_dev/info   GET /_dev/mails   POST /_dev/clock {"offsetMin": N}
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createEnv, formatDate } = require('./fake-gas');

const PORT = process.env.PORT || 8787;
const DOCS = path.join(__dirname, '..', 'docs');
const env = createEnv();
env.ctx.setup();

let offsetMs = 0;
env.ctx.now_ = () => new Date(Date.now() + offsetMs);

const ev = env.sheets.get('Event');
const setEvent = (k, v) => ev.rows.forEach((r) => { if (r[0] === k) r[1] = v; });
setEvent('date', formatDate(new Date(), 'Asia/Bangkok', 'dd-MM-yyyy'));   // today => check-in is open
setEvent('time', '06:00');
setEvent('staff_pin', 'DEVPIN88');
setEvent('site_url', `http://localhost:${PORT}`);
(process.env.EVENT_OVERRIDES || '').split(';').filter(Boolean).forEach((kv) => { const i = kv.indexOf('='); setEvent(kv.slice(0, i), kv.slice(i + 1)); });

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const send = (code, type, body) => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' }); res.end(body); };

  if (req.method === 'POST' && url.pathname === '/api') {
    let body = ''; req.on('data', (c) => (body += c));
    req.on('end', () => send(200, 'application/json', env.ctx.doPost({ postData: { contents: body } }).getContent()));
    return;
  }
  if (url.pathname === '/_dev/info') return send(200, 'application/json', JSON.stringify({ staffPin: 'DEVPIN88', clockOffsetMin: offsetMs / 60000, now: env.ctx.now_().toISOString(), tabs: Object.fromEntries([...env.sheets].map(([k, v]) => [k, v.rows])) }, null, 2));
  if (url.pathname === '/_dev/mails') return send(200, 'application/json', JSON.stringify(env.mails.map((m) => ({ to: m.to, subject: m.subject, body: m.body, htmlBody: m.htmlBody }))));
  if (req.method === 'POST' && url.pathname === '/_dev/clock') {
    let body = ''; req.on('data', (c) => (body += c));
    req.on('end', () => { offsetMs = (JSON.parse(body).offsetMin || 0) * 60000; send(200, 'application/json', JSON.stringify({ offsetMin: offsetMs / 60000 })); });
    return;
  }
  if (url.pathname === '/config.js') return send(200, TYPES['.js'], 'window.APP_CONFIG = { API_URL: "/api" };');

  let file = path.normalize(path.join(DOCS, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(DOCS) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(404, 'text/plain', 'Not found');
  send(200, TYPES[path.extname(file)] || 'application/octet-stream', fs.readFileSync(file));
}).listen(PORT, () => console.log(`Dev server: http://localhost:${PORT}   (staff PIN: DEVPIN88)`));
