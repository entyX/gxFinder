// gxFinder server: mirrors the public gx.games catalogue, computes standings,
// and serves the website. No dependencies — Node 18+.
import http from 'node:http';
import fs from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
const SNAPSHOTS = path.join(DATA, 'snapshots');
const PORT = Number(process.env.PORT) || 4173;
const API = 'https://api.gx.games/gxc';
const PAGE_SIZE = 200;
const CONCURRENCY = 4;
const REFRESH_MS = 30 * 60 * 1000;
const SNAPSHOT_EVERY_MS = 6 * 60 * 60 * 1000;
const MAX_SNAPSHOTS = 60;
const WEEKLY_PAGES = 10; // top 2,000 of the weekly ranking
const MIN_RATINGS = 20; // for the "top rated" board
const MIN_PLAYS_SESSION = 100; // for the "longest sessions" board

mkdirSync(SNAPSHOTS, { recursive: true });

// ---------------------------------------------------------------- upstream

async function fetchJSON(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'gxFinder/1.0', Accept: 'application/json' },
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (body.errors?.length) throw new Error(body.errors.map((e) => e.code).join(','));
      return body.data;
    } catch (err) {
      if (i === tries - 1) throw err;
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
}

function pickCover(covers = [], ratio = '16:9') {
  const c = covers.find((x) => x.type === 'IMAGE' && x.aspectRatio === ratio) || covers.find((x) => x.type === 'IMAGE');
  if (!c) return { small: null, large: null };
  const v = (w) => c.variants?.find((x) => x.width === w)?.url;
  return { small: v(640) || c.coverUrl, large: v(1280) || c.coverUrl };
}

function pickVideo(covers = []) {
  const c = covers.find((x) => x.type === 'VIDEO');
  return c?.variants?.find((x) => x.mimeType === 'video/mp4')?.url || null;
}

function trim(g) {
  const s = g.gamePlayStatistics || {};
  const ratings = g.gameRatings || [0, 0, 0, 0, 0];
  const cover = pickCover(g.covers);
  return {
    id: g.gameId,
    sid: g.gameShortId,
    slug: g.mangledTitle,
    title: g.title,
    studio: g.studio ? { id: g.studio.studioId, name: g.studio.name } : null,
    tags: (g.tags || []).map((t) => t.alias),
    plays: s.totalPlays || 0,
    players: s.uniquePlayers || 0,
    time: s.totalTime || 0, // seconds
    rating: g.averageGameRating || 0,
    ratings,
    votes: ratings.reduce((a, b) => a + b, 0),
    released: g.releaseDate || g.creationDate,
    modified: g.lastModified,
    cover: cover.small,
    coverLarge: cover.large,
    video: pickVideo(g.covers),
    platforms: g.platforms || [],
    multiplayer: !!g.multiplayer,
    blurb: g.shortDescription || '',
  };
}

// ---------------------------------------------------------------- index

let index = null; // current immutable snapshot of the catalogue
let building = null;
const progress = { state: 'idle', done: 0, total: 0, error: null };
let snapshots = []; // [{ts, data: {id: [plays, players, time]}}]

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

async function crawl() {
  progress.state = 'building';
  progress.error = null;
  const first = await fetchJSON(`${API}/v3/games?sort=total-plays-desc&pageSize=${PAGE_SIZE}&page=0`);
  const totalPages = first.pagination.totalPages;
  progress.total = totalPages + WEEKLY_PAGES;
  progress.done = 1;

  const tags = new Map();
  const games = new Map();
  const ingest = (list) => {
    for (const g of list) {
      for (const t of g.tags || []) {
        if (!tags.has(t.alias)) tags.set(t.alias, { alias: t.alias, title: t.title, parent: t.parentTagAlias || 'other' });
      }
      if (!games.has(g.gameId)) games.set(g.gameId, trim(g));
    }
  };
  ingest(first.games);

  const pages = Array.from({ length: totalPages - 1 }, (_, i) => i + 1);
  await pool(pages, CONCURRENCY, async (p) => {
    const d = await fetchJSON(`${API}/v3/games?sort=total-plays-desc&pageSize=${PAGE_SIZE}&page=${p}`);
    ingest(d.games);
    progress.done++;
  });

  const weekly = [];
  const weekPages = await pool(Array.from({ length: WEEKLY_PAGES }, (_, i) => i), CONCURRENCY, async (p) => {
    const d = await fetchJSON(`${API}/v3/games?sort=total-plays-desc&timeFrame=last-week&pageSize=${PAGE_SIZE}&page=${p}`);
    progress.done++;
    return d.games;
  });
  for (const list of weekPages) for (const g of list) if (!weekly.includes(g.gameId)) weekly.push(g.gameId);

  return { games: [...games.values()], tags, weekly };
}

const bayes = (g, mean) => (g.rating * g.votes + mean * MIN_RATINGS) / (g.votes + MIN_RATINGS);

function buildIndex({ games, tags, weekly, updatedAt }) {
  const byId = new Map(games.map((g) => [g.id, g]));
  const bySid = new Map(games.map((g) => [g.sid, g]));
  const rated = games.filter((g) => g.votes > 0);
  const meanRating = rated.reduce((a, g) => a + g.rating * g.votes, 0) / Math.max(1, rated.reduce((a, g) => a + g.votes, 0));

  const boards = {
    plays: [...games].sort((a, b) => b.plays - a.plays || b.players - a.players),
    players: [...games].sort((a, b) => b.players - a.players || b.plays - a.plays),
    time: [...games].sort((a, b) => b.time - a.time),
    session: games.filter((g) => g.plays >= MIN_PLAYS_SESSION).sort((a, b) => b.time / b.plays - a.time / a.plays),
    rating: games.filter((g) => g.votes >= MIN_RATINGS).sort((a, b) => bayes(b, meanRating) - bayes(a, meanRating) || b.votes - a.votes),
    week: weekly.map((id) => byId.get(id)).filter(Boolean),
    newest: [...games].sort((a, b) => (b.released || '').localeCompare(a.released || '')),
    updated: [...games].sort((a, b) => (b.modified || '').localeCompare(a.modified || '')),
  };
  const ranks = {};
  for (const [k, list] of Object.entries(boards)) ranks[k] = new Map(list.map((g, i) => [g.id, i + 1]));

  // per-tag standings by plays
  const tagGames = new Map();
  for (const g of boards.plays) {
    for (const t of g.tags) {
      if (!tagGames.has(t)) tagGames.set(t, []);
      tagGames.get(t).push(g);
    }
  }
  const tagRanks = new Map();
  for (const [t, list] of tagGames) tagRanks.set(t, new Map(list.map((g, i) => [g.id, i + 1])));
  const tagList = [...tags.values()]
    .map((t) => ({ ...t, count: tagGames.get(t.alias)?.length || 0 }))
    .filter((t) => t.count > 0)
    .sort((a, b) => b.count - a.count);

  const studios = new Map();
  for (const g of boards.plays) {
    if (!g.studio) continue;
    if (!studios.has(g.studio.id)) studios.set(g.studio.id, { ...g.studio, games: [] });
    studios.get(g.studio.id).games.push(g);
  }

  const totals = games.reduce(
    (a, g) => ((a.plays += g.plays), (a.players += g.players), (a.time += g.time), a),
    { games: games.length, plays: 0, players: 0, time: 0 },
  );

  return { games, byId, bySid, boards, ranks, tagGames, tagRanks, tagList, tagMeta: tags, studios, totals, meanRating, weekly, updatedAt };
}

async function loadFromDisk() {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(DATA, 'index.json'), 'utf8'));
    index = buildIndex({ ...raw, tags: new Map(raw.tags) });
    console.log(`Loaded ${index.games.length} games from disk (${new Date(index.updatedAt).toLocaleString()})`);
  } catch {
    /* first run */
  }
  try {
    const files = (await fs.readdir(SNAPSHOTS)).filter((f) => f.endsWith('.json')).sort();
    snapshots = await Promise.all(files.map(async (f) => JSON.parse(await fs.readFile(path.join(SNAPSHOTS, f), 'utf8'))));
  } catch {
    snapshots = [];
  }
}

async function takeSnapshot(idx) {
  const last = snapshots.at(-1);
  if (last && idx.updatedAt - last.ts < SNAPSHOT_EVERY_MS) return;
  const data = {};
  for (const g of idx.games) data[g.id] = [g.plays, g.players, g.time];
  const snap = { ts: idx.updatedAt, data };
  snapshots.push(snap);
  await fs.writeFile(path.join(SNAPSHOTS, `${idx.updatedAt}.json`), JSON.stringify(snap));
  while (snapshots.length > MAX_SNAPSHOTS) {
    const old = snapshots.shift();
    await fs.rm(path.join(SNAPSHOTS, `${old.ts}.json`), { force: true });
  }
}

function refresh() {
  if (building) return building;
  const started = Date.now();
  building = crawl()
    .then(async (raw) => {
      const updatedAt = Date.now();
      index = buildIndex({ ...raw, updatedAt });
      await fs.writeFile(
        path.join(DATA, 'index.json'),
        JSON.stringify({ games: raw.games, tags: [...raw.tags], weekly: raw.weekly, updatedAt }),
      );
      await takeSnapshot(index);
      progress.state = 'ready';
      console.log(`Indexed ${index.games.length} games in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    })
    .catch((err) => {
      progress.state = index ? 'ready' : 'error';
      progress.error = String(err.message || err);
      console.error('Refresh failed:', err);
    })
    .finally(() => (building = null));
  return building;
}

// change over the last ~7 days (or the oldest snapshot we have)
function weeklyDelta(g) {
  if (snapshots.length < 2) return null;
  const target = index.updatedAt - 7 * 24 * 3600 * 1000;
  const base = snapshots.find((s) => s.ts >= target && s.data[g.id]) || snapshots.find((s) => s.data[g.id]);
  if (!base || base.ts === index.updatedAt) return null;
  const [p, u] = base.data[g.id];
  return { plays: g.plays - p, players: g.players - u, since: base.ts };
}

// ---------------------------------------------------------------- queries

function card(g, rank) {
  return {
    rank,
    id: g.id,
    sid: g.sid,
    slug: g.slug,
    title: g.title,
    studio: g.studio,
    tags: g.tags.filter((t) => index.tagMeta.get(t)?.parent === 'genre').slice(0, 3).map((t) => tagLabel(t)),
    plays: g.plays,
    players: g.players,
    time: g.time,
    session: g.plays ? g.time / g.plays : 0,
    rating: g.rating,
    votes: g.votes,
    released: g.released,
    cover: g.cover,
    delta: weeklyDelta(g),
    weekRank: index.ranks.week.get(g.id) || null,
    playsRank: index.ranks.plays.get(g.id),
  };
}

const tagLabel = (alias) => ({ alias, title: index.tagMeta.get(alias)?.title || alias });

function norm(s) {
  return s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9а-я一-龥ぁ-んァ-ン ]+/gi, ' ').replace(/\s+/g, ' ').trim();
}

function searchGames(q, list) {
  const nq = norm(q);
  if (!nq) return list.map((g) => [0, g]);
  const words = nq.split(' ');
  const scored = [];
  for (const g of list) {
    const t = norm(g.title);
    const s = g.studio ? norm(g.studio.name) : '';
    let score = 0;
    if (t === nq) score = 100;
    else if (t.startsWith(nq)) score = 80;
    else if (t.split(' ').some((w) => w.startsWith(nq))) score = 60;
    else if (t.includes(nq)) score = 40;
    else if (words.every((w) => t.includes(w) || s.includes(w))) score = 20;
    if (score) scored.push([score, g]);
  }
  return scored;
}

function queryGames({ sort = 'plays', tag, studio, q, offset = 0, limit = 50 }) {
  let list = index.boards[sort] || index.boards.plays;
  if (tag) list = list.filter((g) => g.tags.includes(tag));
  if (studio) list = list.filter((g) => g.studio?.id === studio);
  if (q) list = searchGames(q, list).map(([, g]) => g); // keeps board order
  const total = list.length;
  const items = list.slice(offset, offset + limit).map((g, i) => card(g, offset + i + 1));
  return { total, items, sort };
}

function suggest(q) {
  const scored = searchGames(q, index.boards.plays);
  scored.sort((a, b) => b[0] - a[0] || b[1].plays - a[1].plays);
  return scored.slice(0, 8).map(([, g]) => card(g, index.ranks.plays.get(g.id)));
}

const detailCache = new Map();
async function upstreamDetail(id) {
  const hit = detailCache.get(id);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.data;
  const d = await fetchJSON(`${API}/v2/games/${id}`);
  const data = {
    description: d.longDescription || '',
    gallery: (d.gallery || []).filter((x) => x.type === 'IMAGE' && x.url).map((x) => x.variants?.[0]?.url || x.url).slice(0, 8),
    stickers: (d.receivedStickers || []).map((s) => ({ title: s.title?.value, uses: s.uses, cover: s.cover?.url })),
    engine: d.gameEngine?.title || null,
    ageRating: d.ageRating || null,
    controls: (d.gameControlGroups || []).map((g) => g.title),
    created: d.creationDate,
    stats: d.gamePlayStatistics,
    ratings: d.gameRatings,
    rating: d.averageGameRating,
  };
  detailCache.set(id, { at: Date.now(), data });
  return data;
}

async function gameReport(sid) {
  const g = index.bySid.get(sid) || index.byId.get(sid);
  if (!g) return null;
  let detail = null;
  try {
    detail = await upstreamDetail(g.id);
  } catch (err) {
    console.warn('detail failed', g.id, err.message);
  }
  // detail endpoint is fresher than the crawl
  const live = detail?.stats ? { ...g, plays: detail.stats.totalPlays, players: detail.stats.uniquePlayers, time: detail.stats.totalTime } : g;

  const N = index.games.length;
  const boardRank = (key, label, note) => {
    const r = index.ranks[key].get(g.id);
    return { key, label, note, rank: r || null, total: index.boards[key].length };
  };
  const overall = [
    boardRank('plays', 'Most played'),
    boardRank('players', 'Most players'),
    boardRank('time', 'Most time played'),
    boardRank('session', 'Longest sessions', `Games with ${MIN_PLAYS_SESSION}+ plays`),
    boardRank('rating', 'Top rated', `Games with ${MIN_RATINGS}+ ratings`),
    boardRank('week', 'Trending this week', 'Top 2,000 tracked'),
  ];
  const categories = g.tags
    .map((t) => {
      const meta = index.tagMeta.get(t);
      return { alias: t, title: meta?.title || t, parent: meta?.parent || 'other', rank: index.tagRanks.get(t)?.get(g.id), total: index.tagGames.get(t)?.length || 0 };
    })
    .filter((c) => c.rank)
    .sort((a, b) => a.rank / a.total - b.rank / b.total);

  const pr = index.ranks.plays.get(g.id) - 1;
  const rivals = index.boards.plays.slice(Math.max(0, pr - 2), pr + 3).map((x) => card(x, index.ranks.plays.get(x.id)));

  const studio = g.studio ? index.studios.get(g.studio.id) : null;
  const studioGames = studio ? studio.games.filter((x) => x.id !== g.id).slice(0, 6).map((x) => card(x, index.ranks.plays.get(x.id))) : [];
  const studioTotals = studio
    ? studio.games.reduce((a, x) => ((a.plays += x.plays), (a.players += x.players), a), { plays: 0, players: 0, games: studio.games.length })
    : null;

  const history = snapshots.filter((s) => s.data[g.id]).map((s) => ({ ts: s.ts, plays: s.data[g.id][0], players: s.data[g.id][1] }));
  if (!history.length || history.at(-1).ts !== index.updatedAt) history.push({ ts: Date.now(), plays: live.plays, players: live.players });

  // where this game sits against the catalogue
  const percentile = (key) => {
    const r = index.ranks[key].get(g.id);
    return r ? 1 - (r - 1) / index.boards[key].length : null;
  };

  return {
    game: {
      ...card(live, index.ranks.plays.get(g.id)),
      coverLarge: g.coverLarge,
      video: g.video,
      blurb: g.blurb,
      modified: g.modified,
      platforms: g.platforms,
      multiplayer: g.multiplayer,
      ratings: detail?.ratings || g.ratings,
      rating: detail?.rating ?? g.rating,
      allTags: g.tags.map(tagLabel),
      url: `https://gx.games/games/${g.sid}/${g.slug}/`,
    },
    detail,
    overall,
    categories,
    rivals,
    studio: studio ? { id: studio.id, name: studio.name, ...studioTotals, rank: null } : null,
    studioGames,
    history,
    percentiles: { plays: percentile('plays'), players: percentile('players'), time: percentile('time') },
    catalogue: { games: N, meanRating: index.meanRating },
  };
}

function meta() {
  const groups = {};
  if (index) {
    for (const t of index.tagList) (groups[t.parent] ||= []).push({ alias: t.alias, title: t.title, count: t.count });
  }
  return {
    ready: !!index,
    progress,
    updatedAt: index?.updatedAt || null,
    totals: index?.totals || null,
    tagGroups: groups,
    snapshots: snapshots.length,
  };
}

// ---------------------------------------------------------------- http

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p.startsWith('/api/')) {
      if (p === '/api/meta') return send(res, 200, meta());
      if (!index) return send(res, 503, { error: 'not_ready', ...meta() });
      if (p === '/api/games') {
        const qp = Object.fromEntries(url.searchParams);
        return send(res, 200, queryGames({ ...qp, offset: Math.max(0, +qp.offset || 0), limit: Math.min(100, +qp.limit || 50) }));
      }
      if (p === '/api/search') return send(res, 200, { items: suggest(url.searchParams.get('q') || '') });
      const m = p.match(/^\/api\/game\/([\w-]+)$/);
      if (m) {
        const r = await gameReport(m[1]);
        return r ? send(res, 200, r) : send(res, 404, { error: 'not_found' });
      }
      return send(res, 404, { error: 'unknown_endpoint' });
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
if (!index || Date.now() - index.updatedAt > REFRESH_MS) refresh();
setInterval(refresh, REFRESH_MS);
