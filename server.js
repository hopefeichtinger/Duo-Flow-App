'use strict';
// Duo Flow server: zero dependencies. Needs Node 22.13+ (built-in node:sqlite).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 3000);
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA, { recursive: true });
const db = new DatabaseSync(process.env.DB_PATH || path.join(DATA, 'duoflow.db'));
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
  pw TEXT NOT NULL, hide_all INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS friendships(
  id INTEGER PRIMARY KEY, a INTEGER NOT NULL, b INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','accepted')), UNIQUE(a,b));
CREATE TABLE IF NOT EXISTS visibility(
  owner INTEGER NOT NULL, viewer INTEGER NOT NULL,
  level TEXT NOT NULL CHECK(level IN ('full','busy','hidden')), PRIMARY KEY(owner,viewer));
CREATE TABLE IF NOT EXISTS classes(
  id INTEGER PRIMARY KEY, type TEXT NOT NULL, location TEXT NOT NULL,
  start TEXT NOT NULL, capacity INTEGER NOT NULL, created_by INTEGER);
CREATE TABLE IF NOT EXISTS bookings(
  user INTEGER NOT NULL, class INTEGER NOT NULL, private INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(user,class));
`);
// Upgrade databases made by version 0.1 (classes had no created_by column).
if (!db.prepare('PRAGMA table_info(classes)').all().some(c => c.name === 'created_by')) {
  db.exec(`ALTER TABLE classes RENAME TO classes_old;
    CREATE TABLE classes(id INTEGER PRIMARY KEY, type TEXT NOT NULL, location TEXT NOT NULL,
      start TEXT NOT NULL, capacity INTEGER NOT NULL, created_by INTEGER);
    INSERT INTO classes(id,type,location,start,capacity) SELECT id,type,location,start,capacity FROM classes_old;
    DROP TABLE classes_old;`);
}
db.exec(`
CREATE TABLE IF NOT EXISTS auth_tokens(
  id INTEGER PRIMARY KEY, user INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('verify','reset')),
  hash TEXT NOT NULL UNIQUE, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS notifications(
  id INTEGER PRIMARY KEY, user INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('request','accepted','joined')),
  actor INTEGER NOT NULL, class INTEGER, created TEXT NOT NULL, read INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS notif_user ON notifications(user, read);
`);
// Version 0.3: email verification and session versions. Accounts that already exist count as verified.
{
  const cols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
  if (!cols.includes('verified')) db.exec('ALTER TABLE users ADD COLUMN verified INTEGER NOT NULL DEFAULT 1');
  if (!cols.includes('tv')) db.exec('ALTER TABLE users ADD COLUMN tv INTEGER NOT NULL DEFAULT 0');
}
// Studio schedule rows have created_by NULL; member-added classes belong to the member who added them.
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS classes_uniq ON classes(location, start, COALESCE(created_by, 0))');

// ---------- secret ----------
function loadSecret() {
  if (process.env.SECRET) return process.env.SECRET;
  const f = path.join(DATA, 'secret');
  try { return fs.readFileSync(f, 'utf8'); } catch {}
  const s = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(f, s, { mode: 0o600 });
  return s;
}
const SECRET = loadSecret();

// ---------- email ----------
// With RESEND_API_KEY set, mail goes out through Resend. Without it, messages are printed in the server log
// (and kept in `outbox` for tests) and email verification is off unless REQUIRE_VERIFY=1.
const RESEND_KEY = process.env.RESEND_API_KEY || '';
const MAIL_FROM = process.env.MAIL_FROM || 'Duo Flow <onboarding@resend.dev>';
const REQUIRE_VERIFY = process.env.REQUIRE_VERIFY ? process.env.REQUIRE_VERIFY === '1' : !!RESEND_KEY;
const MAIL_HOURLY_CAP = Number(process.env.MAIL_HOURLY_CAP || 60);
const baseUrl = () => (process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const outbox = [];
async function sendMail(to, subject, body) {
  if (!RESEND_KEY) {
    outbox.push({ to, subject, body });
    if (outbox.length > 50) outbox.shift();
    if (process.env.NODE_ENV !== 'test') console.log(`[email not configured, printing instead]\nTo: ${to}\nSubject: ${subject}\n\n${body}\n`);
    return false;
  }
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: MAIL_FROM, to: [to], subject, text: body }), signal: AbortSignal.timeout(8000)
    });
    if (!r.ok) { console.error('Email send failed', r.status, (await r.text()).slice(0, 200)); return false; }
    return true;
  } catch (e) { console.error('Email send failed', e.message); return false; }
}
// Simple in-memory sliding-window limiter. Returns true when the limit is already reached.
const hits = new Map();
function hit(key, max, windowMs) {
  const now = Date.now();
  const list = (hits.get(key) || []).filter(t => now - t < windowMs);
  if (list.length >= max) { hits.set(key, list); return true; }
  list.push(now); hits.set(key, list); return false;
}
// Caps protect the email quota and stop the app being used to flood someone's inbox.
const mailAllowed = to => !hit('mail|' + to, 4, 3600e3) && !hit('mail|all', MAIL_HOURLY_CAP, 3600e3);
const sha = v => crypto.createHash('sha256').update(v).digest('hex');
// One-time link tokens: only a hash is stored, so a copy of the database can't be used to take over accounts.
function newAuthToken(uid, kind, ttlMs) {
  db.prepare('DELETE FROM auth_tokens WHERE user=? AND kind=?').run(uid, kind);
  const raw = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO auth_tokens(user,kind,hash,expires) VALUES(?,?,?,?)').run(uid, kind, sha(raw), Date.now() + ttlMs);
  return raw;
}
function useAuthToken(raw, kind) {
  const row = typeof raw === 'string' && raw.length < 100 ? db.prepare('SELECT * FROM auth_tokens WHERE hash=? AND kind=?').get(sha(raw), kind) : null;
  if (!row) return null;
  db.prepare('DELETE FROM auth_tokens WHERE id=?').run(row.id);
  return row.expires > Date.now() ? row.user : null;
}
function sendVerification(u) {
  const raw = newAuthToken(u.id, 'verify', 24 * 3600e3);
  return sendMail(u.email, 'Confirm your email for Duo Flow',
    `Hi ${u.name},\n\nConfirm your email to start adding friends on Duo Flow:\n\n${baseUrl()}/#verify=${raw}\n\nThis link works for 24 hours. If you didn't create an account, you can ignore this email.\n`);
}
setInterval(() => {
  db.prepare('DELETE FROM auth_tokens WHERE expires<?').run(Date.now());
  const cut = Date.now() - 3600e3;
  for (const m of [hits, attempts]) for (const [k, v] of m) { const f = v.filter(t => t > cut); if (f.length) m.set(k, f); else m.delete(k); }
}, 3600e3).unref();

// ---------- time (studio time, Chicago) ----------
const TZ = 'America/Chicago';
const nowLocal = () => new Date().toLocaleString('sv-SE', { timeZone: TZ }).slice(0, 16).replace(' ', 'T');
const todayStr = () => nowLocal().slice(0, 10);
const addDays = (s, n) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');

// ---------- class schedule (sample data; replace with a real feed later) ----------
const TYPES = ['Yoga Sculpt', 'CorePower StrengthX', 'CorePower1', 'CorePower 2'];
const LOCS = ['Lakeview', 'Lincoln Park', 'Old Town'];
const TIMES = ['06:00', '12:00', '18:00'];
function ensureClasses() {
  const ins = db.prepare(`INSERT INTO classes(type,location,start,capacity)
    SELECT ?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM classes WHERE location=? AND start=? AND created_by IS NULL)`);
  const t = todayStr();
  for (let d = 0; d < 14; d++) {
    const day = addDays(t, d);
    TIMES.forEach((tm, j) => LOCS.forEach((loc, k) => {
      const start = `${day}T${tm}`;
      ins.run(TYPES[(d + j + k) % 4], loc, start, 12 + ((d * 7 + j * 5 + k * 3) % 13), loc, start);
    }));
  }
}
ensureClasses();
setInterval(ensureClasses, 6 * 3600 * 1000).unref();

// ---------- auth ----------
const b64 = b => Buffer.from(b).toString('base64url');
const sign = s => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');
const makeToken = (uid, tv = 0) => { const p = b64(JSON.stringify({ uid, tv, exp: Date.now() + 30 * 864e5 })); return p + '.' + sign(p); };
function readToken(t) {
  if (!t) return null;
  const [p, s] = String(t).split('.');
  if (!p || !s) return null;
  const e = sign(p);
  if (e.length !== s.length || !crypto.timingSafeEqual(Buffer.from(e), Buffer.from(s))) return null;
  try { const o = JSON.parse(Buffer.from(p, 'base64url')); return o.exp > Date.now() ? { uid: o.uid, tv: o.tv || 0 } : null; } catch { return null; }
}
const hashPw = pw => { const salt = crypto.randomBytes(16); return salt.toString('hex') + ':' + crypto.scryptSync(pw, salt, 64).toString('hex'); };
const checkPw = (pw, st) => {
  const [s, h] = st.split(':');
  return crypto.timingSafeEqual(crypto.scryptSync(pw, Buffer.from(s, 'hex'), 64), Buffer.from(h, 'hex'));
};
const attempts = new Map();
function throttled(key) {
  const now = Date.now();
  const list = (attempts.get(key) || []).filter(t => now - t < 15 * 60 * 1000);
  attempts.set(key, list);
  return list.length >= 10;
}
const noteFail = key => attempts.set(key, [...(attempts.get(key) || []), Date.now()]);

// ---------- privacy core ----------
// What `owner` lets `viewer` see: 'full' | 'busy' | 'hidden'.
// Hidden unless they are accepted friends, the owner has not hidden everything, and the owner chose a level.
function areFriends(x, y) {
  return !!db.prepare(`SELECT 1 FROM friendships WHERE status='accepted' AND ((a=? AND b=?) OR (a=? AND b=?))`).get(x, y, y, x);
}
function levelFor(owner, viewer) {
  if (owner === viewer || !areFriends(owner, viewer)) return 'hidden';
  const u = db.prepare('SELECT hide_all FROM users WHERE id=?').get(owner);
  if (!u || u.hide_all) return 'hidden';
  const v = db.prepare('SELECT level FROM visibility WHERE owner=? AND viewer=?').get(owner, viewer);
  return v ? v.level : 'hidden';
}
const friendIds = uid => db.prepare(
  `SELECT CASE WHEN a=? THEN b ELSE a END AS f FROM friendships WHERE status='accepted' AND (a=? OR b=?)`
).all(uid, uid, uid).map(r => r.f);
const userName = id => (db.prepare('SELECT name FROM users WHERE id=?').get(id) || {}).name;

// Studio classes are visible to everyone. A class a member added by hand is visible only to them and their friends.
const canSee = (c, uid, fids) => c.created_by == null || c.created_by === uid || (fids || friendIds(uid)).includes(c.created_by);

function classesFor(uid, from, to) {
  const fids = friendIds(uid);
  const cls = db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM bookings WHERE class=c.id) AS booked
    FROM classes c WHERE substr(c.start,1,10) BETWEEN ? AND ? ORDER BY c.start, c.location`).all(from, to)
    .filter(c => canSee(c, uid, fids));
  const mine = new Map(db.prepare('SELECT class, private FROM bookings WHERE user=?').all(uid).map(r => [r.class, r.private]));
  const friends = [];
  for (const id of friendIds(uid)) {
    const lvl = levelFor(id, uid);
    if (lvl === 'hidden') continue;
    const rows = db.prepare(`SELECT b.class AS cid, c.start FROM bookings b JOIN classes c ON c.id=b.class
      WHERE b.user=? AND b.private=0 AND substr(c.start,1,10) BETWEEN ? AND ?`).all(id, from, to);
    friends.push({ id, name: userName(id), lvl, classes: new Set(rows.map(r => r.cid)), starts: new Set(rows.map(r => r.start)) });
  }
  return cls.map(c => {
    const going = [], busy = [];
    for (const f of friends) {
      if (f.lvl === 'full' && f.classes.has(c.id)) going.push({ id: f.id, name: f.name });
      else if (f.starts.has(c.start)) busy.push({ id: f.id, name: f.name });
    }
    return {
      id: c.id, type: c.type, location: c.location, start: c.start,
      spotsLeft: c.capacity - c.booked, booked: mine.has(c.id), private: mine.get(c.id) === 1, going, busy
    };
  });
}

// ---------- notifications ----------
// Stored as events. What a member may see is re-checked every time the list is read, so a friend who later
// hides their schedule, makes a class private, or cancels disappears from the list instead of leaking.
function notify(user, kind, actor, cls) {
  if (db.prepare('SELECT 1 FROM notifications WHERE user=? AND kind=? AND actor=? AND COALESCE(class,0)=? AND read=0').get(user, kind, actor, cls || 0)) return;
  db.prepare('INSERT INTO notifications(user,kind,actor,class,created) VALUES(?,?,?,?,?)').run(user, kind, actor, cls || null, new Date().toISOString());
}
// `uid` just booked `cid`: tell friends already in that class, but only those allowed to see uid's full schedule.
function notifyJoined(uid, cid) {
  for (const { user } of db.prepare('SELECT user FROM bookings WHERE class=? AND user<>?').all(cid, uid))
    if (levelFor(uid, user) === 'full') notify(user, 'joined', uid, cid);
}
function notificationsFor(uid) {
  const now = nowLocal(), out = [];
  for (const n of db.prepare('SELECT * FROM notifications WHERE user=? ORDER BY id DESC LIMIT 80').all(uid)) {
    const name = userName(n.actor);
    if (!name) continue;
    const item = { id: n.id, kind: n.kind, read: !!n.read, created: n.created, actor: { id: n.actor, name } };
    if (n.kind === 'request' && !db.prepare(`SELECT 1 FROM friendships WHERE a=? AND b=? AND status='pending'`).get(n.actor, uid)) continue;
    if (n.kind === 'accepted' && !areFriends(n.actor, uid)) continue;
    if (n.kind === 'joined') {
      const c = db.prepare(`SELECT c.type, c.location, c.start, c.created_by FROM classes c
        JOIN bookings b ON b.class=c.id AND b.user=? AND b.private=0 WHERE c.id=?`).get(n.actor, n.class);
      if (!c || c.start < now || !canSee(c, uid) || levelFor(n.actor, uid) !== 'full'
        || !db.prepare('SELECT 1 FROM bookings WHERE user=? AND class=?').get(uid, n.class)) continue;
      item.cls = { id: n.class, type: c.type, location: c.location, start: c.start };
    }
    out.push(item);
  }
  return out.slice(0, 50);
}

// ---------- http helpers ----------
const send = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
};
const fail = (code, msg) => Object.assign(new Error(msg), { code });
const { parseAny, clean } = require('./import');
const LIKELY = /corepower|yoga|sculpt|pilates|barre|strengthx|hiit|cycle|spin|class/i;
const studioTime = d => d.toLocaleString('sv-SE', { timeZone: TZ }).slice(0, 16).replace(' ', 'T');

// Validates one imported row; returns the cleaned row or { error }.
function checkRow(r) {
  const type = clean(r && r.type) || 'Class', location = clean(r && r.location);
  const start = r && typeof r.start === 'string' ? r.start : '';
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(start) || isNaN(Date.parse(start + ':00Z'))) return { error: 'Could not read the date or time' };
  if (!location) return { error: 'Add a location' };
  if (start < nowLocal()) return { error: 'Already started' };
  if (start > addDays(todayStr(), 60) + 'T23:59') return { error: 'More than 60 days away' };
  return { type, location, start };
}
// An imported class that matches the studio schedule books that class instead of creating a new one.
function matchStudio(location, start) {
  const l = location.toLowerCase();
  const loc = LOCS.find(x => l.includes(x.toLowerCase()));
  return loc ? db.prepare('SELECT id FROM classes WHERE created_by IS NULL AND location=? AND start=?').get(loc, start) || null : null;
}
function bookClass(uid, cid) {
  const c = cid && db.prepare('SELECT c.*, (SELECT COUNT(*) FROM bookings WHERE class=c.id) AS booked FROM classes c WHERE id=?').get(cid);
  if (!c || !canSee(c, uid)) throw fail(404, 'Class not found');
  if (c.start < nowLocal()) throw fail(409, 'That class has already started');
  if (db.prepare('SELECT 1 FROM bookings WHERE user=? AND class=?').get(uid, cid)) throw fail(409, 'You already booked this class');
  if (db.prepare('SELECT 1 FROM bookings b JOIN classes k ON k.id=b.class WHERE b.user=? AND k.start=?').get(uid, c.start))
    throw fail(409, 'You already have a class at that time');
  if (c.booked >= c.capacity) throw fail(409, 'This class is full');
  db.prepare('INSERT INTO bookings(user,class) VALUES(?,?)').run(uid, cid);
  notifyJoined(uid, cid);
}

function readBody(req, limit = 10000) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', c => { n += c.length; if (n > limit) { reject(fail(413, 'Request too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}); } catch { reject(fail(400, 'Invalid JSON')); } });
    req.on('error', reject);
  });
}
const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const int = v => (Number.isInteger(v) ? v : null);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

// ---------- API ----------
async function api(req, res, url) {
  const route = `${req.method} ${url.pathname}`;
  const q = url.searchParams;

  if (route === 'POST /api/signup' || route === 'POST /api/login') {
    const b = await readBody(req);
    const email = text(b.email, 120).toLowerCase();
    const pw = typeof b.password === 'string' ? b.password : '';
    const key = `${req.socket.remoteAddress}|${email}`;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw fail(400, 'Enter a valid email address');
    if (throttled(key)) throw fail(429, 'Too many attempts. Try again in 15 minutes.');
    if (route === 'POST /api/signup') {
      const name = text(b.name, 60).replace(/\s+/g, ' ');
      if (!name) throw fail(400, 'Enter your name');
      if (pw.length < 8 || pw.length > 200) throw fail(400, 'Password must be at least 8 characters');
      if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) throw fail(409, 'That email already has an account');
      const verified = REQUIRE_VERIFY ? 0 : 1;
      const r = db.prepare('INSERT INTO users(name,email,pw,verified) VALUES(?,?,?,?)').run(name, email, hashPw(pw), verified);
      const id = Number(r.lastInsertRowid);
      if (REQUIRE_VERIFY && mailAllowed(email)) sendVerification({ id, name, email });
      return send(res, 201, { token: makeToken(id), user: { id, name, email, hide_all: 0, verified } });
    }
    const u = db.prepare('SELECT * FROM users WHERE email=?').get(email);
    if (!u || !checkPw(pw, u.pw)) { noteFail(key); throw fail(401, 'Email or password is incorrect'); }
    return send(res, 200, { token: makeToken(u.id, u.tv), user: { id: u.id, name: u.name, email: u.email, hide_all: u.hide_all, verified: u.verified } });
  }

  // Public email links. Tokens travel in the URL fragment (#verify=... / #reset=...), so they never reach server logs.
  if (route === 'POST /api/verify') {
    const b = await readBody(req);
    const id = useAuthToken(b.token, 'verify');
    if (!id) throw fail(400, 'This link has expired or was already used. Sign in and ask for a new one.');
    db.prepare('UPDATE users SET verified=1 WHERE id=?').run(id);
    return send(res, 200, { ok: true });
  }
  if (route === 'POST /api/password/forgot') {
    const b = await readBody(req);
    const email = text(b.email, 120).toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw fail(400, 'Enter a valid email address');
    const u = db.prepare('SELECT id,name,email FROM users WHERE email=?').get(email);
    // Same answer whether or not the address has an account, so this can't be used to look people up.
    if (u && mailAllowed(email)) {
      const raw = newAuthToken(u.id, 'reset', 3600e3);
      sendMail(email, 'Reset your Duo Flow password',
        `Hi ${u.name},\n\nChoose a new password:\n\n${baseUrl()}/#reset=${raw}\n\nThis link works for 1 hour and only once. If you didn't ask for this, ignore this email. Your password stays the same.\n`);
    }
    return send(res, 200, { ok: true });
  }
  if (route === 'POST /api/password/reset') {
    const b = await readBody(req);
    const pw = typeof b.password === 'string' ? b.password : '';
    if (pw.length < 8 || pw.length > 200) throw fail(400, 'Password must be at least 8 characters');
    const id = useAuthToken(b.token, 'reset');
    if (!id) throw fail(400, 'This reset link has expired or was already used. Ask for a new one.');
    // tv+1 signs out every device that was already signed in. Using the emailed link also proves the address is theirs.
    db.prepare('UPDATE users SET pw=?, tv=tv+1, verified=1 WHERE id=?').run(hashPw(pw), id);
    db.prepare('DELETE FROM auth_tokens WHERE user=?').run(id);
    return send(res, 200, { ok: true });
  }

  const auth = (req.headers.authorization || '').replace(/^Bearer /, '');
  const tok = readToken(auth);
  const au = tok && db.prepare('SELECT id,tv FROM users WHERE id=?').get(tok.uid);
  if (!au || au.tv !== tok.tv) throw fail(401, 'Sign in to continue');
  const uid = au.id;

  if (route === 'GET /api/me') {
    const u = db.prepare('SELECT id,name,email,hide_all,verified FROM users WHERE id=?').get(uid);
    return send(res, 200, { user: u, today: todayStr(), requireVerify: REQUIRE_VERIFY });
  }
  if (route === 'POST /api/verify/resend') {
    const u = db.prepare('SELECT id,name,email,verified FROM users WHERE id=?').get(uid);
    if (u.verified) return send(res, 200, { ok: true, already: true });
    if (hit('resend|' + uid, 1, 60e3)) throw fail(429, 'Wait a minute before asking for another email.');
    if (!mailAllowed(u.email)) throw fail(429, 'Too many emails sent to this address. Try again later.');
    sendVerification(u);
    return send(res, 200, { ok: true });
  }
  if (route === 'GET /api/notifications') {
    const items = notificationsFor(uid);
    return send(res, 200, { items, unread: items.filter(n => !n.read).length });
  }
  if (route === 'POST /api/notifications/read') {
    const b = await readBody(req);
    if (b.all) db.prepare('UPDATE notifications SET read=1 WHERE user=?').run(uid);
    else for (const id of (Array.isArray(b.ids) ? b.ids : []).slice(0, 100)) if (Number.isInteger(id)) db.prepare('UPDATE notifications SET read=1 WHERE user=? AND id=?').run(uid, id);
    return send(res, 200, { ok: true });
  }
  if (route === 'POST /api/privacy') {
    const b = await readBody(req);
    db.prepare('UPDATE users SET hide_all=? WHERE id=?').run(b.hide_all ? 1 : 0, uid);
    return send(res, 200, { hide_all: b.hide_all ? 1 : 0 });
  }
  if (route === 'GET /api/classes') {
    const day = q.get('date') || todayStr();
    if (!isDate(day)) throw fail(400, 'Invalid date');
    return send(res, 200, { classes: classesFor(uid, day, day) });
  }
  if (route === 'GET /api/bookings') {
    const t = todayStr();
    return send(res, 200, { classes: classesFor(uid, t, addDays(t, 13)).filter(c => c.booked && c.start >= nowLocal()) });
  }
  if (route === 'POST /api/book') {
    const b = await readBody(req);
    bookClass(uid, int(b.classId));
    return send(res, 201, { ok: true });
  }
  if (route === 'POST /api/import/preview') {
    const b = await readBody(req, 300000);
    const text = typeof b.text === 'string' ? b.text : '';
    if (!text.trim()) throw fail(400, 'Paste or choose a file first');
    const p = parseAny(text, studioTime);
    const rows = p.rows.slice(0, 300).map(r => {
      const c = checkRow(r);
      if (c.error) return { type: r.type, location: r.location, start: r.start, error: c.error };
      const matched = !!matchStudio(c.location, c.start);
      return { ...c, matched, recurring: !!r.recurring, likely: matched || LIKELY.test(c.type + ' ' + c.location) };
    }).sort((x, y) => String(x.start).localeCompare(String(y.start)));
    return send(res, 200, { rows, errors: p.errors, truncated: p.rows.length > 300 });
  }
  if (route === 'POST /api/import/commit') {
    const b = await readBody(req, 300000);
    if (!Array.isArray(b.rows) || !b.rows.length) throw fail(400, 'Choose at least one class');
    if (b.rows.length > 200) throw fail(400, 'Add up to 200 classes at a time');
    let booked = 0; const skipped = [];
    for (const raw of b.rows) {
      const c = checkRow(raw);
      if (c.error) { skipped.push({ type: clean(raw && raw.type), start: raw && raw.start, reason: c.error }); continue; }
      let cid, created = false;
      const m = matchStudio(c.location, c.start);
      if (m) cid = m.id;
      else {
        const ex = db.prepare('SELECT id FROM classes WHERE created_by=? AND location=? AND start=?').get(uid, c.location, c.start);
        if (ex) cid = ex.id;
        else { cid = Number(db.prepare('INSERT INTO classes(type,location,start,capacity,created_by) VALUES(?,?,?,30,?)').run(c.type, c.location, c.start, uid).lastInsertRowid); created = true; }
      }
      try { bookClass(uid, cid); booked++; }
      catch (e) {
        if (created) db.prepare('DELETE FROM classes WHERE id=?').run(cid);
        skipped.push({ type: c.type, start: c.start, reason: e.message });
      }
    }
    return send(res, 200, { booked, skipped });
  }
  if (route === 'POST /api/cancel') {
    const b = await readBody(req);
    const cid = int(b.classId) || 0;
    db.prepare('DELETE FROM bookings WHERE user=? AND class=?').run(uid, cid);
    db.prepare(`DELETE FROM notifications WHERE kind='joined' AND ((actor=? AND class=?) OR (user=? AND class=?))`).run(uid, cid, uid, cid);
    return send(res, 200, { ok: true });
  }
  if (route === 'POST /api/booking/private') {
    const b = await readBody(req);
    const r = db.prepare('UPDATE bookings SET private=? WHERE user=? AND class=?').run(b.private ? 1 : 0, uid, int(b.classId) || 0);
    if (!r.changes) throw fail(404, 'Booking not found');
    return send(res, 200, { ok: true });
  }

  if (route === 'GET /api/friends') {
    const rows = db.prepare('SELECT id,a,b,status FROM friendships WHERE a=? OR b=?').all(uid, uid);
    const out = { friends: [], incoming: [], outgoing: [] };
    for (const r of rows) {
      const other = r.a === uid ? r.b : r.a;
      const o = db.prepare('SELECT id,name,email FROM users WHERE id=?').get(other);
      if (!o) continue;
      if (r.status === 'accepted') {
        const mine = db.prepare('SELECT level FROM visibility WHERE owner=? AND viewer=?').get(uid, other);
        out.friends.push({ id: o.id, name: o.name, email: o.email, sharesWithYou: levelFor(other, uid), youShare: mine ? mine.level : 'hidden' });
      } else if (r.b === uid) out.incoming.push({ friendshipId: r.id, user: { id: o.id, name: o.name } });
      else out.outgoing.push({ friendshipId: r.id, user: { id: o.id, name: o.name, email: o.email } });
    }
    return send(res, 200, out);
  }
  if (route === 'POST /api/friends/request') {
    const b = await readBody(req);
    const email = text(b.email, 120).toLowerCase();
    const mine = db.prepare('SELECT verified FROM users WHERE id=?').get(uid);
    if (REQUIRE_VERIFY && !mine.verified) throw fail(403, 'Confirm your email first. Check your inbox, or tap Resend at the top of the screen.');
    const o = db.prepare('SELECT id,name,verified FROM users WHERE email=?').get(email);
    if (!o || (REQUIRE_VERIFY && !o.verified)) throw fail(404, 'No member found with that email. They may need to confirm their email first.');
    if (o.id === uid) throw fail(400, 'That is your own email');
    const ex = db.prepare('SELECT * FROM friendships WHERE (a=? AND b=?) OR (a=? AND b=?)').get(uid, o.id, o.id, uid);
    if (ex) {
      if (ex.status === 'accepted') throw fail(409, `You are already friends with ${o.name}`);
      if (ex.a === uid) throw fail(409, `You already sent ${o.name} a request`);
      db.prepare(`UPDATE friendships SET status='accepted' WHERE id=?`).run(ex.id);
      notify(o.id, 'accepted', uid);
      return send(res, 200, { status: 'accepted', name: o.name });
    }
    db.prepare(`INSERT INTO friendships(a,b,status) VALUES(?,?, 'pending')`).run(uid, o.id);
    notify(o.id, 'request', uid);
    return send(res, 201, { status: 'pending', name: o.name });
  }
  if (route === 'POST /api/friends/respond') {
    const b = await readBody(req);
    const f = db.prepare(`SELECT * FROM friendships WHERE id=? AND b=? AND status='pending'`).get(int(b.friendshipId) || 0, uid);
    if (!f) throw fail(404, 'Request not found');
    if (b.accept) { db.prepare(`UPDATE friendships SET status='accepted' WHERE id=?`).run(f.id); notify(f.a, 'accepted', uid); }
    else db.prepare('DELETE FROM friendships WHERE id=?').run(f.id);
    db.prepare(`DELETE FROM notifications WHERE user=? AND kind='request' AND actor=?`).run(uid, f.a);
    return send(res, 200, { ok: true });
  }
  if (route === 'POST /api/friends/remove') {
    const b = await readBody(req);
    const fid = int(b.friendId) || 0;
    db.prepare('DELETE FROM friendships WHERE (a=? AND b=?) OR (a=? AND b=?)').run(uid, fid, fid, uid);
    db.prepare('DELETE FROM visibility WHERE (owner=? AND viewer=?) OR (owner=? AND viewer=?)').run(uid, fid, fid, uid);
    db.prepare('DELETE FROM notifications WHERE (user=? AND actor=?) OR (user=? AND actor=?)').run(uid, fid, fid, uid);
    return send(res, 200, { ok: true });
  }
  if (route === 'POST /api/visibility') {
    const b = await readBody(req);
    const fid = int(b.friendId) || 0;
    if (!['full', 'busy', 'hidden'].includes(b.level)) throw fail(400, 'Invalid level');
    if (!areFriends(uid, fid)) throw fail(404, 'Friend not found');
    db.prepare(`INSERT INTO visibility(owner,viewer,level) VALUES(?,?,?)
      ON CONFLICT(owner,viewer) DO UPDATE SET level=excluded.level`).run(uid, fid, b.level);
    return send(res, 200, { ok: true });
  }
  const m = url.pathname.match(/^\/api\/friends\/(\d+)\/schedule$/);
  if (req.method === 'GET' && m) {
    const fid = Number(m[1]);
    const level = levelFor(fid, uid);
    if (level === 'hidden') return send(res, 200, { name: userName(fid) || '', level, items: [] });
    const rows = db.prepare(`SELECT c.start, c.type, c.location FROM bookings b JOIN classes c ON c.id=b.class
      WHERE b.user=? AND b.private=0 AND c.start>=? ORDER BY c.start`).all(fid, nowLocal());
    const items = rows.map(r => level === 'full' ? r : { start: r.start });
    return send(res, 200, { name: userName(fid), level, items });
  }
  throw fail(404, 'Not found');
}

// ---------- server ----------
const ICON = Buffer.from('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', 'base64');
const PUBLIC = path.join(__dirname, 'public');
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method !== 'GET') throw fail(405, 'Method not allowed');
    // The Home Screen icon and install manifest live in the code, so the app is just a handful of files.
    if (url.pathname === '/icon.png') { res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' }); return res.end(ICON); }
    if (url.pathname === '/manifest.webmanifest') {
      res.writeHead(200, { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-cache' });
      return res.end(JSON.stringify({ name: 'Duo Flow', short_name: 'Duo Flow', start_url: '/', display: 'standalone', background_color: '#ffffff', theme_color: '#ffffff', icons: [{ src: '/icon.png', sizes: '180x180', type: 'image/png' }] }));
    }
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file = path.normalize(path.join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC + path.sep)) throw fail(404, 'Not found');
    const body = fs.readFileSync(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'EISDIR') return send(res, 404, { error: 'Not found' });
    if (typeof e.code === 'number') return send(res, e.code, { error: e.message });
    console.error(e);
    send(res, 500, { error: 'Something went wrong. Try again.' });
  }
});
server.listen(PORT, () => console.log(`Duo Flow running at http://localhost:${server.address().port}`));
module.exports = { server, db, hashPw, addDays, todayStr, outbox };
