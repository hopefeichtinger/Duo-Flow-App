'use strict';
// StudioSocial server: zero dependencies. Needs Node 22.13+ (built-in node:sqlite).
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
  // Version 0.4: which studios a member belongs to (comma list). NULL means they haven't chosen yet.
  if (!cols.includes('studios')) db.exec('ALTER TABLE users ADD COLUMN studios TEXT');
  if (!db.prepare('PRAGMA table_info(classes)').all().some(c => c.name === 'studio'))
    db.exec("ALTER TABLE classes ADD COLUMN studio TEXT NOT NULL DEFAULT 'corepower'");
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
const MAIL_FROM = process.env.MAIL_FROM || 'StudioSocial <onboarding@resend.dev>';
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
  return sendMail(u.email, 'Confirm your email for StudioSocial',
    `Hi ${u.name},\n\nConfirm your email to start adding friends on StudioSocial:\n\n${baseUrl()}/#verify=${raw}\n\nThis link works for 24 hours. If you didn't create an account, you can ignore this email.\n`);
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
// Each studio has its own locations. Location names are unique across studios, so a location identifies its studio.
const STUDIOS = {
  corepower: { name: 'CorePower', types: ['Yoga Sculpt', 'CorePower StrengthX', 'CorePower1', 'CorePower 2'], locs: ['Lakeview', 'Lincoln Park', 'Old Town'], times: ['06:00', '12:00', '18:00'] },
  solid: { name: 'Solid Core', types: ['Full Body 50', 'Core and Legs 50', 'Upper Body 50', 'Express 30'], locs: ['West Loop', 'Gold Coast', 'River North'], times: ['06:30', '12:15', '18:30'] },
  barre: { name: 'Pure Barre', types: ['Barre Classic', 'Barre Sculpt', 'Barre Burn', 'Barre Stretch'], locs: ['Hyde Park', 'Bucktown', 'Andersonville'], times: ['07:00', '09:30', '17:30'] }
};
const STUDIO_IDS = Object.keys(STUDIOS);
// Approximate neighborhood centers, used only to show a member their nearest location.
const COORDS = { 'Lakeview': [41.940, -87.650], 'Lincoln Park': [41.924, -87.650], 'Old Town': [41.910, -87.637],
  'West Loop': [41.882, -87.648], 'Gold Coast': [41.905, -87.628], 'River North': [41.892, -87.634],
  'Hyde Park': [41.794, -87.590], 'Bucktown': [41.917, -87.680], 'Andersonville': [41.980, -87.668] };
const LOCS = STUDIO_IDS.flatMap(id => STUDIOS[id].locs);
const studioOfLocation = loc => { const l = String(loc || '').toLowerCase(); return STUDIO_IDS.find(id => STUDIOS[id].locs.some(x => l.includes(x.toLowerCase()))) || null; };
const parseStudios = v => (v ? String(v).split(',').filter(x => STUDIO_IDS.includes(x)) : null);
function ensureClasses() {
  const ins = db.prepare(`INSERT INTO classes(type,location,start,capacity,studio)
    SELECT ?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM classes WHERE location=? AND start=? AND created_by IS NULL)`);
  const t = todayStr();
  for (let d = 0; d < 14; d++) {
    const day = addDays(t, d);
    for (const id of STUDIO_IDS) {
      const st = STUDIOS[id];
      st.times.forEach((tm, j) => st.locs.forEach((loc, k) => {
        const start = `${day}T${tm}`;
        ins.run(st.types[(d + j + k) % 4], loc, start, 12 + ((d * 7 + j * 5 + k * 3) % 13), id, loc, start);
      }));
    }
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

function classesFor(uid, from, to, studio) {
  const fids = friendIds(uid);
  const cls = db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM bookings WHERE class=c.id) AS booked
    FROM classes c WHERE substr(c.start,1,10) BETWEEN ? AND ? ORDER BY c.start, c.location`).all(from, to)
    .filter(c => canSee(c, uid, fids) && (!studio || c.studio === studio));
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
      id: c.id, type: c.type, location: c.location, start: c.start, studio: c.studio,
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
const LIKELY = /corepower|solid|yoga|sculpt|pilates|barre|strengthx|hiit|cycle|spin|class/i;
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
      sendMail(email, 'Reset your StudioSocial password',
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
    const u = db.prepare('SELECT id,name,email,hide_all,verified,studios FROM users WHERE id=?').get(uid);
    u.studios = parseStudios(u.studios);
    const catalog = STUDIO_IDS.map(id => ({ id, name: STUDIOS[id].name, locations: STUDIOS[id].locs, coords: Object.fromEntries(STUDIOS[id].locs.map(l => [l, COORDS[l]])) }));
    return send(res, 200, { user: u, today: todayStr(), requireVerify: REQUIRE_VERIFY, studios: catalog });
  }
  if (route === 'POST /api/studios') {
    const b = await readBody(req);
    const list = Array.isArray(b.studios) ? [...new Set(b.studios)] : [];
    if (!list.length || list.length > STUDIO_IDS.length || !list.every(x => STUDIO_IDS.includes(x))) throw fail(400, 'Choose at least one studio');
    const ordered = STUDIO_IDS.filter(x => list.includes(x));
    db.prepare('UPDATE users SET studios=? WHERE id=?').run(ordered.join(','), uid);
    return send(res, 200, { studios: ordered });
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
    const studio = q.get('studio');
    if (studio && !STUDIO_IDS.includes(studio)) throw fail(400, 'Unknown studio');
    return send(res, 200, { classes: classesFor(uid, day, day, studio) });
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
        else {
          const mine = parseStudios(db.prepare('SELECT studios FROM users WHERE id=?').get(uid).studios);
          const text = (c.type + ' ' + c.location).toLowerCase();
          const studio = studioOfLocation(c.location) || (/solid/.test(text) ? 'solid' : /barre/.test(text) ? 'barre' : /corepower/.test(text) ? 'corepower' : (mine && mine[0]) || 'corepower');
          cid = Number(db.prepare('INSERT INTO classes(type,location,start,capacity,created_by,studio) VALUES(?,?,?,30,?,?)').run(c.type, c.location, c.start, uid, studio).lastInsertRowid); created = true;
        }
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
      return res.end(JSON.stringify({ name: 'StudioSocial', short_name: 'StudioSocial', start_url: '/', display: 'standalone', background_color: '#ffffff', theme_color: '#ffffff', icons: [{ src: '/icon.png', sizes: '180x180', type: 'image/png' }] }));
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
server.listen(PORT, () => console.log(`StudioSocial running at http://localhost:${server.address().port}`));
module.exports = { server, db, hashPw, addDays, todayStr, outbox };
