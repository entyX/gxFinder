// gxFinder local server: mirrors the GX.games catalogue, keeps it fresh,
// and serves the website. No dependencies — Node 18+.
import http from 'node:http';
import fs from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crawl, buildIndex, createApi, handleApi, snapshotOf } from './lib/core.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
const SNAPSHOTS = path.join(DATA, 'snapshots');
const PORT = Number(process.env.PORT) || 4173;
const REFRESH_MS = 30 * 60 * 1000;
const SNAPSHOT_EVERY_MS = 6 * 60 * 60 * 1000;
const MAX_SNAPSHOTS = 60;

mkdirSync(SNAPSHOTS, { recursive: true });

let api = null;
let updatedAt = 0;
let snapshots = [];
let building = null;
const progress = { state: 'idle', done: 0, total: 0, error: null };

async function loadFromDisk() {
  try {
    const files = (await fs.readdir(SNAPSHOTS)).filter((f) => f.endsWith('.json')).sort();
    snapshots = await Promise.all(files.map(async (f) => JSON.parse(await fs.readFile(path.join(SNAPSHOTS, f), 'utf8'))));
  } catch {
    snapshots = [];
  }
  try {
    const raw = JSON.parse(await fs.readFile(path.join(DATA, 'index.json'), 'utf8'));
    api = createApi(buildIndex(raw), snapshots);
    updatedAt = raw.updatedAt;
    progress.state = 'ready';
    console.log(`Loaded ${raw.games.length} games from disk (${new Date(updatedAt).toLocaleString()})`);
  } catch {
    /* first run */
  }
}

async function takeSnapshot(raw) {
  const last = snapshots.at(-1);
  if (last && raw.updatedAt - last.ts < SNAPSHOT_EVERY_MS) return;
  const snap = snapshotOf(raw);
  snapshots.push(snap);
  await fs.writeFile(path.join(SNAPSHOTS, `${snap.ts}.json`), JSON.stringify(snap));
  while (snapshots.length > MAX_SNAPSHOTS) {
    const old = snapshots.shift();
    await fs.rm(path.join(SNAPSHOTS, `${old.ts}.json`), { force: true });
  }
}

function refresh() {
  if (building) return building;
  const started = Date.now();
  progress.state = 'building';
  progress.error = null;
  building = crawl(progress)
    .then(async (raw) => {
      await fs.writeFile(path.join(DATA, 'index.json'), JSON.stringify(raw));
      await takeSnapshot(raw);
      api = createApi(buildIndex(raw), snapshots);
      updatedAt = raw.updatedAt;
      progress.state = 'ready';
      console.log(`Indexed ${raw.games.length} games in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    })
    .catch((err) => {
      progress.state = api ? 'ready' : 'error';
      progress.error = String(err.message || err);
      console.error('Refresh failed:', err);
    })
    .finally(() => (building = null));
  return building;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p.startsWith('/api/')) {
      if (!api) return send(res, p === '/api/meta' ? 200 : 503, { ready: false, progress });
      if (p === '/api/meta') return send(res, 200, api.meta(progress));
      const [status, body] = await handleApi(api, p, Object.fromEntries(url.searchParams));
      return send(res, status, body);
    }
    let file = path.normalize(path.join(PUBLIC, p === '/' ? 'index.html' : p));
    if (!file.startsWith(PUBLIC) || !existsSync(file)) file = path.join(PUBLIC, 'index.html');
    const body = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch (err) {
    console.error(err);
    send(res, 500, { error: 'server_error' });
  }
});

await loadFromDisk();
server.listen(PORT, () => console.log(`gxFinder running at http://localhost:${PORT}`));
if (!api || Date.now() - updatedAt > REFRESH_MS) refresh();
setInterval(refresh, REFRESH_MS);
