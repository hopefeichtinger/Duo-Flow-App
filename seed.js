'use strict';
// Adds demo members so you can try StudioSocial on your own. Run: node seed.js
// Sign in as demo@example.com / password123 (friends: maya, jordan, priya, sam @example.com, same password).
process.env.PORT = process.env.PORT || '0'; // don't clash with a running server
const { server, db, hashPw } = require('./server');

const people = [
  ['Demo', 'demo@example.com'], ['Maya', 'maya@example.com'], ['Jordan', 'jordan@example.com'],
  ['Priya', 'priya@example.com'], ['Sam', 'sam@example.com']
];
const ids = {};
for (const [name, email] of people) {
  const ex = db.prepare('SELECT id FROM users WHERE email=?').get(email);
  ids[name] = ex ? ex.id : Number(db.prepare('INSERT INTO users(name,email,pw) VALUES(?,?,?)').run(name, email, hashPw('password123')).lastInsertRowid);
}
const share = { Maya: 'full', Jordan: 'busy', Priya: 'full', Sam: 'hidden' };
for (const [friend, level] of Object.entries(share)) {
  db.prepare(`INSERT OR IGNORE INTO friendships(a,b,status) VALUES(?,?, 'accepted')`).run(ids[friend], ids.Demo);
  db.prepare(`INSERT INTO visibility(owner,viewer,level) VALUES(?,?,?) ON CONFLICT(owner,viewer) DO UPDATE SET level=excluded.level`).run(ids[friend], ids.Demo, level);
}
// Friends book a few upcoming classes (every 3rd class, so there is something to join).
const upcoming = db.prepare(`SELECT id FROM classes WHERE start > ? ORDER BY start LIMIT 60`).all(new Date().toLocaleString('sv-SE', { timeZone: 'America/Chicago' }).slice(0, 16).replace(' ', 'T'));
const mod = { Maya: 0, Jordan: 1, Priya: 2, Sam: 0 };
upcoming.forEach((c, i) => {
  for (const [name, m] of Object.entries(mod)) if (i % 5 === m) db.prepare('INSERT OR IGNORE INTO bookings(user,class) VALUES(?,?)').run(ids[name], c.id);
});
console.log('Seeded. Sign in as demo@example.com / password123');
server.close(); db.close();
