// Static file server + per-user progress sync API for the Swedish portal. No dependencies.
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { readFile, writeFile, rename, mkdir, readdir, unlink, stat, copyFile } from 'node:fs/promises';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { join, normalize, extname, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(process.env.PUBLIC_DIR || join(dirname(fileURLToPath(import.meta.url)), '..'));
const DATA_DIR = resolve(process.env.DATA_DIR || join(ROOT, 'data'));
const PORT = Number(process.env.PORT || 8080);
const KEEP_SNAPSHOTS = 30;
const MAX_BODY = 2 * 1024 * 1024;
const PUBLIC_PATHS = ['/index.html', '/assets/', '/lessons/'];

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

const emptyState = () => ({ version: 1, resetAt: 0, updatedAt: 0, progress: {}, daily: {}, settings: {}, drills: {}, answers: {} });

// ---------- Users & sessions ----------
// Users come from $DATA_DIR/users.json (private, on the host, never in git):
//   { "users": [ { "id": "stas", "name": "Stas", "pin": "1234" }, ... ] }
// The first user owns any legacy single-user $DATA_DIR/state.json (migrated on first load).
// Sessions are HMAC-signed cookies; changing a user's PIN invalidates their sessions.

const USERS_FILE = join(DATA_DIR, 'users.json');
const SECRET_FILE = join(DATA_DIR, 'session-secret');
const COOKIE = 'sv_session';
const SESSION_DAYS = 365;
let users = [];
let usersMtime = -1;

async function loadUsers() {
  const st = await stat(USERS_FILE).catch(() => null);
  const mtime = st ? st.mtimeMs : 0;
  if (mtime === usersMtime) return users;
  usersMtime = mtime;
  if (!st) {
    users = [];
    console.warn(`no ${USERS_FILE}: nobody can log in`);
    return users;
  }
  try {
    const cfg = JSON.parse(await readFile(USERS_FILE, 'utf8'));
    const seen = new Set();
    users = (cfg.users || []).filter(u => {
      const ok = u && /^[a-z0-9][a-z0-9-]{0,30}$/.test(u.id) && typeof u.name === 'string' && u.name.trim()
        && /^\d{4,8}$/.test(String(u.pin)) && !seen.has(u.id);
      if (!ok) console.warn('users.json: skipping invalid user', u?.id);
      else seen.add(u.id);
      return ok;
    }).map(u => ({ id: u.id, name: u.name.trim(), pin: String(u.pin) }));
    console.log(`users: ${users.map(u => u.id).join(', ') || '(none)'}`);
  } catch (err) {
    console.error('users.json: cannot parse, nobody can log in:', err.message);
    users = [];
  }
  return users;
}

let secret;
async function sessionSecret() {
  if (secret) return secret;
  try { secret = Buffer.from((await readFile(SECRET_FILE, 'utf8')).trim(), 'hex'); }
  catch { secret = Buffer.alloc(0); }
  if (secret.length < 32) {
    secret = randomBytes(32);
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(SECRET_FILE, secret.toString('hex') + '\n', { mode: 0o600 });
  }
  return secret;
}

const sha = s => createHash('sha256').update(String(s)).digest();
const sign = async (uid, exp, pin) =>
  createHmac('sha256', await sessionSecret()).update(`${uid}.${exp}.`).update(sha(pin)).digest('base64url');

async function makeToken(u) {
  const exp = Date.now() + SESSION_DAYS * 864e5;
  return `${u.id}.${exp}.${await sign(u.id, exp, u.pin)}`;
}

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}

async function authUser(req) {
  const [uid, expStr, sig] = readCookie(req, COOKIE).split('.');
  const exp = Number(expStr);
  if (!uid || !sig || !Number.isFinite(exp) || exp < Date.now()) return null;
  const u = (await loadUsers()).find(x => x.id === uid);
  if (!u) return null;
  const want = Buffer.from(await sign(u.id, exp, u.pin));
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got) ? u : null;
}

function sessionCookie(value, maxAge) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

// Brute-force guard for 4-digit PINs: after 5 failures per client, lock out with growing delays.
const failures = new Map();
const clientKey = req => req.socket.remoteAddress || 'unknown';
function lockedFor(req) {
  const f = failures.get(clientKey(req));
  return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 1000) : 0;
}
function recordFailure(req) {
  const k = clientKey(req);
  const f = failures.get(k) || { count: 0, until: 0 };
  f.count++;
  if (f.count >= 5) f.until = Date.now() + Math.min(15 * 60e3, 30e3 * 2 ** (f.count - 5));
  failures.set(k, f);
}

// ---------- Per-user progress stores ----------

const stores = new Map();

async function getStore(uid) {
  let s = stores.get(uid);
  if (!s) {
    s = { id: uid, dir: join(DATA_DIR, 'users', uid), state: emptyState(), chain: Promise.resolve() };
    s.loaded = loadStore(s);
    stores.set(uid, s);
  }
  await s.loaded;
  return s;
}

async function loadStore(s) {
  const file = join(s.dir, 'state.json');
  const legacy = join(DATA_DIR, 'state.json');
  if (users[0]?.id === s.id && !(await stat(file).catch(() => null)) && (await stat(legacy).catch(() => null))) {
    await mkdir(s.dir, { recursive: true });
    await copyFile(legacy, file);
    await rename(legacy, join(DATA_DIR, 'state.legacy.json'));
    console.log(`migrated legacy state.json to user "${s.id}"`);
  }
  try {
    s.state = { ...emptyState(), ...JSON.parse(await readFile(file, 'utf8')) };
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

// Writes are serialized per user so concurrent requests can't interleave tmp/rename.
function persist(s) {
  s.chain = s.chain.catch(() => {}).then(async () => {
    await mkdir(s.dir, { recursive: true });
    const body = JSON.stringify(s.state);
    const file = join(s.dir, 'state.json');
    await writeFile(`${file}.tmp`, body);
    await rename(`${file}.tmp`, file);
    await writeFile(join(s.dir, `state-${new Date().toISOString().slice(0, 10)}.json`), body);
    const old = (await readdir(s.dir)).filter(f => /^state-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().slice(0, -KEEP_SNAPSHOTS);
    await Promise.all(old.map(f => unlink(join(s.dir, f))));
  });
  return s.chain;
}

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function cleanEntry(p) {
  if (!p || typeof p !== 'object') return null;
  return { box: num(p.box), due: num(p.due), right: num(p.right), wrong: num(p.wrong), t: num(p.t) };
}

// Last-write-wins per card; entries written before the last reset are dropped.
function mergeProgress(st, incoming) {
  let changed = false;
  if (!incoming || typeof incoming !== 'object') return false;
  for (const [key, raw] of Object.entries(incoming)) {
    if (key.length > 300) continue;
    const p = cleanEntry(raw);
    if (!p || p.t <= st.resetAt) continue;
    const cur = st.progress[key];
    if (!cur || p.t > num(cur.t)) { st.progress[key] = p; changed = true; }
  }
  return changed;
}

// Exercise results: newest run wins for `last`; `best` and `runs` only grow.
function mergeDrills(st, incoming) {
  if (!incoming || typeof incoming !== 'object') return false;
  let changed = false;
  for (const [key, r] of Object.entries(incoming)) {
    if (key.length > 300 || !r || typeof r !== 'object' || num(r.t) <= st.resetAt) continue;
    const cur = st.drills[key];
    const next = {
      last: num(r.t) > num(cur?.t) ? num(r.last) : num(cur.last),
      best: Math.max(num(cur?.best), num(r.best)),
      total: num(r.t) > num(cur?.t) ? num(r.total) : num(cur.total),
      runs: Math.max(num(cur?.runs), num(r.runs)),
      t: Math.max(num(cur?.t), num(r.t)),
    };
    if (!cur || JSON.stringify(cur) !== JSON.stringify(next)) { st.drills[key] = next; changed = true; }
  }
  return changed;
}

// Written exercise answers: whole entry per exercise, newest wins.
const MAX_ANSWER_BYTES = 50 * 1024;
function mergeAnswers(st, incoming) {
  if (!incoming || typeof incoming !== 'object') return false;
  let changed = false;
  for (const [key, a] of Object.entries(incoming)) {
    if (key.length > 300 || !a || typeof a !== 'object' || num(a.t) <= st.resetAt) continue;
    if (num(a.t) <= num(st.answers[key]?.t)) continue;
    const entry = {
      v: a.v && typeof a.v === 'object' ? a.v : {},
      checked: !!a.checked,
      self: a.self && typeof a.self === 'object' ? Object.fromEntries(Object.keys(a.self).filter(k => /^\d+$/.test(k) && a.self[k]).map(k => [k, true])) : {},
      score: num(a.score),
      total: num(a.total),
      t: num(a.t),
    };
    if (JSON.stringify(entry).length > MAX_ANSWER_BYTES) continue;
    st.answers[key] = entry;
    changed = true;
  }
  return changed;
}

function mergeDaily(st, d) {
  if (!d || typeof d.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d.date)) return false;
  const cur = st.daily;
  if (!cur.date || d.date > cur.date) {
    st.daily = { date: d.date, newSeen: num(d.newSeen), extra: num(d.extra) };
    return true;
  }
  if (d.date === cur.date) {
    const next = { date: d.date, newSeen: Math.max(num(cur.newSeen), num(d.newSeen)), extra: Math.max(num(cur.extra), num(d.extra)) };
    if (next.newSeen !== cur.newSeen || next.extra !== cur.extra) { st.daily = next; return true; }
  }
  return false;
}

function mergeSettings(st, s) {
  if (!s || typeof s !== 'object' || num(s.t) <= num(st.settings.t)) return false;
  st.settings = { newPerDay: Math.max(1, Math.min(200, num(s.newPerDay) || 20)), t: num(s.t) };
  return true;
}

function send(res, code, body, headers = {}) {
  const isText = typeof body === 'string';
  res.writeHead(code, {
    'Content-Type': isText ? 'text/plain; charset=utf-8' : TYPES['.json'],
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(isText ? body : JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw Object.assign(new Error('body too large'), { status: 413 });
    chunks.push(c);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw Object.assign(new Error('invalid JSON'), { status: 400 }); }
}

async function handleApi(req, res, path) {
  if (path === '/api/health') return send(res, 200, { ok: true });

  if (path === '/api/users' && req.method === 'GET') {
    return send(res, 200, (await loadUsers()).map(u => ({ id: u.id, name: u.name, pinLength: u.pin.length })));
  }

  if (path === '/api/login' && req.method === 'POST') {
    const wait = lockedFor(req);
    if (wait) return send(res, 429, { error: 'locked', retryAfter: wait }, { 'Retry-After': String(wait) });
    const body = await readBody(req);
    const u = (await loadUsers()).find(x => x.id === body.user);
    const ok = !!u && timingSafeEqual(sha(u.pin), sha(String(body.pin ?? '')));
    if (!ok) {
      recordFailure(req);
      const locked = lockedFor(req);
      return send(res, locked ? 429 : 401, { error: locked ? 'locked' : 'wrong pin', retryAfter: locked || undefined });
    }
    failures.delete(clientKey(req));
    return send(res, 200, { id: u.id, name: u.name },
      { 'Set-Cookie': sessionCookie(await makeToken(u), SESSION_DAYS * 86400) });
  }

  if (path === '/api/logout' && req.method === 'POST') {
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
  }

  const user = await authUser(req);
  if (!user) return send(res, 401, { error: 'login required' });

  if (path === '/api/me' && req.method === 'GET') return send(res, 200, { id: user.id, name: user.name });

  if (path.startsWith('/api/audio/')) return serveAudio(req, res, path.slice('/api/audio/'.length));

  const store = await getStore(user.id);

  if (path === '/api/state' && req.method === 'GET') return send(res, 200, store.state);

  if (path === '/api/sync' && req.method === 'POST') {
    const body = await readBody(req);
    const st = store.state;
    const changed = [mergeProgress(st, body.progress), mergeDaily(st, body.daily), mergeSettings(st, body.settings),
      mergeDrills(st, body.drills), mergeAnswers(st, body.answers)].some(Boolean);
    if (changed) { st.updatedAt = Date.now(); await persist(store); }
    return send(res, 200, store.state);
  }

  // Replace everything: import from file, or reset (empty progress).
  if (path === '/api/state' && req.method === 'PUT') {
    const body = await readBody(req);
    const now = Date.now();
    const st = store.state = { ...emptyState(), resetAt: now, updatedAt: now };
    const bump = obj => Object.fromEntries(Object.entries(obj || {}).map(([k, v]) => [k, { ...v, t: now + 1 }]));
    mergeProgress(st, bump(body.progress));
    mergeDrills(st, bump(body.drills));
    mergeAnswers(st, bump(body.answers));
    mergeDaily(st, body.daily);
    if (body.settings) mergeSettings(st, { ...body.settings, t: now });
    await persist(store);
    return send(res, 200, store.state);
  }

  send(res, 404, { error: 'not found' });
}

// Audio tracks: a local file in $DATA_DIR/audio/<id>.mp3 wins; otherwise the track is streamed from
// the URL in $DATA_DIR/audio-sources.json. Both live only on the host so licensed audio stays out of git.
async function serveAudio(req, res, id) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
  if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(id)) return send(res, 404, 'Not found');

  const local = join(DATA_DIR, 'audio', `${id}.mp3`);
  const st = await stat(local).catch(() => null);
  if (st?.isFile()) return sendFileRange(req, res, local, st.size, 'audio/mpeg');

  let sources;
  try { sources = JSON.parse(await readFile(join(DATA_DIR, 'audio-sources.json'), 'utf8')); }
  catch { sources = {}; }
  const url = sources[id];
  if (typeof url !== 'string' || !/^https:\/\//.test(url)) return send(res, 404, 'Not found');

  const headers = {};
  if (req.headers.range) headers.Range = req.headers.range;
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  let up;
  try { up = await fetch(url, { method: req.method, headers, signal: ac.signal }); }
  catch { return send(res, 502, 'Upstream unavailable'); }
  if (up.status !== 200 && up.status !== 206) return send(res, 502, `Upstream HTTP ${up.status}`);

  const out = {
    'Content-Type': up.headers.get('content-type') || 'audio/mpeg',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=86400',
  };
  for (const h of ['content-length', 'content-range']) if (up.headers.get(h)) out[h] = up.headers.get(h);
  res.writeHead(up.status, out);
  if (req.method === 'HEAD' || !up.body) return res.end();
  Readable.fromWeb(up.body).on('error', () => res.destroy()).pipe(res);
}

function sendFileRange(req, res, file, size, type) {
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=86400' };
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  let start = 0, end = size - 1, code = 200;
  if (m && (m[1] || m[2])) {
    start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start > end || start >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      return res.end();
    }
    code = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  headers['Content-Length'] = end - start + 1;
  res.writeHead(code, headers);
  if (req.method === 'HEAD') return res.end();
  createReadStream(file, { start, end }).pipe(res);
}

async function serveStatic(req, res, path) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
  if (path === '/') path = '/index.html';
  const rel = normalize(path);
  if (!PUBLIC_PATHS.some(p => rel === p || (p.endsWith('/') && rel.startsWith(p)))) return send(res, 404, 'Not found');
  const file = join(ROOT, rel);
  if (!file.startsWith(ROOT + '/')) return send(res, 404, 'Not found');
  try {
    const st = await stat(file);
    if (!st.isFile()) return send(res, 404, 'Not found');
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    res.end(await readFile(file));
  } catch {
    send(res, 404, 'Not found');
  }
}

const server = createServer(async (req, res) => {
  let path;
  try { path = decodeURIComponent(new URL(req.url, 'http://x').pathname); }
  catch { return send(res, 400, 'Bad request'); }
  try {
    if (path.startsWith('/api/')) await handleApi(req, res, path);
    else await serveStatic(req, res, path);
  } catch (err) {
    console.error(req.method, path, err);
    if (!res.headersSent) send(res, err.status || 500, { error: err.status ? err.message : 'internal error' });
  }
});

await sessionSecret();
await loadUsers();
if (users[0]) await getStore(users[0].id);
server.listen(PORT, () => console.log(`learn-swedish on :${PORT}, data in ${DATA_DIR}`));

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => server.close(() => Promise.allSettled([...stores.values()].map(s => s.chain)).then(() => process.exit(0))));
}
