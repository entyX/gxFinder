// Vercel function: serves every /api/* route from the catalogue baked in at build time.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildIndex, createApi, handleApi } from '../lib/core.js';

let api = null;

function load() {
  if (api) return api;
  const dir = path.join(process.cwd(), 'data');
  const raw = JSON.parse(readFileSync(path.join(dir, 'index.json'), 'utf8'));
  let snapshots = [];
  try {
    snapshots = JSON.parse(readFileSync(path.join(dir, 'history.json'), 'utf8')).snapshots || [];
  } catch {
    /* no history yet */
  }
  api = createApi(buildIndex(raw), snapshots);
  return api;
}

function send(res, status, body, cache = 'no-store') {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', cache);
  res.end(JSON.stringify(body));
}

// Daily cron: trigger a redeploy so the build re-crawls GX.games.
async function cron(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) return send(res, 401, { error: 'unauthorized' });
  const hook = process.env.DEPLOY_HOOK_URL;
  if (!hook) return send(res, 200, { ok: false, reason: 'DEPLOY_HOOK_URL is not set' });
  const r = await fetch(hook, { method: 'POST' });
  return send(res, 200, { ok: r.ok, status: r.status });
}

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, 'http://x');
    const route = url.searchParams.get('route');
    url.searchParams.delete('route');
    const pathname = route != null ? `/api/${route}` : url.pathname;
    if (pathname === '/api/cron') return await cron(req, res);
    const [status, body] = await handleApi(load(), pathname, Object.fromEntries(url.searchParams));
    // Data only changes per deploy, so let Vercel's edge cache absorb repeat requests.
    send(res, status, body, status === 200 ? 'public, s-maxage=300, stale-while-revalidate=3600' : 'no-store');
  } catch (err) {
    console.error(err);
    send(res, 500, { error: 'server_error' });
  }
}
