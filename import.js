'use strict';
// Parses class lists from CSV or calendar (.ics) text into { type, location, start } rows.
// start is studio-local wall time: 'YYYY-MM-DDTHH:MM'. Pure functions, no I/O.

const clean = (s, max = 60) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const pad = n => String(n).padStart(2, '0');

function parseDate(s) {
  s = clean(s, 20);
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/), y, mo, d;
  if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
  else if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/))) { mo = +m[1]; d = +m[2]; y = +m[3]; if (y < 100) y += 2000; }
  else return null;
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
  return `${y}-${pad(mo)}-${pad(d)}`;
}

function parseTime(s) {
  s = clean(s, 20).toLowerCase();
  let m = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap]m)?$/), h, mi;
  if (m) { h = +m[1]; mi = +m[2]; var ap = m[3]; }
  else if ((m = s.match(/^(\d{1,2})\s*([ap]m)$/))) { h = +m[1]; mi = 0; ap = m[2]; }
  else return null;
  if (ap) { if (h < 1 || h > 12) return null; h = (h % 12) + (ap === 'pm' ? 12 : 0); }
  if (h > 23 || mi > 59) return null;
  return `${pad(h)}:${pad(mi)}`;
}

function csvRows(t) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) { if (ch === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(f); f = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && t[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
    else f += ch;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim()));
}

const ALIASES = {
  date: ['date', 'day'], time: ['time', 'start', 'start time'],
  type: ['class', 'type', 'name', 'title', 'class name', 'class type'], location: ['location', 'studio', 'place']
};

function parseCsv(text) {
  const rows = csvRows(text.replace(/^﻿/, ''));
  if (rows.length < 2) return { rows: [], errors: ['The file needs a header row and at least one class.'] };
  const head = rows[0].map(h => clean(h, 40).toLowerCase());
  const col = {};
  for (const [k, names] of Object.entries(ALIASES)) col[k] = head.findIndex(h => names.includes(h));
  const missing = ['date', 'time', 'location'].filter(k => col[k] < 0);
  if (missing.length) return { rows: [], errors: ['Missing column: ' + missing.join(', ') + '. Use headers date, time, class, location.'] };
  const out = [], errors = [];
  rows.slice(1).forEach((r, i) => {
    const date = parseDate(r[col.date]), time = parseTime(r[col.time]);
    if (!date || !time) { errors.push(`Row ${i + 2}: could not read the date or time.`); return; }
    out.push({ type: clean(col.type >= 0 ? r[col.type] : '') || 'Class', location: clean(r[col.location]), start: `${date}T${time}` });
  });
  return { rows: out, errors };
}

const unesc = s => s.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1');

function parseIcs(text, toStudioTime) {
  const lines = text.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '').split(/\r?\n/);
  const events = []; let cur = null;
  for (const l of lines) {
    if (l === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (l === 'END:VEVENT') { if (cur) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    const i = l.indexOf(':'); if (i < 0) continue;
    const [name, ...params] = l.slice(0, i).split(';'); const val = l.slice(i + 1);
    const up = name.toUpperCase();
    if (up === 'DTSTART') { cur.dt = val; cur.params = params.join(';').toUpperCase(); }
    else if (up === 'SUMMARY') cur.summary = unesc(val);
    else if (up === 'LOCATION') cur.location = unesc(val);
    else if (up === 'RRULE') cur.recurring = true;
  }
  const out = [], errors = []; let allDay = 0;
  for (const e of events) {
    if (!e.dt) continue;
    const m = e.dt.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/);
    if (!m) { if (/^\d{8}$/.test(e.dt)) allDay++; continue; }
    let start = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}`;
    if (m[7]) start = toStudioTime(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5])));
    out.push({ type: clean(e.summary) || 'Class', location: clean(e.location), start, recurring: !!e.recurring });
  }
  if (allDay) errors.push(`${allDay} all-day event${allDay > 1 ? 's were' : ' was'} skipped.`);
  if (!events.length) errors.push('No events found in that calendar file.');
  return { rows: out, errors };
}

// Detects the format from the text itself.
function parseAny(text, toStudioTime) {
  const t = String(text || '');
  if (/BEGIN:VCALENDAR/i.test(t)) return parseIcs(t, toStudioTime);
  return parseCsv(t);
}

module.exports = { parseAny, parseCsv, parseIcs, parseDate, parseTime, clean };
