// Minimal in-memory stand-ins for the Apps Script services Code.gs uses,
// so the real backend/Code.gs can run (and be tested) under Node.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

function formatDate(date, tz, pattern) {
  const parts = {};
  new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(date).forEach((p) => { parts[p.type] = p.value; });
  const map = { yyyy: parts.year, MM: parts.month, dd: parts.day, HH: parts.hour, mm: parts.minute, ss: parts.second };
  return pattern.replace(/yyyy|MM|dd|HH|mm|ss/g, (t) => map[t]);
}

function makeSheet(name) {
  const rows = [];
  const width = () => rows.reduce((m, r) => Math.max(m, r.length), 0);
  const range = (row, col, nr, nc) => {
    const r = {
      setValue(v) { while (rows.length < row) rows.push([]); while (rows[row - 1].length < col) rows[row - 1].push(''); rows[row - 1][col - 1] = v; return r; },
      setValues(vals) { vals.forEach((vr, i) => vr.forEach((v, j) => range(row + i, col + j).setValue(v))); return r; },
      getValue() { return (rows[row - 1] || [])[col - 1] ?? ''; },
      setNumberFormat() { return r; }, setFontWeight() { return r; }
    };
    return r;
  };
  return {
    name, rows,
    getLastRow: () => rows.length,
    getRange: (a, b, c, d) => (typeof a === 'string' ? range(1, 1) : range(a, b, c, d)),
    appendRow(arr) { rows.push(arr.slice()); },
    getDataRange: () => ({ getValues: () => rows.map((r) => { const o = r.slice(); while (o.length < width()) o.push(''); return o; }) }),
    setFrozenRows() {}
  };
}

function createEnv() {
  const sheets = new Map();
  const mails = [];
  const cache = new Map();
  const ss = {
    getSheetByName: (n) => sheets.get(n) || null,
    insertSheet: (n) => { const s = makeSheet(n); sheets.set(n, s); return s; },
    getSheets: () => [...sheets.values()],
    deleteSheet: (s) => sheets.delete(s.name)
  };
  const ctx = {
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    Utilities: { formatDate, getUuid: () => crypto.randomUUID() },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    CacheService: { getScriptCache: () => ({ get: (k) => cache.get(k) ?? null, put: (k, v) => cache.set(k, v) }) },
    MailApp: { sendEmail: (o) => { mails.push(o); } },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (s) => ({ setMimeType() { return this; }, getContent: () => s })
    },
    Logger: { log: (...a) => { if (process.env.GAS_LOG) console.log('[Logger]', ...a); } },
    console, Date, Math, JSON, Intl, parseInt, String, Number, Object, Array, RegExp, Error, isNaN
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'backend', 'Code.gs'), 'utf8'), ctx, { filename: 'Code.gs' });

  const call = (payload) => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(payload) } }).getContent());
  return { ctx, sheets, mails, call };
}

module.exports = { createEnv, formatDate };
