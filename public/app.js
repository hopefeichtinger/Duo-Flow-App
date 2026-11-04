(function () {
  'use strict';
  const root = document.getElementById('root');
  const nav = document.getElementById('nav');
  let token = '';
  try { token = localStorage.getItem('df_token') || ''; } catch (e) {}
  const S = { tab: 'home', day: null, today: null, user: null, notes: { items: [], unread: 0 }, reset: null, linkNote: null, requireVerify: false, studios: [], studio: null, editStudios: false, loc: null, locMsg: '', locSel: null, locOpen: false };
  const DOTS = { corepower: '#f47c16', solid: '#2f55d4', barre: '#e02020' };
  const studioName = id => (S.studios.find(x => x.id === id) || {}).name || id;

  // Location stays on this phone. It is never sent to the server; it only picks which location to show first.
  const miles = (a, b) => { const r = x => x * Math.PI / 180, dl = r(b[0] - a[0]), dn = r(b[1] - a[1]); const q = Math.sin(dl / 2) ** 2 + Math.cos(r(a[0])) * Math.cos(r(b[0])) * Math.sin(dn / 2) ** 2; return 3959 * 2 * Math.asin(Math.sqrt(q)); };
  function nearest() {
    const st = S.studios.find(x => x.id === S.studio);
    if (!S.loc || !st) return null;
    let best = null;
    for (const l of st.locations) { const d = miles(S.loc, st.coords[l]); if (!best || d < best.d) best = { name: l, d }; }
    return best;
  }
  function ranked() {
    const st = S.studios.find(x => x.id === S.studio);
    if (!S.loc || !st) return [];
    return st.locations.map(l => ({ name: l, d: miles(S.loc, st.coords[l]) })).sort((a, b) => a.d - b.d);
  }
  const fmtMi = d => (d < 10 ? d.toFixed(1) : Math.round(d)) + ' mi';
  function shareLoc(quiet) {
    if (!navigator.geolocation) { if (!quiet) { S.locMsg = 'This browser can’t share location.'; render(); } return; }
    if (!quiet) { S.locMsg = 'Asking for your location…'; render(); }
    navigator.geolocation.getCurrentPosition(p => {
      S.loc = [p.coords.latitude, p.coords.longitude]; S.locMsg = '';
      try { localStorage.setItem('df_loc', '1'); } catch (e) {}
      if (!quiet) toast('Location on. Showing your nearest location first.');
      render();
    }, () => { S.locMsg = quiet ? '' : 'Location is off for this page. Allow it in your browser or phone settings and try again.'; if (!quiet) render(); }, { timeout: 10000, maximumAge: 600000 });
  }
  function locOff() { S.loc = null; S.locSel = null; S.locOpen = false; S.locMsg = ''; try { localStorage.removeItem('df_loc'); } catch (e) {} render(); }
  try { if (localStorage.getItem('df_loc') === '1') shareLoc(true); } catch (e) {}

  const svgIcon = (d, rot) => { const ns = 'http://www.w3.org/2000/svg', v = document.createElementNS(ns, 'svg'); v.setAttribute('viewBox', '0 0 16 16'); v.setAttribute('width', '14'); v.setAttribute('height', '14'); v.setAttribute('aria-hidden', 'true');
    v.setAttribute('style', 'fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;transform:rotate(' + (rot || 0) + 'deg)'); const q = document.createElementNS(ns, 'path'); q.setAttribute('d', d); v.appendChild(q); return v; };
  const chevron = open => svgIcon('M3.5 6 8 10.5 12.5 6', open ? 180 : 0);
  const check = () => svgIcon('M3 8.5 6.5 12 13 4.5');

  // The app mark: a ring of friends around one center, the same picture as the Home Screen icon.
  function ringMark() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 200 200'); svg.setAttribute('class', 'mark'); svg.setAttribute('aria-hidden', 'true');
    const dot = (cx, cy, r, c) => { const x = document.createElementNS(ns, 'circle'); x.setAttribute('cx', cx.toFixed(1)); x.setAttribute('cy', cy.toFixed(1)); x.setAttribute('r', r); x.setAttribute('class', c); svg.appendChild(x); };
    for (let i = 0; i < 8; i++) { const a = (i * 45 - 90) * Math.PI / 180; dot(100 + 62 * Math.cos(a), 100 + 62 * Math.sin(a), 21, i % 2 ? 'b' : 'a'); }
    dot(100, 100, 25, 'c');
    return svg;
  }
  document.getElementById('markslot').appendChild(ringMark());

  // Pink until a member has chosen studios, then the colors of the studio they are looking at.
  function applyTheme() {
    const id = S.user && S.user.studios && S.user.studios.length ? S.studio : '';
    if (id) document.documentElement.dataset.studio = id; else delete document.documentElement.dataset.studio;
    const m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute('content', ({ corepower: '#fffaf0', solid: '#f6f8ff', barre: '#fff7f7' })[id] || '#fff0f5');
  }
  const brand = document.getElementById('brand'), chip = document.getElementById('chip'), menu = document.getElementById('menu');
  function closeMenu() { menu.hidden = true; brand.setAttribute('aria-expanded', 'false'); }
  function paintBrand() {
    const mine = S.user && S.user.studios ? S.user.studios : [];
    const many = mine.length > 1;
    chip.hidden = !mine.length;
    fill(chip, mine.length ? studioName(S.studio) : null, many ? (() => { const n = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); n.setAttribute('viewBox', '0 0 24 24'); n.setAttribute('aria-hidden', 'true'); const pth = document.createElementNS('http://www.w3.org/2000/svg', 'path'); pth.setAttribute('d', 'M6 9l6 6 6-6'); n.appendChild(pth); return n; })() : null);
    brand.classList.toggle('pick', many);
    if (many) brand.setAttribute('aria-label', 'Studio: ' + studioName(S.studio) + '. Switch studio'); else brand.removeAttribute('aria-label');
    fill(menu, mine.map(id => el('button', { role: 'menuitem', class: id === S.studio ? 'on' : '', onclick: () => { closeMenu(); setStudio(id); } },
      el('span', { class: 'dot', style: 'background:' + DOTS[id] }), studioName(id))));
    if (!many) closeMenu();
  }
  function setStudio(id) {
    S.studio = id; S.tab = 'home'; S.locSel = null; S.locOpen = false;
    try { localStorage.setItem('df_studio', id); } catch (e) {}
    render(); window.scrollTo(0, 0);
  }
  brand.addEventListener('click', () => {
    if (!(S.user && S.user.studios && S.user.studios.length > 1)) return;
    const open = menu.hidden; menu.hidden = !open; brand.setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('click', ev => { if (!menu.hidden && !menu.contains(ev.target) && !brand.contains(ev.target)) closeMenu(); });
  document.addEventListener('keydown', ev => { if (ev.key === 'Escape') closeMenu(); });

  // Safe DOM builder: text is always inserted as text, never as HTML.
  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return e;
  }

  // Replaces a node's children. Skips empty slots and flattens lists, so `cond ? el(...) : null` never prints "null".
  function fill(parent, ...kids) {
    parent.replaceChildren(...kids.flat(Infinity).filter(k => k != null && k !== false).map(k => k.nodeType ? k : document.createTextNode(String(k))));
  }

  async function api(path, method, body) {
    const res = await fetch('/api' + path, {
      method: method || 'GET',
      headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
      body: body ? JSON.stringify(body) : undefined
    });
    let data = {};
    try { data = await res.json(); } catch (e) {}
    if (res.status === 401 && token) { signOut(); throw new Error(data.error || 'Sign in to continue'); }
    if (!res.ok) throw new Error(data.error || 'Something went wrong. Try again.');
    return data;
  }

  let toastTimer;
  function toast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
  }
  const guard = fn => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message); } };

  // ---------- helpers ----------
  const COLORS = ['#e8567a', '#2b8fd9', '#d98a1f', '#7a5ac8', '#4a9d6b', '#d9534f', '#2a9d8f'];
  const av = u => el('span', { class: 'av', style: 'background:' + COLORS[u.id % COLORS.length], 'aria-hidden': 'true' }, (u.name || '?')[0].toUpperCase());
  const addDays = (s, n) => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
  const dateOf = s => { const [y, m, d] = s.slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d); };
  const wk = (s, long) => dateOf(s).toLocaleDateString('en-US', { weekday: long ? 'long' : 'short' });
  const md = s => dateOf(s).toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
  const clock = s => { let [h, m] = s.slice(11, 16).split(':').map(Number); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12; return h + ':' + String(m).padStart(2, '0') + ' ' + ap; };
  const names = a => a.map(x => x.name).join(a.length > 2 ? ', ' : ' & ');
  const LEVELS = { full: 'Full schedule', busy: 'Busy only', hidden: 'Hidden' };
  const ICONS = {
    home: '<path d="M4 11.5 12 5l8 6.5V19a1 1 0 0 1-1 1h-4v-5h-6v5H5a1 1 0 0 1-1-1z"/>',
    friends: '<circle cx="9" cy="12" r="5"/><circle cx="15" cy="12" r="5"/>',
    me: '<circle cx="12" cy="8.5" r="3.5"/><path d="M5 19.5c1-3.5 4-5 7-5s6 1.5 7 5"/>',
    privacy: '<path d="M12 3.5 5 6v5.5c0 4.2 3 7.2 7 9 4-1.8 7-4.8 7-9V6z"/>'
  };
  const TABS = [['home', 'Home'], ['friends', 'Friends'], ['me', 'Me'], ['privacy', 'Privacy']];

  function signOut() {
    token = ''; S.user = null; S.studio = null; S.editStudios = false; S.loc = null; S.locMsg = ''; S.notes = { items: [], unread: 0 };
    try { localStorage.removeItem('df_token'); } catch (e) {}
    render();
  }

  // ---------- auth ----------
  function authView(mode, note) {
    const signup = mode === 'signup';
    const msg = el('p', { class: 'err', role: 'alert' });
    const name = el('input', { id: 'f-name', autocomplete: 'name', maxlength: '60' });
    const email = el('input', { id: 'f-email', type: 'email', autocomplete: 'email', inputmode: 'email' });
    const pw = el('input', { id: 'f-pw', type: 'password', autocomplete: signup ? 'new-password' : 'current-password' });
    const submit = guard(async ev => {
      ev.preventDefault(); msg.textContent = '';
      try {
        const r = await api(signup ? '/signup' : '/login', 'POST', { name: name.value, email: email.value, password: pw.value });
        token = r.token;
        try { localStorage.setItem('df_token', token); } catch (e) {}
        S.tab = 'home'; S.day = null;
        await render();
      } catch (e) { msg.textContent = e.message; }
    });
    return el('form', { class: 'auth', onsubmit: submit },
      el('div', { class: 'hero' }, ringMark(), el('p', { class: 'mute' }, 'Take class with your friends.')),
      note ? el('div', { class: 'banner', role: 'status' }, note) : null,
      el('h2', {}, signup ? 'Create your account' : 'Sign in'),
      el('p', { class: 'mute' }, 'See which classes your friends are taking and book together.'),
      signup && el('label', { for: 'f-name' }, 'Name'), signup && name,
      el('label', { for: 'f-email' }, 'Email'), email,
      el('label', { for: 'f-pw' }, signup ? 'Password (8 or more characters)' : 'Password'), pw,
      msg,
      el('button', { class: 'btn', type: 'submit', style: 'width:100%' }, signup ? 'Create account' : 'Sign in'),
      signup ? null : el('p', { style: 'text-align:center;margin-top:12px' },
        el('button', { class: 'link', type: 'button', onclick: () => { fill(root, forgotView()); } }, 'Forgot password?')),
      el('p', { style: 'text-align:center;margin-top:12px' },
        el('button', { class: 'link', type: 'button', onclick: () => { fill(root, authView(signup ? 'login' : 'signup')); } },
          signup ? 'Have an account? Sign in' : 'New here? Create an account')));
  }

  // Choose which studios the member belongs to (1, 2 or 3). Used at sign-up and again from the Me tab.
  function studiosView(first) {
    const mine = new Set((S.user.studios || []));
    const msg = el('p', { class: 'err', role: 'alert' });
    const btn = el('button', { class: 'btn', type: 'submit', style: 'width:100%' });
    const boxes = new Map();
    const upd = () => { const n = [...boxes.values()].filter(b => b.checked).length; btn.disabled = !n; btn.textContent = first ? (n ? 'Continue' : 'Choose a studio') : 'Save studios'; };
    const rows = S.studios.map(st => {
      const cb = el('input', { type: 'checkbox', id: 'st-' + st.id, checked: mine.has(st.id), onchange: () => { row.classList.toggle('on', cb.checked); upd(); } });
      boxes.set(st.id, cb);
      const row = el('label', { class: 'studio' + (mine.has(st.id) ? ' on' : ''), for: 'st-' + st.id },
        cb, el('span', { class: 'dot', style: 'background:' + DOTS[st.id] }),
        el('span', { class: 'grow' }, el('b', {}, st.name), el('br'), el('span', { class: 'mute' }, st.locations.join(' · '))));
      return row;
    });
    const form = el('form', { class: first ? 'auth' : '', onsubmit: guard(async ev => {
      ev.preventDefault(); msg.textContent = '';
      try {
        const r = await api('/studios', 'POST', { studios: S.studios.map(x => x.id).filter(id => boxes.get(id).checked) });
        S.user.studios = r.studios; S.editStudios = false;
        if (!S.studio || !r.studios.includes(S.studio)) S.studio = r.studios[0];
        try { localStorage.setItem('df_studio', S.studio); } catch (e) {}
        S.tab = first ? 'home' : 'me';
        toast(first ? 'You’re all set' : 'Studios saved');
        await render();
      } catch (e) { msg.textContent = e.message; }
    }) },
      first ? el('div', { class: 'hero' }, ringMark()) : null,
      el('h2', {}, first ? 'Which studios do you go to?' : 'My studios'),
      el('p', { class: 'mute', style: 'margin-bottom:12px' }, first
        ? 'Pick every studio you have a membership with, one, two or all three. Each one gets its own home page, and you can change this later.'
        : 'Each studio gets its own home page. Switch between them from the top of the screen.'),
      rows, msg, btn,
      first ? null : el('p', { style: 'text-align:center;margin-top:8px' }, el('button', { class: 'link', type: 'button', onclick: () => { S.editStudios = false; render(); } }, 'Cancel')));
    upd();
    return form;
  }

  function forgotView() {
    const msg = el('p', { class: 'err', role: 'alert' });
    const email = el('input', { id: 'fp-email', type: 'email', autocomplete: 'email', inputmode: 'email' });
    const back = el('button', { class: 'link', type: 'button', onclick: () => { fill(root, authView('login')); } }, 'Back to sign in');
    const form = el('form', { onsubmit: guard(async ev => {
      ev.preventDefault(); msg.textContent = '';
      try {
        await api('/password/forgot', 'POST', { email: email.value });
        fill(root, el('div', {}, el('h2', {}, 'Check your email'),
          el('p', {}, 'If that address has an account, we sent a link to choose a new password. It works for 1 hour. Check spam if you don’t see it.'),
          el('p', { style: 'margin-top:12px' }, back)));
      } catch (e) { msg.textContent = e.message; }
    }) },
      el('h2', {}, 'Reset your password'),
      el('p', { class: 'mute' }, 'Enter your email and we’ll send you a link.'),
      el('label', { for: 'fp-email' }, 'Email'), email, msg,
      el('button', { class: 'btn', type: 'submit', style: 'width:100%' }, 'Send reset link'),
      el('p', { style: 'text-align:center;margin-top:12px' }, back));
    return form;
  }
  function resetView() {
    const msg = el('p', { class: 'err', role: 'alert' });
    const pw = el('input', { id: 'rp-pw', type: 'password', autocomplete: 'new-password' });
    const leave = () => { S.reset = null; render(); };
    return el('form', { onsubmit: guard(async ev => {
      ev.preventDefault(); msg.textContent = '';
      try {
        await api('/password/reset', 'POST', { token: S.reset, password: pw.value });
        S.reset = null; token = ''; S.user = null;
        try { localStorage.removeItem('df_token'); } catch (e) {}
        S.linkNote = 'Password changed. Sign in with your new password.';
        await render();
      } catch (e) { msg.textContent = e.message; }
    }) },
      el('h2', {}, 'Choose a new password'),
      el('p', { class: 'mute' }, 'You’ll be signed out of any other devices.'),
      el('label', { for: 'rp-pw' }, 'New password (8 or more characters)'), pw, msg,
      el('button', { class: 'btn', type: 'submit', style: 'width:100%' }, 'Change password'),
      el('p', { style: 'text-align:center;margin-top:12px' }, el('button', { class: 'link', type: 'button', onclick: leave }, 'Back to sign in')));
  }

  // ---------- Notifications ----------
  const ago = iso => {
    const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
    if (m < 1) return 'Just now'; if (m < 60) return m + ' min ago';
    if (m < 1440) return Math.round(m / 60) + ' hr ago';
    return Math.round(m / 1440) + ' day' + (Math.round(m / 1440) > 1 ? 's' : '') + ' ago';
  };
  const bell = document.getElementById('bell');
  bell.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 1.5h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/></svg><b hidden></b>';
  bell.addEventListener('click', () => { S.tab = 'alerts'; render(); window.scrollTo(0, 0); });
  function setBadge(n) {
    const b = bell.querySelector('b');
    b.hidden = !n; b.textContent = n > 9 ? '9+' : String(n);
    bell.setAttribute('aria-label', n ? 'Notifications, ' + n + ' unread' : 'Notifications');
  }
  function alertsView() {
    const items = S.notes.items;
    const line = n => n.kind === 'request' ? n.actor.name + ' sent you a friend request'
      : n.kind === 'accepted' ? n.actor.name + ' accepted your friend request'
      : n.actor.name + ' booked ' + n.cls.type + ' with you';
    const sub = n => n.kind === 'joined' ? wk(n.cls.start) + ', ' + md(n.cls.start) + ' · ' + clock(n.cls.start) + ' · ' + n.cls.location : ago(n.created);
    const go = n => () => {
      if (n.kind === 'request') S.tab = 'friends';
      else if (n.kind === 'accepted') S.tab = 'privacy';
      else { S.tab = 'home'; S.day = n.cls.start.slice(0, 10); }
      render(); window.scrollTo(0, 0);
    };
    const label = n => n.kind === 'request' ? 'Review' : n.kind === 'accepted' ? 'Choose what they see' : 'View class';
    return el('div', {},
      el('h2', {}, 'Notifications'),
      items.length ? items.map(n => el('div', { class: 'card' + (n.read ? '' : ' unread') },
        el('div', { class: 'row' }, av(n.actor), el('div', { class: 'grow' }, el('b', {}, line(n)), el('br'), el('span', { class: 'mute' }, sub(n)))),
        el('div', { style: 'margin-top:10px' }, el('button', { class: 'btn alt', onclick: go(n) }, label(n)))))
        : el('div', { class: 'card mute' }, 'Nothing yet. You’ll see friend requests, accepted requests, and friends who book a class you’re in.'));
  }
  async function refreshBadge() {
    if (!token || S.tab === 'alerts') return;
    try { const n = await api('/notifications'); S.notes = n; setBadge(n.unread); } catch (e) {}
  }
  setInterval(() => { if (!document.hidden) refreshBadge(); }, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshBadge(); });

  function verifyBanner() {
    return el('div', { class: 'banner', role: 'status' },
      el('p', {}, 'Confirm your email (' + S.user.email + ') to add friends. We sent you a link.'),
      el('div', { class: 'row', style: 'gap:16px' },
        el('button', { class: 'link', type: 'button', onclick: guard(async () => { await api('/verify/resend', 'POST'); toast('Email sent. Check your inbox.'); }) }, 'Resend email'),
        el('button', { class: 'link', type: 'button', onclick: guard(async () => { S.user = null; await render(); }) }, 'I confirmed it')));
  }

  // ---------- Home ----------
  function classCard(c, reload) {
    const act = guard(async () => {
      if (c.booked) { await api('/cancel', 'POST', { classId: c.id }); toast('Cancelled ' + c.type); }
      else { await api('/book', 'POST', { classId: c.id }); toast('Booked ' + c.type + ', ' + wk(c.start) + ' ' + clock(c.start)); }
      await reload();
    });
    let label;
    if (c.booked) label = 'Cancel';
    else if (c.spotsLeft <= 0) label = 'Full';
    else label = c.going.length ? 'Book with ' + c.going[0].name + (c.going.length > 1 ? ' +' + (c.going.length - 1) : '') : 'Book';
    const nr = nearest();
    return el('div', { class: 'card cls' },
      el('div', { class: 'row' }, el('b', { class: 'grow' }, c.type), nr && nr.name === c.location ? el('span', { class: 'pill' }, 'Nearest') : null),
      el('span', { class: 'mute' }, c.location + ' · ' + c.spotsLeft + ' spots left'),
      c.going.length ? el('div', { class: 'row', style: 'margin-top:10px' },
        el('div', { class: 'avs' }, c.going.map(av)), el('span', { class: 'mute' }, names(c.going) + (c.going.length > 1 ? ' are going' : ' is going'))) : null,
      c.busy.length ? el('p', { class: 'mute', style: 'margin-top:6px' }, names(c.busy) + (c.busy.length > 1 ? ' are' : ' is') + ' booked at this time') : null,
      el('div', { class: 'row', style: 'margin-top:12px;justify-content:space-between' },
        el('span', { class: 'mute' }, c.booked ? (c.private ? 'Booked · private' : 'Booked') : ''),
        el('button', { class: 'btn' + (c.booked ? ' alt' : ''), disabled: !c.booked && c.spotsLeft <= 0, onclick: act }, label)));
  }
  async function homeView() {
    const box = el('div');
    const load = async () => {
      let { classes } = await api('/classes?date=' + S.day + '&studio=' + S.studio);
      if (S.locSel && S.loc) classes = classes.filter(c => c.location === S.locSel);
      const groups = new Map();
      classes.forEach(c => { if (!groups.has(c.start)) groups.set(c.start, []); groups.get(c.start).push(c); });
      const list = el('div');
      for (const [start, cs] of groups) list.append(el('div', { class: 'slot' }, el('div', { class: 'tm' }, clock(start)), el('div', { class: 'col' }, cs.map(c => classCard(c, load)))));
      fill(box, 
        S.user.hide_all ? el('div', { class: 'banner' }, 'Your schedule is hidden from everyone right now.') : null,
        el('div', { class: 'days', role: 'tablist', 'aria-label': 'Day' },
          Array.from({ length: 7 }, (_, i) => addDays(S.today, i)).map(d =>
            el('button', { class: 'day' + (d === S.day ? ' on' : ''), role: 'tab', 'aria-selected': String(d === S.day), onclick: guard(async () => { S.day = d; await load(); }) },
              el('span', {}, wk(d)), el('b', {}, Number(d.slice(8)))))),
        nearest() ? el('div', { class: 'row', style: 'gap:4px' },
            el('p', { class: 'mute' }, 'Nearest to you: ', el('b', {}, nearest().name), ' · ' + fmtMi(nearest().d)),
            el('button', { class: 'link', type: 'button', style: 'padding:4px 8px', 'aria-label': 'Other close locations', 'aria-expanded': String(S.locOpen), 'aria-controls': 'loclist',
              onclick: guard(async () => { S.locOpen = !S.locOpen; await load(); }) }, chevron(S.locOpen)))
          : el('p', { class: 'mute' }, el('button', { class: 'link', type: 'button', onclick: () => shareLoc(false) }, 'Show my nearest location')),
        nearest() && S.locOpen ? el('div', { class: 'card', id: 'loclist', style: 'padding:6px' },
          [{ name: null }].concat(ranked()).map(r => el('button', { class: 'locrow' + (S.locSel === r.name ? ' on' : ''), type: 'button',
            onclick: guard(async () => { S.locSel = r.name; S.locOpen = false; await load(); }) },
            el('span', { class: 'grow' }, r.name || 'All locations'), el('span', { class: 'mute' }, r.name ? fmtMi(r.d) : ''), S.locSel === r.name ? check() : null))) : null,
        S.locSel && nearest() ? el('p', { class: 'mute' }, 'Showing classes at ' + S.locSel + ' only.') : null,
        el('p', { class: 'mute' }, studioName(S.studio) + ' · ' + wk(S.day, true) + ', ' + md(S.day) + '. Friends who share their schedule show up on each class.'),
        classes.length ? list : el('div', { class: 'card mute' }, 'No classes on this day.'));
    };
    await load();
    return box;
  }

  // ---------- Friends ----------
  async function friendsView() {
    const box = el('div');
    const open = new Map();
    const load = async () => {
      const d = await api('/friends');
      const email = el('input', { type: 'email', placeholder: 'friend@email.com', 'aria-label': "Friend's email", autocomplete: 'off' });
      const add = guard(async ev => {
        ev.preventDefault();
        const r = await api('/friends/request', 'POST', { email: email.value });
        toast(r.status === 'accepted' ? 'You and ' + r.name + ' are now friends' : 'Request sent to ' + r.name);
        await load();
      });
      const friendCard = f => {
        const body = el('div', { style: 'margin-top:8px' });
        const show = guard(async () => {
          if (open.get(f.id)) { open.delete(f.id); fill(body, ); return; }
          open.set(f.id, true);
          const s = await api('/friends/' + f.id + '/schedule');
          fill(body, s.level === 'hidden' ? el('p', { class: 'mute' }, f.name + ' is not sharing their schedule with you.')
            : s.items.length ? s.items.map(i => el('div', { class: 'line' }, el('span', {}, wk(i.start) + ' ' + clock(i.start)), el('span', {}, i.type ? i.type + ' · ' + i.location : 'Busy')))
            : el('p', { class: 'mute' }, 'No upcoming classes.'));
        });
        return el('div', { class: 'card' },
          el('button', { class: 'row', style: 'all:unset;display:flex;gap:10px;align-items:center;width:100%;cursor:pointer', onclick: show },
            av(f), el('span', { class: 'grow' }, el('b', {}, f.name), el('br'), el('span', { class: 'mute' }, 'Shares with you: ' + LEVELS[f.sharesWithYou])), el('span', { class: 'mute' }, 'View')),
          body);
      };
      fill(box, 
        el('h2', {}, 'Add a friend'),
        el('form', { class: 'row', onsubmit: add }, el('div', { class: 'grow' }, email), el('button', { class: 'btn', type: 'submit' }, 'Send request')),
        d.incoming.length ? el('h2', {}, 'Requests') : null,
        d.incoming.map(r => el('div', { class: 'card' },
          el('div', { class: 'row' }, av(r.user), el('div', { class: 'grow' }, el('b', {}, r.user.name + ' wants to connect'))),
          el('p', { class: 'mute', style: 'margin:8px 0' }, 'Accepting shares nothing until you choose.'),
          el('div', { class: 'row' },
            el('button', { class: 'btn', onclick: guard(async () => { await api('/friends/respond', 'POST', { friendshipId: r.friendshipId, accept: true }); toast(r.user.name + ' added. They can’t see your schedule yet.'); await load(); }) }, 'Accept'),
            el('button', { class: 'btn alt', onclick: guard(async () => { await api('/friends/respond', 'POST', { friendshipId: r.friendshipId, accept: false }); await load(); }) }, 'Decline')))),
        d.outgoing.map(r => el('p', { class: 'mute' }, 'Waiting for ' + r.user.name + ' to accept.')),
        el('h2', {}, 'Friends'),
        d.friends.length ? d.friends.map(friendCard) : el('div', { class: 'card mute' }, 'No friends yet. Add one by email above.'));
    };
    await load();
    return box;
  }

  // ---------- Me ----------
  async function meView() {
    const { classes } = await api('/bookings');
    if (S.editStudios) return studiosView(false);
    return el('div', {},
      el('div', { class: 'card row' },
        el('div', { class: 'grow' }, el('b', {}, 'My studios'), el('br'), el('span', { class: 'mute' }, (S.user.studios || []).map(studioName).join(' · '))),
        el('button', { class: 'btn alt', onclick: () => { S.editStudios = true; render(); } }, 'Edit')),
      el('div', { class: 'card row' },
        el('div', { class: 'grow' }, el('b', {}, 'Nearest location'), el('p', { class: 'mute' }, S.loc ? 'On. Your location stays on this phone and is never shared with friends.' : 'Show the studio location closest to you first. Your location stays on this phone.'), S.locMsg ? el('p', { class: 'mute', role: 'status' }, S.locMsg) : null),
        S.loc ? el('button', { class: 'btn alt', onclick: locOff }, 'Turn off') : el('button', { class: 'btn', onclick: () => shareLoc(false) }, 'Turn on')),
      el('h2', {}, 'My schedule'),
      el('p', { class: 'mute' }, classes.length ? classes.length + (classes.length > 1 ? ' upcoming classes' : ' upcoming class') : ''),
      classes.length ? classes.map(c => el('div', { class: 'card cls' },
        el('div', { class: 'row' },
          el('div', { class: 'grow' }, el('b', {}, wk(c.start) + ', ' + md(c.start) + ' · ' + clock(c.start)), el('span', { class: 'mute' }, c.location)),
          el('span', { class: 'pill' }, c.type)),
        c.going.length ? el('div', { class: 'row', style: 'margin-top:10px' }, el('div', { class: 'avs' }, c.going.map(av)), el('span', { class: 'mute' }, 'With ' + names(c.going))) : null,
        c.private ? el('p', { class: 'mute', style: 'margin-top:8px' }, 'Private. Friends can’t see this class.') : null))
        : el('div', { class: 'card mute' }, 'No upcoming classes. Book one from Home.'),
      S.importNote ? el('div', { class: 'banner' }, S.importNote.map(t => el('p', {}, t))) : null,
      importCard());
  }

  // Add classes by hand, or import them from a calendar (.ics) or CSV file. Nothing is added until the member confirms.
  const validStart = s => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s || '');
  function importCard() {
    S.importNote = null;
    const msg = el('p', { class: 'err', role: 'alert' });
    const out = el('div');
    const commit = async rows => {
      const r = await api('/import/commit', 'POST', { rows });
      const note = ['Added ' + r.booked + (r.booked === 1 ? ' class.' : ' classes.')];
      r.skipped.forEach(s => note.push('Skipped ' + (s.type || 'a class') + (validStart(s.start) ? ' on ' + wk(s.start) + ' ' + md(s.start) + ' at ' + clock(s.start) : '') + ': ' + s.reason + '.'));
      S.importNote = note; toast(note[0]);
      await render();
    };

    // Manual add
    const f = {
      date: el('input', { type: 'date', required: true, id: 'm-date' }),
      time: el('input', { type: 'time', required: true, id: 'm-time' }),
      type: el('input', { id: 'm-type', maxlength: '60', placeholder: 'Yoga Sculpt', required: true }),
      loc: el('input', { id: 'm-loc', maxlength: '60', placeholder: 'Lincoln Park', list: 'studios', required: true })
    };
    const manual = el('form', { onsubmit: guard(async ev => {
      ev.preventDefault(); msg.textContent = '';
      try { await commit([{ type: f.type.value, location: f.loc.value, start: f.date.value + 'T' + f.time.value }]); } catch (e) { msg.textContent = e.message; }
    }) },
      el('label', { for: 'm-date' }, 'Date'), f.date, el('label', { for: 'm-time' }, 'Time'), f.time,
      el('label', { for: 'm-type' }, 'Class'), f.type, el('label', { for: 'm-loc' }, 'Studio location'), f.loc,
      el('datalist', { id: 'studios' }, S.studios.filter(st => (S.user.studios || []).includes(st.id)).flatMap(st => st.locations).map(v => el('option', { value: v }))),
      el('button', { class: 'btn', type: 'submit', style: 'margin-top:8px' }, 'Add class'));

    // File or pasted text
    const ta = el('textarea', { rows: '4', 'aria-label': 'Paste calendar or CSV text', placeholder: 'Or paste CSV text. Columns: date, time, class, location' });
    const file = el('input', { type: 'file', accept: '.ics,.csv,.txt,text/calendar,text/csv', 'aria-label': 'Choose a calendar or CSV file' });
    const preview = async () => {
      msg.textContent = ''; fill(out, );
      try { showPreview(await api('/import/preview', 'POST', { text: ta.value })); } catch (e) { msg.textContent = e.message; }
    };
    file.addEventListener('change', guard(async () => {
      const fl = file.files[0]; if (!fl) return;
      if (fl.size > 300000) { msg.textContent = 'That file is too large. The limit is 300 KB.'; return; }
      ta.value = await fl.text(); await preview();
    }));

    function showPreview(p) {
      const rows = p.rows, checks = rows.map(r => !r.error && !!r.likely);
      const btn = el('button', { class: 'btn', type: 'button', style: 'margin-top:8px' });
      const upd = () => { const n = checks.filter(Boolean).length; btn.textContent = n ? 'Add ' + n + (n === 1 ? ' class' : ' classes') : 'Choose classes to add'; btn.disabled = !n; };
      btn.addEventListener('click', guard(async () => {
        try { await commit(rows.filter((r, i) => checks[i]).map(r => ({ type: r.type, location: r.location, start: r.start }))); } catch (e) { msg.textContent = e.message; }
      }));
      fill(out, 
        p.errors.map(t => el('p', { class: 'mute' }, t)),
        p.truncated ? el('p', { class: 'mute' }, 'Only the first 300 rows are shown.') : null,
        rows.length ? el('p', { class: 'mute' }, 'Choose the classes to add. Anything that is not a class is left unchecked.') : el('p', { class: 'mute' }, 'No classes found in that file.'),
        rows.map((r, i) => {
          const cb = el('input', { type: 'checkbox', id: 'imp-' + i, checked: checks[i], disabled: !!r.error, style: 'width:auto;margin:3px 0 0', onchange: () => { checks[i] = cb.checked; upd(); } });
          const when = validStart(r.start) ? wk(r.start) + ' ' + md(r.start) + ' · ' + clock(r.start) + ' · ' : '';
          return el('div', { class: 'row', style: 'align-items:flex-start;padding:8px 0;border-top:1px solid var(--line)' }, cb,
            el('label', { for: 'imp-' + i, class: 'grow', style: 'color:var(--ink)' },
              el('b', { style: 'display:block' }, r.type || 'Class'),
              el('span', { class: 'mute' }, when + (r.location || 'No location')),
              r.error ? el('span', { class: 'mute', style: 'display:block;color:var(--bad)' }, 'Can’t add: ' + r.error) : null,
              r.matched ? el('span', { class: 'mute', style: 'display:block' }, 'On the studio schedule') : null,
              r.recurring ? el('span', { class: 'mute', style: 'display:block' }, 'Repeats: only the next one is added') : null));
        }),
        rows.length ? btn : null);
      upd();
    }

    return el('div', {},
      el('h2', {}, 'Add your classes'),
      el('p', { class: 'mute' }, 'Add a class you booked in the CorePower app, or import a calendar file (.ics) or CSV. You choose which ones to add.'),
      el('div', { class: 'card' }, el('b', {}, 'Add one class'), manual),
      el('div', { class: 'card' }, el('b', {}, 'Import from a file'), el('br'),
        el('span', { class: 'mute' }, 'Export from Google Calendar or Apple Calendar, or use a CSV with date, time, class, location.'),
        file, ta, el('button', { class: 'btn alt', type: 'button', style: 'margin-top:4px', onclick: guard(preview) }, 'Preview classes'),
        msg, out));
  }

  // ---------- Privacy ----------
  async function privacyView() {
    const box = el('div');
    const load = async () => {
      const [fr, bk] = await Promise.all([api('/friends'), api('/bookings')]);
      const sw = (on, label, fn) => el('button', { class: 'sw' + (on ? ' on' : ''), role: 'switch', 'aria-checked': String(!!on), 'aria-label': label, onclick: guard(fn) });
      fill(box, 
        el('h2', {}, 'Privacy'),
        el('div', { class: 'card row' },
          el('div', { class: 'grow' }, el('b', {}, 'Hide my schedule from everyone'), el('p', { class: 'mute' }, 'Overrides the settings below. Turn it off any time.')),
          sw(S.user.hide_all, 'Hide my schedule from everyone', async () => { const r = await api('/privacy', 'POST', { hide_all: !S.user.hide_all }); S.user.hide_all = r.hide_all; await load(); })),
        el('h2', {}, 'What each friend sees'),
        fr.friends.length ? fr.friends.map(f => el('div', { class: 'card', style: S.user.hide_all ? 'opacity:.55' : '' },
          el('div', { class: 'row' }, av(f), el('b', {}, f.name)),
          el('div', { class: 'seg' }, ['full', 'busy', 'hidden'].map(v =>
            el('button', { class: f.youShare === v ? 'on' : '', 'aria-pressed': String(f.youShare === v), onclick: guard(async () => { await api('/visibility', 'POST', { friendId: f.id, level: v }); toast(f.name + ' now sees: ' + LEVELS[v]); await load(); }) }, LEVELS[v])))))
          : el('div', { class: 'card mute' }, 'Add a friend to choose what they can see.'),
        el('h2', {}, 'Private classes'),
        el('p', { class: 'mute' }, 'Private classes never show to friends, even with Full schedule.'),
        bk.classes.length ? bk.classes.map(c => el('div', { class: 'card row' },
          el('div', { class: 'grow' }, el('b', {}, c.type), el('span', { class: 'mute' }, wk(c.start) + ' ' + clock(c.start) + ' · ' + c.location)),
          sw(c.private, 'Make ' + c.type + ' on ' + wk(c.start) + ' private', async () => { await api('/booking/private', 'POST', { classId: c.id, private: !c.private }); await load(); })))
          : el('div', { class: 'card mute' }, 'Book a class to make it private.'),
        el('p', { style: 'text-align:center;margin-top:24px' }, el('button', { class: 'link', onclick: signOut }, 'Sign out of ' + S.user.name)));
    };
    await load();
    return box;
  }

  // ---------- shell ----------
  async function render() {
    const note = S.linkNote; S.linkNote = null;
    bell.hidden = !token || !!S.reset;
    closeMenu();
    if (S.reset) { nav.hidden = true; applyTheme(); paintBrand(); fill(root, resetView()); return; }
    if (!token) { nav.hidden = true; bell.hidden = true; applyTheme(); paintBrand(); fill(root, authView('login', note)); return; }
    try {
      if (!S.user) { const me = await api('/me'); S.user = me.user; S.today = me.today; S.requireVerify = me.requireVerify; S.studios = me.studios; }
      if (!S.day) S.day = S.today;
      const mine = S.user.studios;
      if (mine && mine.length) {
        if (!S.studio || !mine.includes(S.studio)) { let saved = ''; try { saved = localStorage.getItem('df_studio') || ''; } catch (e) {} S.studio = mine.includes(saved) ? saved : mine[0]; }
      }
      applyTheme(); paintBrand();
      if (!mine || !mine.length) {
        nav.hidden = true; bell.hidden = true;
        fill(root, note ? el('div', { class: 'banner', role: 'status' }, note) : null, S.requireVerify && !S.user.verified ? verifyBanner() : null, studiosView(true));
        return;
      }
      try { S.notes = await api('/notifications'); } catch (e) { if (!token) return; }
      const views = { home: homeView, friends: friendsView, me: meView, privacy: privacyView, alerts: async () => alertsView() };
      const body = await views[S.tab]();
      fill(root, note ? el('div', { class: 'banner', role: 'status' }, note) : null, S.requireVerify && !S.user.verified ? verifyBanner() : null, body);
      setBadge(S.tab === 'alerts' ? 0 : S.notes.unread);
      if (S.tab === 'alerts' && S.notes.unread) api('/notifications/read', 'POST', { all: true }).catch(() => {});
      const tabs = document.getElementById('tabs');
      fill(tabs, ...TABS.map(([id, label]) => {
        const b = el('button', { class: S.tab === id ? 'on' : '', 'aria-current': S.tab === id ? 'page' : null, onclick: () => { S.tab = id; render(); window.scrollTo(0, 0); } }, el('span'), label);
        b.firstChild.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' + ICONS[id] + '</svg>';
        return b;
      }));
      nav.hidden = false;
    } catch (e) {
      if (token) { fill(root, el('div', { class: 'card' }, el('p', {}, e.message), el('button', { class: 'btn', onclick: render }, 'Try again'))); }
    }
  }
  async function handleLink() {
    const m = location.hash.match(/^#(verify|reset)=([A-Za-z0-9_-]{20,100})$/);
    if (!m) return false;
    history.replaceState(null, '', location.pathname + location.search);
    if (m[1] === 'reset') S.reset = m[2];
    else {
      try { await api('/verify', 'POST', { token: m[2] }); S.linkNote = 'Email confirmed. You can add friends now.'; if (S.user) S.user.verified = 1; }
      catch (e) { S.linkNote = e.message; }
    }
    return true;
  }
  window.addEventListener('hashchange', async () => { if (await handleLink()) render(); });
  handleLink().then(render);
})();
