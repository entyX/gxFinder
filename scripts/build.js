// Vercel build: snapshot the GX.games catalogue into data/ so the API function
// can serve standings instantly. History is carried over from the previous
// production deploy (public/history.json), so trend lines grow with each build.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crawl, snapshotOf } from '../lib/core.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const PUBLIC = path.join(ROOT, 'public');
const MIN_GAP_MS = 12 * 3600 * 1000; // at most two snapshots a day
const MAX_SNAPSHOTS = 45;
const MIN_PLAYS_TRACKED = 100; // keeps history.json small

async function previousHistory() {
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.GXFINDER_URL;
  if (!host) return [];
  try {
    const res = await fetch(`https://${host.replace(/^https?:\/\//, '')}/history.json`, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    console.log(`Carried over ${body.snapshots?.length || 0} snapshots from ${host}`);
    return body.snapshots || [];
  } catch (err) {
    console.log(`No previous history from ${host} (${err.message}); starting fresh`);
    return [];
  }
}

const started = Date.now();
const progress = { done: 0, total: 0 };
const ticker = setInterval(() => console.log(`Crawling GX.games: page ${progress.done} of ${progress.total || '?'}`), 5000);
const raw = await crawl(progress).finally(() => clearInterval(ticker));
console.log(`Indexed ${raw.games.length} games in ${((Date.now() - started) / 1000).toFixed(1)}s`);

await fs.mkdir(DATA, { recursive: true });
await fs.writeFile(path.join(DATA, 'index.json'), JSON.stringify(raw));

const snapshots = await previousHistory();
const snap = snapshotOf(raw);
for (const [id, [plays]] of Object.entries(snap.data)) if (plays < MIN_PLAYS_TRACKED) delete snap.data[id];
if (!snapshots.length || snap.ts - snapshots.at(-1).ts >= MIN_GAP_MS) snapshots.push(snap);
while (snapshots.length > MAX_SNAPSHOTS) snapshots.shift();

const history = JSON.stringify({ snapshots });
await fs.writeFile(path.join(DATA, 'history.json'), history);
await fs.writeFile(path.join(PUBLIC, 'history.json'), history);
console.log(`History: ${snapshots.length} snapshots, ${(history.length / 1e6).toFixed(1)} MB`);
