/**
 * Run Club registration + QR check-in backend.
 * Google Apps Script, bound to the Google Sheet that acts as the database.
 * Run setup() once, then deploy as a Web app (Execute as: Me, Access: Anyone).
 */

var TZ = 'Asia/Bangkok';
var TZ_OFFSET_MS = 7 * 3600 * 1000;           // Bangkok has no DST
var CODE_WINDOW_MS = 5 * 60 * 1000;           // QR valid +/- 5 min around its issue time
var CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

var TAB = { EVENT: 'Event', REG: 'Registrations', CODES: 'Codes', LOG: 'ScanLog' };
var COLS = {
  Registrations: ['id', 'registered_at', 'name', 'email', 'social', 'consent', 'token', 'email_sent', 'checked_in_at', 'checked_in_via'],
  Codes: ['code', 'reg_id', 'issued_at', 'used_at', 'result'],
  ScanLog: ['time', 'code', 'result', 'name', 'via']
};

// key, default value, note shown in column C of the Event tab
var EVENT_DEFAULTS = [
  ['event_name', 'Sunday Morning 10K', 'Event title'],
  ['datetime', '', 'Event start, Bangkok time, format yyyy-MM-dd HH:mm (QR check-in only works on this date)'],
  ['place', 'Lumphini Park, Gate 1', 'Venue'],
  ['route', '2 loops of the park, about 10 km.', 'Route details (line breaks allowed)'],
  ['notes', 'Bring your own bottle.', 'Other details (line breaks allowed)'],
  ['capacity', '50', 'Max registrations (0 = unlimited)'],
  ['banner_url', '', 'Banner image: https link, or a Google Drive share link'],
  ['logo_url', '', 'Logo image: https link (PNG with transparent background or SVG)'],
  ['primary_color', '#0f766e', 'Brand colour, HEX (buttons, accents)'],
  ['bg_color', '#f5f6f8', 'Page background colour, HEX'],
  ['text_color', '#14181f', 'Text colour, HEX'],
  ['font_family', 'system-ui', 'CSS font family name, e.g. Prompt'],
  ['font_url', '', 'Optional Google Fonts stylesheet link (https://fonts.googleapis.com/...)'],
  ['site_url', 'https://YOUR-USER.github.io/YOUR-REPO', 'Public address of the web pages (used for the button in the email)'],
  ['staff_pin', '', 'PIN staff type to open the scanner (keep private)'],
  ['email_sender_name', '', 'Optional sender display name for confirmation emails']
];

// Event keys that are safe to expose to the public registration page.
var PUBLIC_KEYS = ['event_name', 'datetime', 'place', 'route', 'notes'];

var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/* ------------------------------------------------------------------ */
/* Web app entry points                                                */
/* ------------------------------------------------------------------ */

function doGet() {
  return json_({ ok: true, service: 'runclub-checkin' });
}

function doPost(e) {
  var out;
  try {
    var p = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    out = route_(p);
  } catch (err) {
    Logger.log(err && err.stack ? err.stack : String(err));
    out = { ok: false, status: 'server_error' };
  }
  return json_(out);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function route_(p) {
  switch (p.action) {
    case 'config':   return configResponse_();
    case 'register': return register_(p);
    case 'resend':   return resend_(p);
    case 'issue':    return issue_(p);
    case 'login':    return staff_(p, function () { return { status: 'ok' }; });
    case 'verify':   return staff_(p, function () { return verify_(p.code); });
    case 'search':   return staff_(p, function () { return search_(p.q); });
    case 'manual':   return staff_(p, function () { return manual_(p.regId); });
    default:         return { ok: false, status: 'unknown_action' };
  }
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function now_() { return new Date(); }

function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }

function sheet_(name) {
  var s = ss_().getSheetByName(name);
  if (!s) throw new Error('Missing sheet "' + name + '" - run setup() first');
  return s;
}

function fmt_(d, pattern) { return Utilities.formatDate(d, TZ, pattern); }
function stamp_(d) { return fmt_(d, 'yyyy-MM-dd HH:mm:ss'); }

function readEvent_() {
  var rows = sheet_(TAB.EVENT).getDataRange().getValues(), ev = {};
  for (var i = 1; i < rows.length; i++) {
    var k = String(rows[i][0]).trim();
    if (!k) continue;
    var v = rows[i][1];
    if (v instanceof Date) v = fmt_(v, 'yyyy-MM-dd HH:mm');
    ev[k] = String(v === null || v === undefined ? '' : v).trim();
  }
  return ev;
}

function table_(name) {
  var vals = sheet_(name).getDataRange().getValues();
  if (!vals.length) return [];
  var head = vals[0].map(String), out = [];
  for (var i = 1; i < vals.length; i++) {
    if (vals[i].join('') === '') continue;
    var o = { _row: i + 1 };
    for (var j = 0; j < head.length; j++) o[head[j]] = vals[i][j];
    out.push(o);
  }
  return out;
}

function setCell_(tab, row, col, value) {
  sheet_(tab).getRange(row, COLS[tab].indexOf(col) + 1).setValue(value);
}

function str_(v) { return String(v === null || v === undefined ? '' : v); }

function randomFrom_(n) {
  var s = '';
  for (var i = 0; i < n; i++) s += CODE_ALPHABET.charAt(Math.floor(Math.random() * CODE_ALPHABET.length));
  return s;
}

function esc_(s) {
  return str_(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function dateLabel_(dt) {
  var m = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}))?/.exec(dt || '');
  if (!m) return dt || '';
  var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return DAYS[d.getUTCDay()] + ', ' + (+m[3]) + ' ' + MONTHS[+m[2] - 1] + ' ' + m[1] + (m[4] ? ' · ' + m[4] + ':' + m[5] : '');
}

function eventDay_(ev) { return str_(ev.datetime).slice(0, 10); }

/* Branding values come from a sheet a human edits - validate before they reach CSS/HTML. */
function color_(v, def) { return /^#[0-9a-fA-F]{3,8}$/.test(str_(v)) ? v : def; }

function url_(v) {
  v = str_(v).trim();
  var drive = /^https:\/\/drive\.google\.com\/file\/d\/([\w-]+)/.exec(v);
  if (drive) return 'https://drive.google.com/uc?export=view&id=' + drive[1];
  return /^https:\/\/[^\s"'<>]+$/.test(v) ? v : '';
}

function font_(v) { return /^[\w\s,'"\-]{1,100}$/.test(str_(v)) ? v : 'system-ui'; }

function fontUrl_(v) { return /^https:\/\/fonts\.googleapis\.com\/[^\s"'<>]+$/.test(str_(v)) ? v : ''; }

function contrastText_(hex) {
  var h = hex.replace('#', '');
  if (h.length === 3) h = h.replace(/(.)/g, '$1$1');
  var r = parseInt(h.substr(0, 2), 16), g = parseInt(h.substr(2, 2), 16), b = parseInt(h.substr(4, 2), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? '#14181f' : '#ffffff';
}

function brand_(ev) {
  var primary = color_(ev.primary_color, '#0f766e');
  return {
    primary: primary,
    primaryText: contrastText_(primary),
    bg: color_(ev.bg_color, '#f5f6f8'),
    text: color_(ev.text_color, '#14181f'),
    font: font_(ev.font_family),
    fontUrl: fontUrl_(ev.font_url),
    banner: url_(ev.banner_url),
    logo: url_(ev.logo_url)
  };
}

function capacity_(ev) {
  var n = parseInt(ev.capacity, 10);
  return isNaN(n) || n < 0 ? 0 : n;
}

/* ------------------------------------------------------------------ */
/* Public: config + registration                                       */
/* ------------------------------------------------------------------ */

function configResponse_() {
  var ev = readEvent_(), regs = table_(TAB.REG), cap = capacity_(ev);
  var event = {};
  PUBLIC_KEYS.forEach(function (k) { event[k] = str_(ev[k]); });
  event.when = dateLabel_(ev.datetime);
  return {
    ok: true,
    event: event,
    brand: brand_(ev),
    capacity: cap,
    registered: regs.length,
    seatsLeft: cap ? Math.max(0, cap - regs.length) : null
  };
}

function register_(p) {
  // Honeypot: real people never fill the hidden field. Pretend success to bots.
  if (str_(p.website).trim()) return { ok: true, status: 'registered', emailSent: true };

  var name = str_(p.name).trim(), email = str_(p.email).trim().toLowerCase(), social = str_(p.social).trim();
  if (!name || name.length > 100) return invalid_('name', 'Please enter your full name.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return invalid_('email', 'Please enter a valid email address.');
  if (!social || social.length > 100) return invalid_('social', 'Please enter your social media handle.');
  if (p.consent !== true) return invalid_('consent', 'Please accept the data consent to continue.');

  var ev = readEvent_(), reg;
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var regs = table_(TAB.REG);
    for (var i = 0; i < regs.length; i++) {
      if (str_(regs[i].email).toLowerCase() === email) return { ok: true, status: 'duplicate' };
    }
    var cap = capacity_(ev);
    if (cap && regs.length >= cap) return { ok: true, status: 'full' };
    reg = {
      id: 'R' + (regs.length + 1) + randomFrom_(3),
      registered_at: stamp_(now_()),
      name: name,
      email: email,
      social: social,
      consent: 'yes',
      token: (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, ''),
      email_sent: '',
      checked_in_at: '',
      checked_in_via: ''
    };
    sheet_(TAB.REG).appendRow(COLS.Registrations.map(function (c) { return reg[c]; }));
  } finally {
    lock.releaseLock();
  }

  var sent = sendConfirmation_(ev, reg);
  return { ok: true, status: 'registered', emailSent: sent };
}

function invalid_(field, message) {
  return { ok: false, status: 'invalid', field: field, message: message };
}

function resend_(p) {
  var email = str_(p.email).trim().toLowerCase();
  var cache = CacheService.getScriptCache(), key = 'resend:' + email;
  if (cache.get(key)) return { ok: true, status: 'rate_limited' };
  var regs = table_(TAB.REG), reg = null;
  for (var i = 0; i < regs.length; i++) if (str_(regs[i].email).toLowerCase() === email) reg = regs[i];
  if (!reg) return { ok: true, status: 'not_found' };
  cache.put(key, '1', 120);
  return { ok: true, status: sendConfirmation_(readEvent_(), reg) ? 'sent' : 'send_failed' };
}

function sendConfirmation_(ev, reg) {
  var sent = false;
  try {
    var site = str_(ev.site_url).replace(/\/+$/, '');
    var link = site + '/qr.html?t=' + encodeURIComponent(reg.token);
    var opts = {
      to: reg.email,
      subject: 'You\'re registered: ' + (ev.event_name || 'Run Club'),
      body: emailText_(ev, reg, link),
      htmlBody: emailHtml_(ev, reg, link)
    };
    if (ev.email_sender_name) opts.name = ev.email_sender_name;
    MailApp.sendEmail(opts);
    sent = true;
  } catch (err) {
    Logger.log('Email failed: ' + err);
  }
  try {
    var row = table_(TAB.REG).filter(function (r) { return r.id === reg.id; })[0];
    if (row) setCell_(TAB.REG, row._row, 'email_sent', sent ? 'yes' : 'no');
  } catch (err2) { Logger.log(err2); }
  return sent;
}

function emailText_(ev, reg, link) {
  return 'Hi ' + reg.name + ',\n\nYou\'re registered for ' + ev.event_name + '.\n\n' +
    'When: ' + dateLabel_(ev.datetime) + '\nWhere: ' + ev.place + '\nRoute: ' + ev.route + '\n\n' +
    'On event day, open your check-in QR and show it to our staff:\n' + link + '\n\n' +
    'The QR is created fresh each time you open it, is valid for 5 minutes and works once. Please do not share it.';
}

function emailHtml_(ev, reg, link) {
  var b = brand_(ev);
  var row = function (k, v) {
    return v ? '<tr><td style="padding:4px 12px 4px 0;color:#667085;vertical-align:top">' + k + '</td><td style="padding:4px 0">' + esc_(v).replace(/\n/g, '<br>') + '</td></tr>' : '';
  };
  return '<div style="background:' + b.bg + ';padding:24px 12px;font-family:' + esc_(b.font) + ',Arial,sans-serif;color:' + b.text + '">' +
    '<div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e4e7ec">' +
    (b.banner ? '<img src="' + esc_(b.banner) + '" alt="" style="display:block;width:100%;height:auto">' : '') +
    '<div style="padding:22px">' +
    (b.logo ? '<img src="' + esc_(b.logo) + '" alt="" style="display:block;max-height:44px;margin:0 0 14px">' : '') +
    '<h2 style="margin:0 0 8px;font-size:22px">You\'re registered!</h2>' +
    '<p style="margin:0 0 12px">Hi ' + esc_(reg.name) + ', you\'re in for <b>' + esc_(ev.event_name) + '</b>.</p>' +
    '<table style="border-collapse:collapse;font-size:14px;margin:0 0 16px">' +
    row('When', dateLabel_(ev.datetime)) + row('Where', ev.place) + row('Route', ev.route) + row('Notes', ev.notes) +
    '</table>' +
    '<p style="margin:0 0 14px">On event day, open your check-in QR and show it to our staff at the start line.</p>' +
    '<a href="' + esc_(link) + '" style="display:block;background:' + b.primary + ';color:' + b.primaryText + ';text-align:center;padding:14px;border-radius:10px;font-weight:bold;text-decoration:none">Open my check-in QR</a>' +
    '<p style="margin:14px 0 0;font-size:12px;color:#667085">The QR is created fresh each time you open it, is valid for 5 minutes and works once. Please don\'t share it.</p>' +
    '</div></div></div>';
}

/* ------------------------------------------------------------------ */
/* Attendee: issue a fresh QR code                                     */
/* ------------------------------------------------------------------ */

function issue_(p) {
  var token = str_(p.token).trim();
  if (!/^[0-9a-f]{32,64}$/.test(token)) return { ok: true, status: 'invalid_token' };

  var ev = readEvent_(), nowD = now_(), today = fmt_(nowD, 'yyyy-MM-dd'), day = eventDay_(ev);
  var reg = table_(TAB.REG).filter(function (r) { return str_(r.token) === token; })[0];
  if (!reg) return { ok: true, status: 'invalid_token' };

  var base = { ok: true, name: str_(reg.name), eventName: str_(ev.event_name), when: dateLabel_(ev.datetime), brand: brand_(ev) };
  if (reg.checked_in_at) return merge_(base, { status: 'already_checked_in', at: str_(reg.checked_in_at) });
  if (today < day) return merge_(base, { status: 'not_open', opensOn: dateLabel_(day) });
  if (today > day) return merge_(base, { status: 'closed' });

  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var existing = {};
    table_(TAB.CODES).forEach(function (r) { existing[str_(r.code)] = true; });
    var code;
    do { code = fmt_(nowD, 'ddMMyyyyHHmmss') + randomFrom_(5); } while (existing[code]);
    sheet_(TAB.CODES).appendRow([code, reg.id, stamp_(nowD), '', '']);
    return merge_(base, { status: 'ok', code: code, windowSec: CODE_WINDOW_MS / 1000 });
  } finally {
    lock.releaseLock();
  }
}

function merge_(a, b) { for (var k in b) a[k] = b[k]; return a; }

/* ------------------------------------------------------------------ */
/* Staff: verify, search, manual check-in                              */
/* ------------------------------------------------------------------ */

function staff_(p, fn) {
  var pin = readEvent_().staff_pin;
  if (!pin || str_(p.pin) !== pin) return { ok: true, status: 'unauthorized' };
  var out = fn();
  var regs = table_(TAB.REG);
  out.ok = true;
  out.stats = {
    registered: regs.length,
    checkedIn: regs.filter(function (r) { return str_(r.checked_in_at) !== ''; }).length
  };
  return out;
}

function parseCode_(code) {
  var dd = +code.slice(0, 2), mm = +code.slice(2, 4), yyyy = +code.slice(4, 8);
  var hh = +code.slice(8, 10), mi = +code.slice(10, 12), ss = +code.slice(12, 14);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31 || hh > 23 || mi > 59 || ss > 59) return null;
  var p2 = function (n) { return (n < 10 ? '0' : '') + n; };
  return {
    ms: Date.UTC(yyyy, mm - 1, dd, hh, mi, ss) - TZ_OFFSET_MS,
    day: yyyy + '-' + p2(mm) + '-' + p2(dd)
  };
}

function log_(code, result, name, via) {
  sheet_(TAB.LOG).appendRow([stamp_(now_()), code, result, name || '', via]);
}

function verify_(rawCode) {
  var code = str_(rawCode).trim().toUpperCase();
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var res = verifyInner_(code);
    log_(code.slice(0, 40), res.status, res.name, 'qr');
    return res;
  } finally {
    lock.releaseLock();
  }
}

function verifyInner_(code) {
  if (!/^\d{14}[A-Z0-9]{5}$/.test(code)) return { status: 'invalid' };
  var issued = parseCode_(code);
  if (!issued) return { status: 'invalid' };

  var rec = table_(TAB.CODES).filter(function (r) { return str_(r.code) === code; })[0];
  if (!rec) return { status: 'invalid' };
  var reg = table_(TAB.REG).filter(function (r) { return str_(r.id) === str_(rec.reg_id); })[0];
  if (!reg) return { status: 'invalid' };
  var name = str_(reg.name);

  var nowD = now_(), today = fmt_(nowD, 'yyyy-MM-dd');
  if (issued.day !== today || eventDay_(readEvent_()) !== today) return { status: 'wrong_day', name: name };
  if (str_(rec.used_at)) return { status: 'used', name: name };
  if (Math.abs(nowD.getTime() - issued.ms) > CODE_WINDOW_MS) return { status: 'expired', name: name };
  if (str_(reg.checked_in_at)) return { status: 'already_checked_in', name: name, at: str_(reg.checked_in_at) };

  var t = stamp_(nowD);
  setCell_(TAB.CODES, rec._row, 'used_at', t);
  setCell_(TAB.CODES, rec._row, 'result', 'ok');
  setCell_(TAB.REG, reg._row, 'checked_in_at', t);
  setCell_(TAB.REG, reg._row, 'checked_in_via', 'qr');
  return { status: 'ok', name: name };
}

function search_(q) {
  q = str_(q).trim().toLowerCase();
  if (q.length < 2) return { status: 'ok', results: [] };
  var results = table_(TAB.REG).filter(function (r) {
    return (str_(r.name) + ' ' + str_(r.email) + ' ' + str_(r.social)).toLowerCase().indexOf(q) !== -1;
  }).slice(0, 10).map(function (r) {
    return { id: str_(r.id), name: str_(r.name), email: str_(r.email), social: str_(r.social), checkedIn: str_(r.checked_in_at) !== '' };
  });
  return { status: 'ok', results: results };
}

function manual_(regId) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var reg = table_(TAB.REG).filter(function (r) { return str_(r.id) === str_(regId); })[0];
    if (!reg) return { status: 'invalid' };
    var name = str_(reg.name), nowD = now_(), res;
    if (eventDay_(readEvent_()) !== fmt_(nowD, 'yyyy-MM-dd')) res = { status: 'wrong_day', name: name };
    else if (str_(reg.checked_in_at)) res = { status: 'already_checked_in', name: name, at: str_(reg.checked_in_at) };
    else {
      setCell_(TAB.REG, reg._row, 'checked_in_at', stamp_(nowD));
      setCell_(TAB.REG, reg._row, 'checked_in_via', 'manual');
      res = { status: 'ok', name: name };
    }
    log_('(manual ' + str_(regId) + ')', res.status, name, 'manual');
    return res;
  } finally {
    lock.releaseLock();
  }
}

/* ------------------------------------------------------------------ */
/* One-time setup (run from the Apps Script editor)                    */
/* ------------------------------------------------------------------ */

function setup() {
  var ss = ss_();

  var ev = ss.getSheetByName(TAB.EVENT);
  if (!ev) {
    ev = ss.insertSheet(TAB.EVENT);
    ev.appendRow(['key', 'value', 'notes']);
  }
  ev.getRange('B:B').setNumberFormat('@');
  var have = {};
  ev.getDataRange().getValues().forEach(function (r) { have[String(r[0]).trim()] = true; });
  EVENT_DEFAULTS.forEach(function (d) {
    if (have[d[0]]) return;
    var value = d[1];
    if (d[0] === 'datetime') value = nextSunday_() + ' 06:00';
    if (d[0] === 'staff_pin') value = randomFrom_(8);
    ev.appendRow([d[0], value, d[2]]);
  });
  ev.setFrozenRows(1);

  Object.keys(COLS).forEach(function (name) {
    var s = ss.getSheetByName(name) || ss.insertSheet(name);
    if (s.getLastRow() === 0) s.getRange(1, 1, 1, COLS[name].length).setValues([COLS[name]]);
    s.getRange('A:' + String.fromCharCode(64 + COLS[name].length)).setNumberFormat('@');
    s.setFrozenRows(1);
  });

  var blank = ss.getSheetByName('Sheet1') || ss.getSheetByName('ชีต1');
  if (blank && blank.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(blank);

  Logger.log('Setup complete. Staff PIN and event details are in the "Event" tab.');
}

function nextSunday_() {
  var d = new Date(now_().getTime() + TZ_OFFSET_MS);          // shift so UTC getters read Bangkok wall-clock
  var add = (7 - d.getUTCDay()) % 7 || 7;
  d = new Date(d.getTime() + add * 86400000);
  var p2 = function (n) { return (n < 10 ? '0' : '') + n; };
  return d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate());
}
