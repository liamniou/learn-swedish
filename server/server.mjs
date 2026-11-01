// Static file server + progress sync API for the Swedish portal. No dependencies.
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { readFile, writeFile, rename, mkdir, readdir, unlink, stat } from 'node:fs/promises';
import { join, normalize, extname, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(process.env.PUBLIC_DIR || join(dirname(fileURLToPath(import.meta.url)), '..'));
const DATA_DIR = resolve(process.env.DATA_DIR || join(ROOT, 'data'));
const STATE_FILE = join(DATA_DIR, 'state.json');
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

const emptyState = () => ({ version: 1, resetAt: 0, updatedAt: 0, progress: {}, daily: {}, settings: {}, drills: {} });
let state = emptyState();

async function loadState() {
  try {
    state = { ...emptyState(), ...JSON.parse(await readFile(STATE_FILE, 'utf8')) };
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

// Writes are serialized so concurrent requests can't interleave tmp/rename.
let writeChain = Promise.resolve();
function persist() {
  writeChain = writeChain.catch(() => {}).then(async () => {
    await mkdir(DATA_DIR, { recursive: true });
    const body = JSON.stringify(state);
    const tmp = `${STATE_FILE}.tmp`;
    await writeFile(tmp, body);
    await rename(tmp, STATE_FILE);
    await snapshot(body);
  });
  return writeChain;
}

async function snapshot(body) {
  await writeFile(join(DATA_DIR, `state-${new Date().toISOString().slice(0, 10)}.json`), body);
  const old = (await readdir(DATA_DIR)).filter(f => /^state-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().slice(0, -KEEP_SNAPSHOTS);
  await Promise.all(old.map(f => unlink(join(DATA_DIR, f))));
}

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function cleanEntry(p) {
  if (!p || typeof p !== 'object') return null;
  return { box: num(p.box), due: num(p.due), right: num(p.right), wrong: num(p.wrong), t: num(p.t) };
}

// Last-write-wins per card; entries written before the last reset are dropped.
function mergeProgress(incoming) {
  let changed = false;
  if (!incoming || typeof incoming !== 'object') return false;
  for (const [key, raw] of Object.entries(incoming)) {
    if (key.length > 300) continue;
    const p = cleanEntry(raw);
    if (!p || p.t <= state.resetAt) continue;
    const cur = state.progress[key];
    if (!cur || p.t > num(cur.t)) { state.progress[key] = p; changed = true; }
  }
  return changed;
}

// Exercise results: newest run wins for `last`; `best` and `runs` only grow.
function mergeDrills(incoming) {
  if (!incoming || typeof incoming !== 'object') return false;
  let changed = false;
  for (const [key, r] of Object.entries(incoming)) {
    if (key.length > 300 || !r || typeof r !== 'object' || num(r.t) <= state.resetAt) continue;
    const cur = state.drills[key];
    const next = {
      last: num(r.t) > num(cur?.t) ? num(r.last) : num(cur.last),
      best: Math.max(num(cur?.best), num(r.best)),
      total: num(r.t) > num(cur?.t) ? num(r.total) : num(cur.total),
      runs: Math.max(num(cur?.runs), num(r.runs)),
      t: Math.max(num(cur?.t), num(r.t)),
    };
    if (!cur || JSON.stringify(cur) !== JSON.stringify(next)) { state.drills[key] = next; changed = true; }
  }
  return changed;
}

function mergeDaily(d) {
  if (!d || typeof d.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d.date)) return false;
  const cur = state.daily;
  if (!cur.date || d.date > cur.date) {
    state.daily = { date: d.date, newSeen: num(d.newSeen), extra: num(d.extra) };
    return true;
  }
  if (d.date === cur.date) {
    const next = { date: d.date, newSeen: Math.max(num(cur.newSeen), num(d.newSeen)), extra: Math.max(num(cur.extra), num(d.extra)) };
    if (next.newSeen !== cur.newSeen || next.extra !== cur.extra) { state.daily = next; return true; }
  }
  return false;
}

function mergeSettings(s) {
  if (!s || typeof s !== 'object' || num(s.t) <= num(state.settings.t)) return false;
  state.settings = { newPerDay: Math.max(1, Math.min(200, num(s.newPerDay) || 20)), t: num(s.t) };
  return true;
}

function send(res, code, body) {
  const isText = typeof body === 'string';
  res.writeHead(code, {
    'Content-Type': isText ? 'text/plain; charset=utf-8' : TYPES['.json'],
    'Cache-Control': 'no-store',
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

  if (path.startsWith('/api/audio/')) return serveAudio(req, res, path.slice('/api/audio/'.length));

  if (path === '/api/state' && req.method === 'GET') return send(res, 200, state);

  if (path === '/api/sync' && req.method === 'POST') {
    const body = await readBody(req);
    const changed = [mergeProgress(body.progress), mergeDaily(body.daily), mergeSettings(body.settings), mergeDrills(body.drills)].some(Boolean);
    if (changed) { state.updatedAt = Date.now(); await persist(); }
    return send(res, 200, state);
  }

  // Replace everything: import from file, or reset (empty progress).
  if (path === '/api/state' && req.method === 'PUT') {
    const body = await readBody(req);
    const now = Date.now();
    state = { ...emptyState(), resetAt: now, updatedAt: now };
    const progress = Object.fromEntries(Object.entries(body.progress || {}).map(([k, p]) => [k, { ...p, t: now + 1 }]));
    mergeProgress(progress);
    mergeDrills(Object.fromEntries(Object.entries(body.drills || {}).map(([k, r]) => [k, { ...r, t: now + 1 }])));
    mergeDaily(body.daily);
    if (body.settings) mergeSettings({ ...body.settings, t: now });
    await persist();
    return send(res, 200, state);
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

await loadState();
server.listen(PORT, () => console.log(`learn-swedish on :${PORT}, data in ${DATA_DIR}, ${Object.keys(state.progress).length} progress entries`));

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => server.close(() => writeChain.finally(() => process.exit(0))));
}
