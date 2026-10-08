// Run: node tests/backend.test.js
const assert = require('assert');
const { createEnv, formatDate } = require('./fake-gas');

let failures = 0;
function test(name, fn) {
  try { fn(); console.log('  ok   ' + name); }
  catch (e) { failures++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e).split('\n').slice(0, 4).join('\n       ')); }
}

// Fresh environment, event is "today" at 06:00 Bangkok, clock fixed at 06:00:00.
function fresh({ eventDayOffset = 0, capacity } = {}) {
  const env = createEnv();
  env.ctx.setup();
  // Pick a clock instant, then derive event day relative to it.
  const clock = { t: Date.parse('2026-10-12T06:00:00+07:00') };
  env.ctx.now_ = () => new Date(clock.t);
  const ev = env.sheets.get('Event');
  const set = (k, v) => { ev.rows.forEach((r) => { if (r[0] === k) r[1] = v; }); };
  const day = formatDate(new Date(clock.t + eventDayOffset * 86400000), 'Asia/Bangkok', 'dd-MM-yyyy');
  set('date', day);
  set('time', '06:00');
  set('staff_pin', 'TESTPIN1');
  if (capacity !== undefined) set('capacity', String(capacity));
  env.clock = clock;
  env.set = set;
  env.advance = (ms) => { clock.t += ms; };
  env.pin = 'TESTPIN1';
  env.register = (email = 'somchai@example.com', name = 'Somchai Jaidee') =>
    env.call({ action: 'register', name, email, social: '@' + email.split('@')[0], consent: true });
  env.tokenOf = (email) => env.sheets.get('Registrations').rows.find((r) => r[3] === email.toLowerCase())[6];
  env.issue = (email = 'somchai@example.com') => env.call({ action: 'issue', token: env.tokenOf(email) });
  env.verify = (code) => env.call({ action: 'verify', pin: env.pin, code });
  return env;
}

console.log('setup');
test('creates tabs, headers and a random 8-char staff PIN', () => {
  const env = createEnv(); env.ctx.setup();
  ['Event', 'Registrations', 'Codes', 'ScanLog'].forEach((n) => assert(env.sheets.get(n), n));
  const pin = env.sheets.get('Event').rows.find((r) => r[0] === 'staff_pin')[1];
  assert.match(pin, /^[A-Z2-9]{8}$/);
  assert.deepStrictEqual(env.sheets.get('Codes').rows[0], ['code', 'reg_id', 'issued_at', 'used_at', 'result']);
  env.ctx.setup(); // idempotent
  assert.strictEqual(env.sheets.get('Event').rows.filter((r) => r[0] === 'staff_pin').length, 1);
});

console.log('config');
test('exposes event + branding but never the PIN / site url / sender', () => {
  const env = fresh();
  const raw = JSON.stringify(env.call({ action: 'config' }));
  assert(!raw.includes('TESTPIN1') && !raw.includes('staff_pin') && !raw.includes('site_url'));
  const c = JSON.parse(raw);
  assert.strictEqual(c.event.event_name, 'Sunday Morning 10K');
  assert.strictEqual(c.event.when, 'Mon, 12 Oct 2026 · 06:00');
  assert.strictEqual(c.seatsLeft, 50);
});
test('rejects unsafe branding values', () => {
  const env = fresh();
  env.set('primary_color', 'red;} body{display:none');
  env.set('banner_url', 'javascript:alert(1)');
  env.set('font_family', 'x}</style><script>');
  const b = env.call({ action: 'config' }).brand;
  assert.strictEqual(b.primary, '#0f766e'); assert.strictEqual(b.banner, ''); assert.strictEqual(b.font, 'system-ui');
});
test('converts Google Drive share links for banner/logo', () => {
  const env = fresh();
  env.set('banner_url', 'https://drive.google.com/file/d/ABC_123-x/view?usp=sharing');
  assert.strictEqual(env.call({ action: 'config' }).brand.banner, 'https://drive.google.com/uc?export=view&id=ABC_123-x');
});

console.log('registration');
test('saves row and sends email containing event info and a QR link', () => {
  const env = fresh();
  env.set('site_url', 'https://me.github.io/runclub/');
  const r = env.register();
  assert.deepStrictEqual([r.status, r.emailSent], ['registered', true]);
  assert.strictEqual(env.mails.length, 1);
  const m = env.mails[0], tok = env.tokenOf('somchai@example.com');
  assert.strictEqual(m.to, 'somchai@example.com');
  assert(m.htmlBody.includes('https://me.github.io/runclub/qr.html?t=' + tok));
  assert(m.htmlBody.includes('Lumphini Park') && m.htmlBody.includes('Open my check-in QR'));
  assert.strictEqual(env.sheets.get('Registrations').rows[1][7], 'yes');
});
test('duplicate email (any case / spacing) is refused', () => {
  const env = fresh(); env.register();
  assert.strictEqual(env.register('  SomChai@Example.com ').status, 'duplicate');
  assert.strictEqual(env.sheets.get('Registrations').rows.length, 2);
});
test('required fields and consent are enforced', () => {
  const env = fresh();
  const base = { action: 'register', name: 'A', email: 'a@b.co', social: '@a', consent: true };
  assert.strictEqual(env.call({ ...base, name: ' ' }).field, 'name');
  assert.strictEqual(env.call({ ...base, email: 'nope' }).field, 'email');
  assert.strictEqual(env.call({ ...base, social: '' }).field, 'social');
  assert.strictEqual(env.call({ ...base, consent: false }).field, 'consent');
  assert.strictEqual(env.sheets.get('Registrations').rows.length, 1);
});
test('capacity limit', () => {
  const env = fresh({ capacity: 1 });
  env.register('a@x.com'); assert.strictEqual(env.register('b@x.com').status, 'full');
});
test('HTML in the name is escaped in the email', () => {
  const env = fresh(); env.register('x@y.com', '<img src=x onerror=alert(1)>');
  assert(!env.mails[0].htmlBody.includes('<img src=x'));
});
test('honeypot silently drops bots', () => {
  const env = fresh();
  env.call({ action: 'register', name: 'Bot', email: 'bot@x.com', social: '@b', consent: true, website: 'http://spam' });
  assert.strictEqual(env.sheets.get('Registrations').rows.length, 1); assert.strictEqual(env.mails.length, 0);
});
test('resend is rate limited and only for registered emails', () => {
  const env = fresh(); env.register();
  assert.strictEqual(env.call({ action: 'resend', email: 'nobody@x.com' }).status, 'not_found');
  assert.strictEqual(env.call({ action: 'resend', email: 'somchai@example.com' }).status, 'sent');
  assert.strictEqual(env.call({ action: 'resend', email: 'somchai@example.com' }).status, 'rate_limited');
  assert.strictEqual(env.mails.length, 2);
});

console.log('issuing QR codes');
test('code format is ddmmyyyyhhmmss + 5 random chars, stored against the attendee', () => {
  const env = fresh(); env.register();
  const r = env.issue();
  assert.strictEqual(r.status, 'ok'); assert.match(r.code, /^12102026060000[A-Z2-9]{5}$/);
  assert.strictEqual(env.sheets.get('Codes').rows[1][0], r.code);
});
test('every open issues a different code', () => {
  const env = fresh(); env.register();
  assert.notStrictEqual(env.issue().code, env.issue().code);
});
test('before / after event day the QR is still issued with a phase note, but scanning is Wrong date', () => {
  let env = fresh({ eventDayOffset: 1 }); env.register();
  let r = env.issue();
  assert.deepStrictEqual([r.status, r.phase], ['ok', 'before']);
  assert.strictEqual(r.opensOn, 'Tue, 13 Oct 2026');
  assert.strictEqual(env.verify(r.code).status, 'wrong_day');
  env = fresh({ eventDayOffset: -1 }); env.register();
  r = env.issue();
  assert.deepStrictEqual([r.status, r.phase], ['ok', 'after']);
  assert.strictEqual(env.verify(r.code).status, 'wrong_day');
  assert.strictEqual(env.sheets.get('Registrations').rows[1][8], '');
  env = fresh(); env.register();
  assert.strictEqual(env.issue().phase, 'today');
});
test('bad token', () => {
  const env = fresh();
  assert.strictEqual(env.call({ action: 'issue', token: 'zz' }).status, 'invalid_token');
  assert.strictEqual(env.call({ action: 'issue', token: 'a'.repeat(48) }).status, 'invalid_token');
});

console.log('staff verification');
test('wrong or missing PIN is rejected', () => {
  const env = fresh(); env.register(); const { code } = env.issue();
  assert.strictEqual(env.call({ action: 'verify', pin: 'nope', code }).status, 'unauthorized');
  assert.strictEqual(env.call({ action: 'verify', code }).status, 'unauthorized');
  assert.strictEqual(env.sheets.get('Registrations').rows[1][8], '');
});
test('valid QR -> ok with name; logged to Registrations/Codes/ScanLog', () => {
  const env = fresh(); env.register(); const { code } = env.issue();
  env.advance(30000);
  const r = env.verify(code);
  assert.deepStrictEqual([r.status, r.name, r.stats.checkedIn, r.stats.registered], ['ok', 'Somchai Jaidee', 1, 1]);
  assert.strictEqual(env.sheets.get('Registrations').rows[1][8], '2026-10-12 06:00:30');
  assert.strictEqual(env.sheets.get('Registrations').rows[1][9], 'qr');
  assert.deepStrictEqual([...env.sheets.get('Codes').rows[1].slice(3)], ['2026-10-12 06:00:30', 'ok']);
  assert.strictEqual(env.sheets.get('ScanLog').rows[1][2], 'ok');
});
test('same QR scanned again -> used (friend with a forwarded screenshot)', () => {
  const env = fresh(); env.register(); const { code } = env.issue();
  env.verify(code);
  assert.strictEqual(env.verify(code).status, 'used');
});
test('a second QR of someone already checked in -> already_checked_in', () => {
  const env = fresh(); env.register(); const a = env.issue().code, b = env.issue().code;
  env.verify(a);
  const r = env.verify(b);
  assert.strictEqual(r.status, 'already_checked_in'); assert.strictEqual(r.name, 'Somchai Jaidee');
});
test('+/- 5 minute window around issue time', () => {
  let env = fresh(); env.register(); let code = env.issue().code;
  env.advance(5 * 60 * 1000); assert.strictEqual(env.verify(code).status, 'ok');          // exactly 5:00 allowed
  env = fresh(); env.register(); code = env.issue().code;
  env.advance(5 * 60 * 1000 + 1000); assert.strictEqual(env.verify(code).status, 'expired'); // 5:01 rejected
});
test('expired code stays unused and a new one still works', () => {
  const env = fresh(); env.register(); const old = env.issue().code;
  env.advance(10 * 60 * 1000);
  assert.strictEqual(env.verify(old).status, 'expired');
  assert.strictEqual(env.verify(env.issue().code).status, 'ok');
});
test('code from a previous day -> wrong_day', () => {
  const env = fresh(); env.register(); const { code } = env.issue();
  env.advance(24 * 3600 * 1000);
  assert.strictEqual(env.verify(code).status, 'wrong_day');
});
test('crossing midnight is wrong_day, not a time-only comparison', () => {
  const env = fresh(); env.register();
  env.clock.t = Date.parse('2026-10-12T23:58:00+07:00');
  env.set('date', '12-10-2026');
  const { code } = env.issue();
  env.advance(4 * 60 * 1000);   // 00:02 next day, only 4 min later
  assert.strictEqual(env.verify(code).status, 'wrong_day');
});
test('well-formed but forged codes -> invalid (cannot be guessed from the format alone)', () => {
  const env = fresh(); env.register();
  assert.strictEqual(env.verify('12102026060000ABCDE').status, 'invalid');
  assert.strictEqual(env.verify('hello').status, 'invalid');
  assert.strictEqual(env.verify('99992026060000ABCDE').status, 'invalid');
  assert.strictEqual(env.verify('').status, 'invalid');
});
test('lower-case / padded scans are normalised', () => {
  const env = fresh(); env.register(); const { code } = env.issue();
  assert.strictEqual(env.verify('  ' + code.toLowerCase() + ' ').status, 'ok');
});
test('issuing stops once the attendee has checked in', () => {
  const env = fresh(); env.register(); env.verify(env.issue().code);
  assert.strictEqual(env.issue().status, 'already_checked_in');
});

console.log('staff search / manual');
test('search by name, email, social; needs 2+ chars', () => {
  const env = fresh(); env.register(); env.register('nok@x.com', 'Nok A');
  const find = (q) => env.call({ action: 'search', pin: env.pin, q }).results.map((r) => r.name);
  assert.deepStrictEqual(find('somch'), ['Somchai Jaidee']);
  assert.deepStrictEqual(find('NOK@x'), ['Nok A']);
  assert.deepStrictEqual(find('@nok'), ['Nok A']);          // by social handle
  assert.deepStrictEqual(find('s'), []);
});
test('manual check-in works once and is logged as manual', () => {
  const env = fresh(); env.register();
  const id = env.call({ action: 'search', pin: env.pin, q: 'somchai' }).results[0].id;
  assert.strictEqual(env.call({ action: 'manual', pin: env.pin, regId: id }).status, 'ok');
  assert.strictEqual(env.call({ action: 'manual', pin: env.pin, regId: id }).status, 'already_checked_in');
  assert.strictEqual(env.sheets.get('Registrations').rows[1][9], 'manual');
  assert.strictEqual(env.call({ action: 'manual', pin: env.pin, regId: 'nope' }).status, 'invalid');
});
test('manual check-in refused off event day', () => {
  const env = fresh({ eventDayOffset: 1 }); env.register();
  const id = env.call({ action: 'search', pin: env.pin, q: 'somchai' }).results[0].id;
  assert.strictEqual(env.call({ action: 'manual', pin: env.pin, regId: id }).status, 'wrong_day');
});

console.log('event date / time / timezone');
test('date accepts dd-mm-yyyy, dd/mm/yyyy and single digits; time accepts h:mm', () => {
  const env = fresh();
  for (const [d, t, label] of [['11-10-2026', '06:00', 'Sun, 11 Oct 2026 · 06:00'], ['11/10/2026', '6:05', 'Sun, 11 Oct 2026 · 06:05'], ['1-1-2027', '18:30', 'Fri, 1 Jan 2027 · 18:30']]) {
    env.set('date', d); env.set('time', t);
    const c = env.call({ action: 'config' });
    assert.strictEqual(c.eventOk, true, d + ' ' + t); assert.strictEqual(c.event.when, label);
  }
});
test('bad date or time -> eventOk=false with a clear message; registration closed; QR not issued', () => {
  for (const [d, t, expect] of [['2026-10-11', '06:00', 'date'], ['31-02-2026', '06:00', 'date'], ['', '06:00', 'date'], ['11-10-2026', '25:00', 'time'], ['11-10-2026', '', 'time']]) {
    const env = fresh(); env.register();            // registered while valid
    const token = env.tokenOf('somchai@example.com');
    env.set('date', d); env.set('time', t);
    const c = env.call({ action: 'config' });
    assert.strictEqual(c.eventOk, false, d + '|' + t); assert(c.eventError.includes('"' + expect + '"'), c.eventError);
    assert.strictEqual(c.event.when, '');
    assert.strictEqual(env.register('new@x.com').status, 'not_configured');
    assert.strictEqual(env.call({ action: 'issue', token }).status, 'not_configured');
    const staff = env.call({ action: 'login', pin: env.pin });
    assert.strictEqual(staff.status, 'ok'); assert(staff.eventError);
  }
});
test('an older sheet with a single "datetime" row keeps working, and setup() migrates it', () => {
  const env = fresh();
  const rows = env.sheets.get('Event').rows;
  rows.splice(rows.findIndex((r) => r[0] === 'time'), 1);
  const dr = rows.find((r) => r[0] === 'date'); dr[0] = 'datetime'; dr[1] = '2026-10-12 07:30';
  const c = env.call({ action: 'config' });
  assert.strictEqual(c.eventOk, true); assert.strictEqual(c.event.when, 'Mon, 12 Oct 2026 · 07:30');
  env.ctx.setup();
  const get = (k) => (rows.find((r) => r[0] === k) || [])[1];
  assert.strictEqual(get('date'), '12-10-2026'); assert.strictEqual(get('time'), '07:30');
  assert.strictEqual(get('datetime'), undefined); assert.strictEqual(rows.filter((r) => r[0] === 'date').length, 1);
  assert.strictEqual(env.call({ action: 'config' }).event.when, 'Mon, 12 Oct 2026 · 07:30');
});
test('New York event: "today" is the New York date, not the Thai date', () => {
  const env = fresh(); env.register();
  env.set('timezone', 'America/New_York'); env.set('date', '11-10-2026'); env.set('time', '19:00');
  assert.strictEqual(env.call({ action: 'config' }).event.when, 'Sun, 11 Oct 2026 · 19:00 (New York time)');
  env.clock.t = Date.parse('2026-10-11T19:30:00-04:00');       // 06:30 on 12 Oct in Bangkok
  const r = env.issue();
  assert.deepStrictEqual([r.status, r.phase], ['ok', 'today']);
  assert.match(r.code, /^11102026193000[A-Z2-9]{5}$/);
  // midnight in New York ends the event day (checked before this attendee checks in)
  const later = Date.parse('2026-10-12T00:30:00-04:00');
  env.advance(30000);
  assert.strictEqual(env.verify(r.code).status, 'ok');
  env.register('late@x.com'); env.clock.t = later;
  assert.strictEqual(env.call({ action: 'issue', token: env.tokenOf('late@x.com') }).phase, 'after');
});
test('without a timezone the event day is Thai time (as before)', () => {
  const env = fresh(); env.register();
  env.set('date', '12-10-2026');
  env.clock.t = Date.parse('2026-10-12T00:30:00+07:00');
  const r = env.issue(); assert.strictEqual(r.phase, 'today'); assert.match(r.code, /^12102026003000/);
  env.set('timezone', 'Mars/Phobos');                      // unknown zone falls back to Thai time
  assert.match(env.issue().code, /^12102026003000/);
});
test('+/-5 minute window is exact across daylight-saving changes (NY spring-forward, London summer)', () => {
  for (const [tz, date, iso, prefix] of [
    ['America/New_York', '08-03-2026', '2026-03-08T12:00:00-04:00', '08032026120000'],   // clocks jumped forward at 02:00 that day
    ['America/New_York', '01-11-2026', '2026-11-01T12:00:00-05:00', '01112026120000'],   // fall-back day
    ['Europe/London', '10-07-2026', '2026-07-10T14:00:00+01:00', '10072026140000']
  ]) {
    let env = fresh(); env.register(); env.set('timezone', tz); env.set('date', date); env.clock.t = Date.parse(iso);
    let code = env.issue().code; assert(code.startsWith(prefix), tz + ' ' + code);
    env.advance(5 * 60 * 1000); assert.strictEqual(env.verify(code).status, 'ok', tz + ' at 5:00');
    env = fresh(); env.register(); env.set('timezone', tz); env.set('date', date); env.clock.t = Date.parse(iso);
    code = env.issue().code; env.advance(5 * 60 * 1000 + 1000);
    assert.strictEqual(env.verify(code).status, 'expired', tz + ' at 5:01');
  }
});

console.log('Codes tab records the first scan');
test('failed first scan is recorded; repeat scans do not overwrite it', () => {
  const env = fresh(); env.register(); const { code } = env.issue();
  env.advance(6 * 60 * 1000);
  assert.strictEqual(env.verify(code).status, 'expired');
  const row = () => [...env.sheets.get('Codes').rows[1]];
  assert.deepStrictEqual(row().slice(3), ['2026-10-12 06:06:00', 'expired']);
  env.advance(60 * 1000);
  assert.strictEqual(env.verify(code).status, 'expired');
  assert.deepStrictEqual(row().slice(3), ['2026-10-12 06:06:00', 'expired']);        // unchanged
  assert.strictEqual(env.sheets.get('ScanLog').rows.length, 3);                       // but both attempts are logged
});
test('ok stays ok after replays; other code of same person records already_checked_in; old-day code records wrong_day', () => {
  const env = fresh(); env.register();
  const a = env.issue().code, b = env.issue().code;
  env.advance(10000); env.verify(a);
  env.advance(10000); assert.strictEqual(env.verify(a).status, 'used');
  const codes = env.sheets.get('Codes').rows;
  assert.deepStrictEqual([...codes[1].slice(3)], ['2026-10-12 06:00:10', 'ok']);
  env.advance(10000); assert.strictEqual(env.verify(b).status, 'already_checked_in');
  assert.deepStrictEqual([...codes[2].slice(3)], ['2026-10-12 06:00:30', 'already_checked_in']);
  const env2 = fresh(); env2.register(); const c = env2.issue().code;
  env2.advance(24 * 3600 * 1000); env2.verify(c);
  assert.deepStrictEqual([...env2.sheets.get('Codes').rows[1].slice(3)], ['2026-10-13 06:00:00', 'wrong_day']);
});
test('a code whose first scan failed can still pass later and then records ok', () => {
  const env = fresh({ eventDayOffset: 1 }); env.register();
  const { code } = env.issue();                               // issued the day before the event
  assert.strictEqual(env.verify(code).status, 'wrong_day');
  env.set('date', '12-10-2026');                              // organiser corrects the date to today
  const r = env.verify(code);
  assert.strictEqual(r.status, 'ok');
  assert.deepStrictEqual([...env.sheets.get('Codes').rows[1].slice(3)].map((x, i) => (i ? x : 'time')), ['time', 'ok']);
});
test('rows written by the previous version (used_at + result=ok) are still treated as used', () => {
  const env = fresh(); env.register(); const { code } = env.issue();
  const row = env.sheets.get('Codes').rows[1]; row[3] = '2026-10-12 06:00:05'; row[4] = 'ok';
  assert.strictEqual(env.verify(code).status, 'used');
});

console.log('robustness');
test('garbage requests do not throw or leak', () => {
  const env = fresh();
  assert.strictEqual(env.call({ action: 'nope' }).status, 'unknown_action');
  const out = JSON.parse(env.ctx.doPost({ postData: { contents: '{not json' } }).getContent());
  assert.deepStrictEqual(out, { ok: false, status: 'server_error' });
});

console.log(failures ? `\n${failures} FAILED` : '\nAll tests passed');
process.exit(failures ? 1 : 0);
