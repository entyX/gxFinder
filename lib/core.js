// Shared gxFinder logic: crawling GX.games, building standings, answering queries.
// Used by the local server (server.js), the Vercel build (scripts/build.js)
// and the Vercel function (api/handler.js).

const API = 'https://api.gx.games/gxc';
const PAGE_SIZE = 200;
const CONCURRENCY = 4;
const WEEKLY_PAGES = 10; // top 2,000 of the weekly ranking
export const MIN_RATINGS = 20; // for the "top rated" board
export const MIN_PLAYS_SESSION = 100; // for the "longest sessions" board

// ---------------------------------------------------------------- upstream

export async function fetchJSON(url, tries = 3) {
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

// Reads the whole public catalogue. Returns plain JSON-serialisable data.
export async function crawl(progress = { done: 0, total: 0 }) {
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

  await pool(Array.from({ length: totalPages - 1 }, (_, i) => i + 1), CONCURRENCY, async (p) => {
    const d = await fetchJSON(`${API}/v3/games?sort=total-plays-desc&pageSize=${PAGE_SIZE}&page=${p}`);
    ingest(d.games);
    progress.done++;
  });

  const weekPages = await pool(Array.from({ length: WEEKLY_PAGES }, (_, i) => i), CONCURRENCY, async (p) => {
    const d = await fetchJSON(`${API}/v3/games?sort=total-plays-desc&timeFrame=last-week&pageSize=${PAGE_SIZE}&page=${p}`);
    progress.done++;
    return d.games;
  });
  const seen = new Set();
  const weekly = [];
  for (const list of weekPages) for (const g of list) if (!seen.has(g.gameId)) (seen.add(g.gameId), weekly.push(g.gameId));

  return { games: [...games.values()], tags: [...tags], weekly, updatedAt: Date.now() };
}

// A compact snapshot of the numbers we chart over time.
export function snapshotOf(raw) {
  const data = {};
  for (const g of raw.games) data[g.id] = [g.plays, g.players];
  return { ts: raw.updatedAt, data };
}

// ---------------------------------------------------------------- index

const bayes = (g, mean) => (g.rating * g.votes + mean * MIN_RATINGS) / (g.votes + MIN_RATINGS);

export function buildIndex(raw) {
  const { games, weekly, updatedAt } = raw;
  const tags = raw.tags instanceof Map ? raw.tags : new Map(raw.tags);
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

// ---------------------------------------------------------------- queries

function norm(s) {
  return s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

// Returns an object of query functions bound to one index + snapshot history.
export function createApi(index, snapshots = []) {
  const tagLabel = (alias) => ({ alias, title: index.tagMeta.get(alias)?.title || alias });

  // change over the last ~7 days (or since the oldest snapshot we have)
  function weeklyDelta(g) {
    if (!snapshots.length) return null;
    const target = index.updatedAt - 7 * 24 * 3600 * 1000;
    const base = snapshots.find((s) => s.ts >= target && s.data[g.id]) || snapshots.find((s) => s.data[g.id]);
    if (!base || index.updatedAt - base.ts < 3600 * 1000) return null;
    const [p, u] = base.data[g.id];
    return { plays: g.plays - p, players: g.players - u, since: base.ts };
  }

  function card(g, rank) {
    return {
      rank,
      id: g.id,
      sid: g.sid,
      slug: g.slug,
      title: g.title,
      studio: g.studio,
      tags: g.tags.filter((t) => index.tagMeta.get(t)?.parent === 'genre').slice(0, 3).map(tagLabel),
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
    if (detailCache.size > 500) detailCache.clear();
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
    // the detail endpoint is fresher than the crawl
    const live = detail?.stats ? { ...g, plays: detail.stats.totalPlays, players: detail.stats.uniquePlayers, time: detail.stats.totalTime } : g;

    const boardRank = (key, label, note) => ({ key, label, note, rank: index.ranks[key].get(g.id) || null, total: index.boards[key].length });
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
    if (!history.length || Date.now() - history.at(-1).ts > 3600 * 1000) history.push({ ts: Date.now(), plays: live.plays, players: live.players });

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
      studio: studio ? { id: studio.id, name: studio.name, ...studioTotals } : null,
      studioGames,
      history,
      catalogue: { games: index.games.length, meanRating: index.meanRating },
    };
  }

  function meta(progress = { state: 'ready' }) {
    const tagGroups = {};
    for (const t of index.tagList) (tagGroups[t.parent] ||= []).push({ alias: t.alias, title: t.title, count: t.count });
    return { ready: true, progress, updatedAt: index.updatedAt, totals: index.totals, tagGroups, snapshots: snapshots.length };
  }

  return { queryGames, suggest, gameReport, meta };
}

// Proxies a GX.games cover so the browser can draw it on a canvas (the CDN sends no CORS headers).
export async function fetchImage(src) {
  let u;
  try {
    u = new URL(src);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.hostname !== 'play.gx.games') return null;
  const r = await fetch(u, { headers: { 'User-Agent': 'gxFinder/1.0' }, signal: AbortSignal.timeout(15000) });
  const type = r.headers.get('content-type') || '';
  if (!r.ok || !type.startsWith('image/')) return null;
  return { type, body: Buffer.from(await r.arrayBuffer()) };
}

// Shared HTTP routing for /api/* (used by both the local server and Vercel).
export async function handleApi(api, pathname, params) {
  if (pathname === '/api/meta') return [200, api.meta()];
  if (pathname === '/api/games') {
    return [200, api.queryGames({ ...params, offset: Math.max(0, +params.offset || 0), limit: Math.min(100, +params.limit || 50) })];
  }
  if (pathname === '/api/search') return [200, { items: api.suggest(params.q || '') }];
  const m = pathname.match(/^\/api\/game\/([\w-]+)$/);
  if (m) {
    const r = await api.gameReport(m[1]);
    return r ? [200, r] : [404, { error: 'not_found' }];
  }
  return [404, { error: 'unknown_endpoint' }];
}
