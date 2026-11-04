'use strict';
// Run: node test.js   (uses a temporary database; needs no network)
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'duoflow-test-'));
process.env.PORT = '0';
process.env.NODE_ENV = 'test';
process.env.REQUIRE_VERIFY = '1'; // exercise the real email flow; mail goes to `outbox` instead of the network
const { server, db, outbox } = require('./server');

let base, passed = 0;
const call = async (method, p, body, token) => {
  const r = await fetch(base + p, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const ok = async (name, fn) => { await fn(); passed++; console.log('  ok  ' + name); };
const linkFor = (email, kind) => {
  const m = [...outbox].reverse().find(x => x.to === email && x.body.includes('#' + kind + '='));
  return m ? m.body.match(new RegExp('#' + kind + '=([\\w-]+)'))[1] : null;
};
// Signs up and confirms the email, the way a member would by tapping the link.
const signup = async (name, email) => {
  const r = await call('POST', '/api/signup', { name, email, password: 'password123' });
  assert.equal(r.status, 201);
  assert.equal((await call('POST', '/api/verify', { token: linkFor(email, 'verify') })).status, 200);
  return { token: r.body.token, id: r.body.user.id };
};

(async () => {
  await new Promise(r => server.listening ? r() : server.once('listening', r));
  base = 'http://127.0.0.1:' + server.address().port;
  console.log('Duo Flow tests');

  const me = await call('GET', '/api/me', null, null);
  assert.equal(me.status, 401);

  await ok('signup validation and login', async () => {
    assert.equal((await call('POST', '/api/signup', { name: 'X', email: 'x@x.com', password: 'short' })).status, 400);
    assert.equal((await call('POST', '/api/signup', { name: 'X', email: 'not-an-email', password: 'password123' })).status, 400);
    await signup('Alice', 'alice@example.com');
    assert.equal((await call('POST', '/api/signup', { name: 'A2', email: 'ALICE@example.com', password: 'password123' })).status, 409);
    assert.equal((await call('POST', '/api/login', { email: 'alice@example.com', password: 'wrongpass1' })).status, 401);
    assert.equal((await call('POST', '/api/login', { email: 'alice@example.com', password: 'password123' })).status, 200);
    assert.equal((await call('GET', '/api/me', null, 'garbage.token')).status, 401);
  });

  const A = await signup('Ann', 'ann@example.com');
  const B = await signup('Bea', 'bea@example.com');
  const C = await signup('Cy', 'cy@example.com');
  const today = (await call('GET', '/api/me', null, A.token)).body.today;
  const [ty, tm, td] = today.split('-').map(Number);
  const tomorrow = new Date(Date.UTC(ty, tm - 1, td + 1)).toISOString().slice(0, 10);
  const day = (await call('GET', '/api/classes?date=' + tomorrow, null, A.token)).body.classes;
  const six = day.filter(c => c.start.endsWith('T06:00'));
  const X = six[0], Y = six[1], noon = day.find(c => c.start.endsWith('T12:00'));
  const view = async (who, cls) => (await call('GET', '/api/classes?date=' + tomorrow, null, who.token)).body.classes.find(c => c.id === cls.id);

  await ok('friend request flow', async () => {
    assert.equal((await call('POST', '/api/friends/request', { email: 'nobody@example.com' }, A.token)).status, 404);
    assert.equal((await call('POST', '/api/friends/request', { email: 'ann@example.com' }, A.token)).status, 400);
    assert.equal((await call('POST', '/api/friends/request', { email: 'bea@example.com' }, A.token)).body.status, 'pending');
    assert.equal((await call('POST', '/api/friends/request', { email: 'bea@example.com' }, A.token)).status, 409);
    const fr = (await call('GET', '/api/friends', null, B.token)).body;
    assert.equal(fr.incoming.length, 1);
    assert.equal((await call('POST', '/api/friends/respond', { friendshipId: fr.incoming[0].friendshipId, accept: true }, C.token)).status, 404);
    assert.equal((await call('POST', '/api/friends/respond', { friendshipId: fr.incoming[0].friendshipId, accept: true }, B.token)).status, 200);
  });

  await ok('booking rules', async () => {
    assert.equal((await call('POST', '/api/book', { classId: X.id }, B.token)).status, 201);
    assert.equal((await call('POST', '/api/book', { classId: X.id }, B.token)).status, 409);
    assert.equal((await call('POST', '/api/book', { classId: Y.id }, B.token)).status, 409, 'no double-booking one time slot');
    db.prepare('UPDATE classes SET capacity=1 WHERE id=?').run(noon.id);
    assert.equal((await call('POST', '/api/book', { classId: noon.id }, B.token)).status, 201);
    assert.equal((await call('POST', '/api/book', { classId: noon.id }, A.token)).status, 409, 'full class');
    assert.equal((await call('POST', '/api/cancel', { classId: noon.id }, B.token)).status, 200);
  });

  await ok('new friends see nothing by default', async () => {
    const v = await view(A, X);
    assert.deepEqual(v.going, []); assert.deepEqual(v.busy, []);
    const s = (await call('GET', `/api/friends/${B.id}/schedule`, null, A.token)).body;
    assert.equal(s.level, 'hidden'); assert.deepEqual(s.items, []);
  });

  await ok('busy level shows time only, never the class', async () => {
    assert.equal((await call('POST', '/api/visibility', { friendId: A.id, level: 'busy' }, B.token)).status, 200);
    const v = await view(A, X);
    assert.deepEqual(v.going, []); assert.equal(v.busy.length, 1);
    const s = (await call('GET', `/api/friends/${B.id}/schedule`, null, A.token)).body;
    assert.equal(s.level, 'busy'); assert.deepEqual(Object.keys(s.items[0]), ['start']);
  });

  await ok('full level shows the class, and busy on other classes at that time', async () => {
    await call('POST', '/api/visibility', { friendId: A.id, level: 'full' }, B.token);
    const v = await view(A, X), other = await view(A, Y);
    assert.equal(v.going[0].name, 'Bea'); assert.deepEqual(other.going, []); assert.equal(other.busy.length, 1);
    const s = (await call('GET', `/api/friends/${B.id}/schedule`, null, A.token)).body;
    assert.equal(s.items[0].type, X.type);
  });

  await ok('visibility is one-directional', async () => {
    await call('POST', '/api/book', { classId: Y.id }, A.token);
    const v = await view(B, Y);
    assert.deepEqual(v.going, []); assert.deepEqual(v.busy, []);
  });

  await ok('private class is hidden even from Full friends', async () => {
    await call('POST', '/api/booking/private', { classId: X.id, private: true }, B.token);
    const v = await view(A, X);
    assert.deepEqual(v.going, []); assert.deepEqual(v.busy, []);
    const s = (await call('GET', `/api/friends/${B.id}/schedule`, null, A.token)).body;
    assert.deepEqual(s.items, []);
    await call('POST', '/api/booking/private', { classId: X.id, private: false }, B.token);
    assert.equal((await view(A, X)).going.length, 1);
  });

  await ok('hide-all overrides every friend setting', async () => {
    await call('POST', '/api/privacy', { hide_all: true }, B.token);
    const v = await view(A, X);
    assert.deepEqual(v.going, []); assert.deepEqual(v.busy, []);
    assert.equal((await call('GET', `/api/friends/${B.id}/schedule`, null, A.token)).body.level, 'hidden');
    await call('POST', '/api/privacy', { hide_all: false }, B.token);
    assert.equal((await view(A, X)).going.length, 1);
  });

  await ok('strangers see nothing and cannot set visibility', async () => {
    const v = await view(C, X);
    assert.deepEqual(v.going, []); assert.deepEqual(v.busy, []);
    const s = (await call('GET', `/api/friends/${B.id}/schedule`, null, C.token)).body;
    assert.equal(s.level, 'hidden'); assert.deepEqual(s.items, []);
    assert.equal((await call('POST', '/api/visibility', { friendId: C.id, level: 'full' }, B.token)).status, 404);
    assert.equal((await call('POST', '/api/visibility', { friendId: A.id, level: 'everything' }, B.token)).status, 400);
  });

  await ok('removing a friend ends sharing', async () => {
    await call('POST', '/api/friends/remove', { friendId: B.id }, A.token);
    const v = await view(A, X);
    assert.deepEqual(v.going, []); assert.deepEqual(v.busy, []);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM visibility').get().n, 0);
  });

  await ok('static files are confined to /public', async () => {
    const get = p => new Promise(res => http.get({ host: '127.0.0.1', port: server.address().port, path: p }, r => { r.resume(); res(r.statusCode); }));
    assert.equal(await get('/'), 200);
    assert.equal(await get('/../server.js'), 404);
    assert.equal(await get('/..%2fserver.js'), 404);
    assert.equal(await get('/%2e%2e/test.js'), 404);
  });

  // ---------- import ----------
  const { parseCsv, parseIcs, parseDate, parseTime } = require('./import');
  const studioTime = d => d.toLocaleString('sv-SE', { timeZone: 'America/Chicago' }).slice(0, 16).replace(' ', 'T');
  const ymd = tomorrow.replace(/-/g, '');
  const post = (p, body, who) => call('POST', p, body, who.token);

  await ok('CSV parsing: headers, quotes, 12-hour times, bad rows', async () => {
    assert.equal(parseTime('6:00 PM'), '18:00'); assert.equal(parseTime('12 am'), '00:00'); assert.equal(parseTime('12:30pm'), '12:30');
    assert.equal(parseTime('25:00'), null); assert.equal(parseTime('13:00 pm'), null);
    assert.equal(parseDate('3/9/2027'), '2027-03-09'); assert.equal(parseDate('2027-02-30'), null);
    const r = parseCsv('﻿Day,Start Time,Class Name,Studio\r\n"11/20/2026","6:00 AM","Yoga Sculpt, hot","Lincoln Park"\nnot a date,6am,X,Y\n');
    assert.deepEqual(r.rows, [{ type: 'Yoga Sculpt, hot', location: 'Lincoln Park', start: '2026-11-20T06:00' }]);
    assert.equal(r.errors.length, 1);
    assert.match(parseCsv('date,class\n1/1/2027,Y').errors[0], /Missing column: time, location/);
  });

  await ok('calendar parsing: UTC converts to studio time, all-day skipped, folded lines, repeats flagged', async () => {
    const ics = ['BEGIN:VCALENDAR',
      'BEGIN:VEVENT', 'DTSTART:20261110T120000Z', 'SUMMARY:Yoga Sculpt\\, 60 min', 'LOCATION:CorePower Yoga - Old\r\n  Town', 'RRULE:FREQ=WEEKLY', 'END:VEVENT',
      'BEGIN:VEVENT', 'DTSTART;TZID=America/Chicago:20261111T183000', 'SUMMARY:CorePower1', 'LOCATION:Lakeview', 'END:VEVENT',
      'BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20261112', 'SUMMARY:Holiday', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
    const r = parseIcs(ics, studioTime);
    assert.equal(r.rows.length, 2);
    assert.deepEqual(r.rows[0], { type: 'Yoga Sculpt, 60 min', location: 'CorePower Yoga - Old Town', start: '2026-11-10T06:00', recurring: true });
    assert.equal(r.rows[1].start, '2026-11-11T18:30');
    assert.match(r.errors[0], /1 all-day event was skipped/);
  });

  await ok('import preview matches the studio schedule and flags problems', async () => {
    const csv = `date,time,class,location\n${tomorrow},6:00 AM,Yoga Sculpt,CorePower Lincoln Park\n${tomorrow},9:00 PM,Dentist,Downtown\n2020-01-01,6:00 AM,Old class,Old Town\n${tomorrow},7:00 PM,Barre,`;
    const p = (await post('/api/import/preview', { text: csv }, A)).body;
    assert.equal(p.rows.length, 4);
    const by = t => p.rows.find(r => r.type === t);
    assert.equal(by('Yoga Sculpt').matched, true); assert.equal(by('Yoga Sculpt').likely, true);
    assert.equal(by('Dentist').likely, false);
    assert.equal(by('Old class').error, 'Already started');
    assert.equal(by('Barre').error, 'Add a location');
    assert.equal((await post('/api/import/preview', { text: '  ' }, A)).status, 400);
    assert.equal((await call('POST', '/api/import/preview', { text: csv })).status, 401);
  });

  await ok('import commit books studio classes and creates member classes', async () => {
    await call('POST', '/api/cancel', { classId: Y.id }, A.token); // free the 6:00 slot
    const lincoln = day.find(c => c.start.endsWith('T06:00') && c.location === 'Lincoln Park');
    const rows = [
      { type: 'anything', location: 'CorePower Lincoln Park', start: tomorrow + 'T06:00' },
      { type: 'Barre', location: 'Wicker Park', start: tomorrow + 'T20:00' },
      { type: 'Bad', location: 'Old Town', start: 'nonsense' },
      { type: 'Past', location: 'Old Town', start: '2020-01-01T06:00' }
    ];
    const r = (await post('/api/import/commit', { rows }, A)).body;
    assert.equal(r.booked, 2); assert.equal(r.skipped.length, 2);
    const mine = (await call('GET', '/api/bookings', null, A.token)).body.classes;
    assert.ok(mine.some(c => c.id === lincoln.id), 'studio class booked, not duplicated');
    assert.ok(mine.some(c => c.type === 'Barre' && c.location === 'Wicker Park'));
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM classes WHERE location='Lincoln Park' AND start=?`).get(tomorrow + 'T06:00').n, 1);
    const again = (await post('/api/import/commit', { rows }, A)).body;
    assert.equal(again.booked, 0, 'importing twice adds nothing');
    assert.equal((await post('/api/import/commit', { rows: [] }, A)).status, 400);
    assert.equal((await post('/api/import/commit', { rows: Array(201).fill(rows[0]) }, A)).status, 400);
  });

  await ok('a member-added class is visible only to that member and their friends', async () => {
    const wicker = db.prepare(`SELECT id FROM classes WHERE location='Wicker Park' AND created_by=?`).get(A.id);
    const listed = who => call('GET', '/api/classes?date=' + tomorrow, null, who.token).then(r => r.body.classes.some(c => c.id === wicker.id));
    assert.equal(await listed(A), true);
    assert.equal(await listed(C), false);
    assert.equal(await listed(B), false, 'not friends right now');
    assert.equal((await post('/api/book', { classId: wicker.id }, C)).status, 404);
    await post('/api/friends/request', { email: 'ann@example.com' }, B);
    const inc = (await call('GET', '/api/friends', null, A.token)).body.incoming[0];
    await post('/api/friends/respond', { friendshipId: inc.friendshipId, accept: true }, A);
    assert.equal(await listed(B), true, 'friends can see it');
    assert.equal((await post('/api/book', { classId: wicker.id }, B)).status, 201);
    const rowB = [{ type: 'Barre', location: 'Wicker Park', start: tomorrow + 'T20:00' }];
    const rC = (await post('/api/import/commit', { rows: rowB }, C)).body;
    assert.equal(rC.booked, 1, 'a stranger gets their own separate class, never A\'s');
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM classes WHERE location='Wicker Park'`).get().n, 2);
  });

  await ok('email verification', async () => {
    const r = await call('POST', '/api/signup', { name: 'Dee\nInjected', email: 'dee@example.com', password: 'password123' });
    assert.equal(r.status, 201); assert.equal(r.body.user.verified, 0);
    const mail = outbox.find(x => x.to === 'dee@example.com');
    assert.match(mail.body, /^Hi Dee Injected,\n/, 'newlines in a name cannot inject email text');
    assert.match(mail.body, /http:\/\/localhost:\d+\/#verify=[\w-]+/);
    const t1 = linkFor('dee@example.com', 'verify');
    assert.ok(!JSON.stringify(db.prepare('SELECT * FROM auth_tokens').all()).includes(t1), 'only a hash is stored');
    const dee = r.body.token;
    assert.equal((await call('GET', '/api/me', null, dee)).body.requireVerify, true);
    assert.equal((await call('POST', '/api/friends/request', { email: 'ann@example.com' }, dee)).status, 403, 'unconfirmed members cannot add friends');
    assert.equal((await call('POST', '/api/friends/request', { email: 'dee@example.com' }, A.token)).status, 404, 'unconfirmed members cannot be found');
    assert.equal((await call('POST', '/api/verify/resend', null, dee)).status, 200);
    assert.equal((await call('POST', '/api/verify/resend', null, dee)).status, 429, 'one resend a minute');
    assert.equal((await call('POST', '/api/verify', { token: t1 })).status, 400, 'a new link replaces the old one');
    assert.equal((await call('POST', '/api/verify', { token: 'x'.repeat(200) })).status, 400);
    assert.equal((await call('POST', '/api/verify', {})).status, 400);
    assert.equal((await call('POST', '/api/verify/resend', null, 'garbage.token')).status, 401);
    const t2 = linkFor('dee@example.com', 'verify');
    assert.equal((await call('POST', '/api/verify', { token: t2 })).status, 200);
    assert.equal((await call('POST', '/api/verify', { token: t2 })).status, 400, 'a link works once');
    assert.equal((await call('GET', '/api/me', null, dee)).body.user.verified, 1);
    assert.equal((await call('POST', '/api/verify/resend', null, dee)).body.already, true);
    assert.equal((await call('POST', '/api/friends/request', { email: 'ann@example.com' }, dee)).status, 201);
    // expired link
    const e = await call('POST', '/api/signup', { name: 'Ed', email: 'ed@example.com', password: 'password123' });
    const te = linkFor('ed@example.com', 'verify');
    db.prepare('UPDATE auth_tokens SET expires=? WHERE user=?').run(Date.now() - 1, e.body.user.id);
    assert.equal((await call('POST', '/api/verify', { token: te })).status, 400, 'expired link');
    assert.equal((await call('GET', '/api/me', null, e.body.token)).body.user.verified, 0);
  });

  await ok('password reset', async () => {
    const F = await signup('Fay', 'fay@example.com');
    const before = outbox.length;
    assert.equal((await call('POST', '/api/password/forgot', { email: 'not-an-email' })).status, 400);
    assert.equal((await call('POST', '/api/password/forgot', { email: 'nobody@example.com' })).status, 200, 'same answer for unknown emails');
    assert.equal(outbox.length, before, 'and no email is sent');
    assert.equal((await call('POST', '/api/password/forgot', { email: 'fay@example.com' })).status, 200);
    const t = linkFor('fay@example.com', 'reset');
    assert.ok(t); assert.ok(!JSON.stringify(db.prepare('SELECT * FROM auth_tokens').all()).includes(t), 'only a hash is stored');
    assert.equal((await call('POST', '/api/password/reset', { token: t, password: 'short' })).status, 400);
    assert.equal((await call('POST', '/api/password/reset', { token: 'nope', password: 'newpassword1' })).status, 400);
    assert.equal((await call('GET', '/api/me', null, F.token)).status, 200, 'still signed in until the password changes');
    assert.equal((await call('POST', '/api/password/reset', { token: t, password: 'newpassword1' })).status, 200);
    assert.equal((await call('POST', '/api/password/reset', { token: t, password: 'newpassword2' })).status, 400, 'a link works once');
    assert.equal((await call('GET', '/api/me', null, F.token)).status, 401, 'old sessions are signed out');
    assert.equal((await call('POST', '/api/login', { email: 'fay@example.com', password: 'password123' })).status, 401);
    const li = await call('POST', '/api/login', { email: 'fay@example.com', password: 'newpassword1' });
    assert.equal(li.status, 200);
    assert.equal((await call('GET', '/api/me', null, li.body.token)).status, 200, 'new sessions work');
    // a reset also proves the inbox is theirs
    const g = await call('POST', '/api/signup', { name: 'Gus', email: 'gus@example.com', password: 'password123' });
    assert.equal(g.body.user.verified, 0);
    await call('POST', '/api/password/forgot', { email: 'gus@example.com' });
    await call('POST', '/api/password/reset', { token: linkFor('gus@example.com', 'reset'), password: 'newpassword1' });
    assert.equal((await call('POST', '/api/login', { email: 'gus@example.com', password: 'newpassword1' })).body.user.verified, 1);
    // flooding one inbox is capped
    for (let i = 0; i < 8; i++) await call('POST', '/api/password/forgot', { email: 'gus@example.com' });
    assert.ok(outbox.filter(x => x.to === 'gus@example.com').length <= 4, 'at most 4 emails an hour to one address');
  });

  await ok('notifications', async () => {
    const P = await signup('Pat', 'pat@example.com'), Q = await signup('Quin', 'quin@example.com'), R = await signup('Rae', 'rae@example.com');
    const list = async who => (await call('GET', '/api/notifications', null, who.token)).body;
    const joined = async who => (await list(who)).items.filter(i => i.kind === 'joined');
    assert.equal((await call('GET', '/api/notifications', null, null)).status, 401);
    assert.deepEqual(await list(P), { items: [], unread: 0 });
    // friend request
    await call('POST', '/api/friends/request', { email: 'quin@example.com' }, P.token);
    let q = await list(Q);
    assert.equal(q.unread, 1); assert.equal(q.items[0].kind, 'request'); assert.equal(q.items[0].actor.name, 'Pat');
    assert.equal((await list(R)).items.length, 0, 'strangers see nothing');
    const fid = (await call('GET', '/api/friends', null, Q.token)).body.incoming[0].friendshipId;
    await call('POST', '/api/friends/respond', { friendshipId: fid, accept: true }, Q.token);
    assert.equal((await list(Q)).items.length, 0, 'answered requests leave the list');
    let p = await list(P);
    assert.equal(p.items[0].kind, 'accepted'); assert.equal(p.items[0].actor.name, 'Quin');
    // reading
    assert.equal((await call('POST', '/api/notifications/read', { ids: [p.items[0].id] }, R.token)).status, 200);
    assert.equal((await list(P)).unread, 1, 'someone else cannot mark yours read');
    await call('POST', '/api/notifications/read', { ids: [p.items[0].id] }, P.token);
    p = await list(P); assert.equal(p.unread, 0); assert.equal(p.items[0].read, true);
    // a friend booking a class you are in
    const K = (await call('GET', '/api/classes?date=' + tomorrow, null, P.token)).body.classes.find(c => c.start.endsWith('T18:00'));
    await call('POST', '/api/book', { classId: K.id }, P.token);
    await call('POST', '/api/book', { classId: K.id }, Q.token);
    assert.equal((await joined(P)).length, 0, 'no alert while Quin shares nothing with Pat');
    await call('POST', '/api/visibility', { friendId: P.id, level: 'full' }, Q.token);
    await call('POST', '/api/cancel', { classId: K.id }, Q.token);
    await call('POST', '/api/book', { classId: K.id }, Q.token);
    p = { items: await joined(P) };
    assert.equal(p.items.length, 1); assert.equal(p.items[0].kind, 'joined');
    assert.equal(p.items[0].cls.id, K.id); assert.equal(p.items[0].actor.name, 'Quin'); assert.equal(p.items[0].unread, undefined);
    assert.equal((await joined(R)).length, 0);
    assert.equal((await joined(Q)).length, 0, 'the booker is not told about their own booking');
    // privacy is checked when the list is read, not only when the event happened
    await call('POST', '/api/privacy', { hide_all: true }, Q.token);
    assert.equal((await joined(P)).length, 0, 'hidden schedule: alert disappears');
    await call('POST', '/api/privacy', { hide_all: false }, Q.token);
    assert.equal((await joined(P)).length, 1);
    await call('POST', '/api/booking/private', { classId: K.id, private: true }, Q.token);
    assert.equal((await joined(P)).length, 0, 'private class: alert disappears');
    await call('POST', '/api/booking/private', { classId: K.id, private: false }, Q.token);
    await call('POST', '/api/visibility', { friendId: P.id, level: 'busy' }, Q.token);
    assert.equal((await joined(P)).length, 0, 'busy only: no class details leak');
    await call('POST', '/api/visibility', { friendId: P.id, level: 'full' }, Q.token);
    assert.equal((await joined(P)).length, 1);
    await call('POST', '/api/cancel', { classId: K.id }, P.token);
    assert.equal((await joined(P)).length, 0, 'you left the class');
    await call('POST', '/api/book', { classId: K.id }, P.token);
    assert.equal((await joined(Q)).length, 0, "Pat shares nothing with Quin, so Quin is not told");
  });
  await ok('studios: chosen after sign-up, validated, and each home page lists only its studio', async () => {
    const r = await call('POST', '/api/signup', { name: 'Studio Sam', email: 'studiosam@example.com', password: 'password123' });
    const tok = r.body.token;
    const me0 = (await call('GET', '/api/me', null, tok)).body;
    assert.equal(me0.user.studios, null, 'new members have not chosen yet');
    assert.deepEqual(me0.studios.map(x => x.id), ['corepower', 'solid', 'barre']);
    assert.equal((await call('POST', '/api/studios', { studios: [] }, tok)).status, 400);
    assert.equal((await call('POST', '/api/studios', { studios: ['gold'] }, tok)).status, 400);
    assert.equal((await call('POST', '/api/studios', { studios: 'solid' }, tok)).status, 400);
    assert.equal((await call('POST', '/api/studios', { studios: ['solid', 'barre', 'solid'] }, tok)).status, 200);
    assert.deepEqual((await call('GET', '/api/me', null, tok)).body.user.studios, ['solid', 'barre']);
    const day = async st => (await call('GET', '/api/classes?date=' + tomorrow + '&studio=' + st, null, tok)).body.classes;
    for (const st of ['corepower', 'solid', 'barre']) {
      const cs = await day(st);
      assert.ok(cs.length >= 9, st + ' has classes');
      assert.ok(cs.every(c => c.studio === st), 'only ' + st);
    }
    assert.equal((await call('GET', '/api/classes?date=' + tomorrow + '&studio=nope', null, tok)).status, 400);
    assert.equal((await call('POST', '/api/studios', { studios: ['barre'] })).status, 401);
    const all = (await call('GET', '/api/classes?date=' + tomorrow, null, tok)).body.classes;
    assert.ok(all.length >= 27, 'no filter still returns every studio');
  });
  await ok('a hand-added class lands in the studio it names', async () => {
    const r = await call('POST', '/api/signup', { name: 'Imp Orter', email: 'imp@example.com', password: 'password123' });
    const tok = r.body.token;
    await call('POST', '/api/studios', { studios: ['solid'] }, tok);
    const rows = [{ type: 'Mystery class', location: 'Somewhere Else', start: tomorrow + 'T21:00' }];
    assert.equal((await call('POST', '/api/import/commit', { rows }, tok)).body.booked, 1);
    const c = db.prepare(`SELECT studio FROM classes WHERE location='Somewhere Else'`).get();
    assert.equal(c.studio, 'solid', 'unknown location falls back to the member\'s first studio');
  });
  await ok('databases from version 0.1 upgrade in place', async () => {
    const { spawnSync } = require('child_process');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duoflow-old-'));
    const { DatabaseSync } = require('node:sqlite');
    const old = new DatabaseSync(path.join(dir, 'duoflow.db'));
    old.exec(`CREATE TABLE classes(id INTEGER PRIMARY KEY, type TEXT NOT NULL, location TEXT NOT NULL, start TEXT NOT NULL, capacity INTEGER NOT NULL, UNIQUE(location,start));
      INSERT INTO classes(id,type,location,start,capacity) VALUES(7,'Yoga Sculpt','Old Town','2099-01-01T06:00',20);`);
    old.close();
    const r = spawnSync(process.execPath, ['-e', `process.env.PORT='0';const {db,server}=require('./server');
      const c=db.prepare('SELECT id,type,created_by FROM classes WHERE id=7').get();
      console.log(JSON.stringify(c));server.close();db.close();process.exit(0)`],
      { cwd: __dirname, env: { ...process.env, DATA_DIR: dir, PORT: '0' }, encoding: 'utf8' });
    assert.match(r.stdout, /\{"id":7,"type":"Yoga Sculpt","created_by":null\}/, r.stderr);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  console.log(`\n${passed} test groups passed`);
  server.close(); db.close();
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  process.exit(0);
})().catch(e => { console.error('\nFAILED:', e); process.exit(1); });
