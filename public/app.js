// gxFinder front end — vanilla ES modules, hash routing.
import { openShare } from './share.js';

const $ = (sel, root = document) => root.querySelector(sel);
const main = $('#main');
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ------------------------------------------------------------ formatting

const nf = new Intl.NumberFormat('en');
const cf = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const full = (n) => nf.format(Math.round(n || 0));
const compact = (n) => (Math.abs(n) < 10000 ? full(n) : cf.format(n));
const hours = (sec) => compact(sec / 3600);
function duration(sec) {
  if (!sec || !isFinite(sec)) return '0s';
  sec = Math.round(sec);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, '0')}s`;
  return `${Math.floor(sec / 3600)}h ${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}m`;
}
function ago(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}
const date = (iso) => (iso ? new Date(iso).toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric' }) : '—');
const pct = (rank, total) => {
  const p = (rank / total) * 100;
  return p < 1 ? `Top ${p < 0.1 ? p.toFixed(2) : p.toFixed(1)}%` : `Top ${Math.ceil(p)}%`;
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const rankClass = (r) => (r >= 10000 ? 'rank rank--xs' : r >= 1000 ? 'rank rank--sm' : 'rank');

// ------------------------------------------------------------ api

async function api(path) {
  const res = await fetch(path);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || res.statusText), { status: res.status, body });
  return body;
}

let meta = null;
async function loadMeta() {
  meta = await api('/api/meta');
  renderFreshness();
  return meta;
}
function renderFreshness() {
  const el = $('#freshness');
  if (!meta?.updatedAt) return (el.innerHTML = '');
  el.innerHTML = `<i aria-hidden="true"></i>Updated ${ago(meta.updatedAt)}`;
}
setInterval(renderFreshness, 30000);
setInterval(() => loadMeta().catch(() => {}), 5 * 60 * 1000);

// ------------------------------------------------------------ boards

const BOARDS = [
  { key: 'plays', label: 'Most played', metric: 'plays', lede: 'most played' },
  { key: 'players', label: 'Most players', metric: 'players', lede: 'most players' },
  { key: 'week', label: 'Trending this week', metric: 'plays', lede: 'trending this week' },
  { key: 'time', label: 'Most time played', metric: 'time', lede: 'most time played' },
  { key: 'session', label: 'Longest sessions', metric: 'session', lede: 'longest average session' },
  { key: 'rating', label: 'Top rated', metric: 'rating', lede: 'top rated' },
  { key: 'newest', label: 'Newest', metric: 'released', lede: 'newest release' },
];
const board = (key) => BOARDS.find((b) => b.key === key) || BOARDS[0];
const BOARD_NOTES = {
  session: 'Average session length, for games with at least 100 plays.',
  rating: 'Weighted rating, for games with at least 20 player ratings.',
  week: 'GX.games’ own weekly ranking. Totals shown are all time.',
};

// ------------------------------------------------------------ router

function parseHash() {
  const raw = location.hash.slice(1) || '/';
  const [path, qs = ''] = raw.split('?');
  return { path, params: Object.fromEntries(new URLSearchParams(qs)) };
}
function homeHref(params) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v && !(k === 'sort' && v === 'plays')) p.set(k, v);
  const s = p.toString();
  return `#/${s ? `?${s}` : ''}`;
}
const gameHref = (g) => `#/game/${g.sid}`;

let lastPath = null;
async function route() {
  const { path, params } = parseHash();
  closeSearch();
  try {
    if (!meta?.ready) await waitForIndex();
    const m = path.match(/^\/game\/([\w-]+)/);
    if (m) await renderGame(m[1]);
    else await renderHome(params, path === lastPath);
  } catch (err) {
    console.error(err);
    renderError(err);
  }
  if (path !== lastPath) {
    window.scrollTo({ top: 0, behavior: 'instant' });
    lastPath = path;
  }
}
window.addEventListener('hashchange', route);

async function waitForIndex() {
  for (;;) {
    await loadMeta();
    if (meta.ready) return;
    const { done, total, state, error } = meta.progress;
    const share = total ? Math.round((done / total) * 100) : 4;
    main.innerHTML = `
      <section class="boot" aria-live="polite">
        <h1>Building the standings</h1>
        <p>${state === 'error' ? `GX.games didn't respond (${esc(error)}). Retrying shortly.` : 'Reading every public game on GX.games. This only happens on the first run and takes about 20 seconds.'}</p>
        <div class="bar" role="progressbar" aria-valuenow="${share}" aria-valuemin="0" aria-valuemax="100"><i style="width:${share}%"></i></div>
        <small>${total ? `Page ${done} of ${total}` : 'Connecting'}</small>
      </section>`;
    await new Promise((r) => setTimeout(r, 1200));
  }
}

function renderError(err) {
  const notFound = err.status === 404;
  main.innerHTML = `
    <section class="wrap empty">
      <h2>${notFound ? 'That game isn’t on GX.games' : 'Couldn’t load this page'}</h2>
      <p>${notFound ? 'It may have been unpublished or renamed. Search for it by name instead.' : 'The gxFinder server didn’t respond. Check that it’s running, then reload.'}</p>
      <a class="btn" href="#/">Back to standings</a>
    </section>`;
}

// ------------------------------------------------------------ home

const PAGE = 50;
let homeState = null;

function tagOptions(selected) {
  const groups = meta.tagGroups || {};
  const order = [['genre', 'Genre'], ['theme', 'Theme'], ['vibe', 'Vibe'], ['art-style', 'Art style'], ['pov', 'Perspective'], ['players-supported', 'Players'], ['length', 'Length'], ['controls', 'Controls'], ['event', 'Events & jams']];
  return order
    .filter(([g]) => groups[g]?.length)
    .map(([g, label]) => `<optgroup label="${label}">${groups[g].map((t) => `<option value="${esc(t.alias)}" ${t.alias === selected ? 'selected' : ''}>${esc(t.title)} (${full(t.count)})</option>`).join('')}</optgroup>`)
    .join('');
}
function tagTitle(alias) {
  for (const list of Object.values(meta.tagGroups || {})) {
    const t = list.find((x) => x.alias === alias);
    if (t) return t.title;
  }
  return alias;
}

async function renderHome(params, sameView) {
  const sort = board(params.sort).key;
  const state = { sort, tag: params.tag || '', q: params.q || '', studio: params.studio || '', offset: 0 };
  const query = (offset) => `/api/games?${new URLSearchParams({ sort: state.sort, tag: state.tag, q: state.q, studio: state.studio, offset, limit: PAGE })}`;
  const data = await api(query(0));
  homeState = { ...state, data, items: data.items, query };

  // Keep the filter field focused if the user is typing in it
  const typing = sameView && document.activeElement?.id === 'filter';
  const caret = typing ? document.activeElement.selectionStart : 0;

  document.title = 'gxFinder — GX.games standings';
  const b = board(sort);
  const t = meta.totals;
  const studioName = state.studio && data.items[0]?.studio?.id === state.studio ? data.items[0].studio.name : null;
  const leader = data.items[0];

  main.innerHTML = `
    <section class="hero">
      <div class="wrap hero__inner">
        <div>
          <h1><span>Every game on</span><span>GX.games, ranked.</span></h1>
          <p class="hero__lede">Tracking <strong>${full(t.games)}</strong> games with <strong>${compact(t.plays)}</strong> plays from <strong>${compact(t.players)}</strong> players. Search a game to see where it stands overall and in every category.</p>
        </div>
        ${leader ? leaderCard(leader, b, state) : ''}
      </div>
    </section>

    <section class="controls" aria-label="Filter standings">
      <div class="wrap controls__inner">
        <div class="boards" role="group" aria-label="Rank by">
          ${BOARDS.map((x) => `<button class="board" type="button" data-sort="${x.key}" aria-pressed="${x.key === sort}">${x.label}</button>`).join('')}
        </div>
        ${studioName ? `<span class="chip">${esc(studioName)}<button type="button" data-clear="studio" aria-label="Clear studio filter">${xIcon}</button></span>` : ''}
        <label class="field field--select">
          <select id="tag" aria-label="Category"><option value="">All categories</option>${tagOptions(state.tag)}</select>
        </label>
      </div>
    </section>

    <section class="wrap standings" aria-label="Standings">
      <div class="table-meta">
        <p id="count">${countLine(data, state)}<span class="table-meta__note">${BOARD_NOTES[sort] || 'Select a game for its full breakdown.'}</span></p>
        <label class="field"><input id="filter" type="search" placeholder="Filter by name" value="${esc(state.q)}" aria-label="Filter standings by name" autocomplete="off"></label>
      </div>
      ${data.total ? `
      <div class="cols" role="presentation">
        <span>Rank</span><span>Game</span><span class="col-cat">Genre</span>
        ${colButton('plays', 'Plays', sort)}${colButton('players', 'Players', sort)}${colButton('time', 'Time played', sort)}${colButton('session', 'Avg. session', sort)}${colButton('rating', 'Rating', sort, 'col-rating')}
      </div>
      <ol class="rows" id="rows">${data.items.map((g) => row(g, b)).join('')}</ol>
      <div class="more" id="more">${moreButton()}</div>` : emptyState(state)}
    </section>`;

  bindHome();
  if (typing) {
    const f = $('#filter');
    f.focus();
    f.setSelectionRange(caret, caret);
  }
}

const xIcon = '<svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path d="M1 1l10 10M11 1L1 11" stroke="currentColor" stroke-width="1.8"/></svg>';

function countLine(data, s) {
  const scope = [s.tag && `in ${esc(tagTitle(s.tag))}`, s.q && `matching “${esc(s.q)}”`].filter(Boolean).join(' ');
  return `<strong>${full(data.total)}</strong> ${data.total === 1 ? 'game' : 'games'} ${scope}`;
}

function colButton(key, label, sort, extra = '') {
  const metricOf = board(sort).metric;
  const current = key === metricOf && sort !== 'newest';
  return `<button type="button" class="num ${extra}" data-sort="${key}" ${current ? 'aria-current="true"' : ''}>${label}</button>`;
}

function leaderCard(g, b, s) {
  const media = g.cover ? `<img src="${esc(g.cover.replace('webp-640x360', 'webp-1280x720'))}" alt="" onerror="this.src='${esc(g.cover)}'">` : '';
  const scope = s.tag ? ` in ${tagTitle(s.tag)}` : '';
  return `
    <a class="leader" href="${gameHref(g)}">
      <div class="leader__media">${media}</div>
      <div class="leader__cap">
        <div class="leader__no" aria-label="Rank 1"><small>#</small>1</div>
        <div class="leader__what">
          <div class="leader__board">${esc(b.label)}${esc(scope)}</div>
          <div class="leader__title">${esc(g.title)}</div>
        </div>
      </div>
    </a>`;
}

function metricCell(g, key, active) {
  const cls = `num${active ? ' is-active' : ''}`;
  switch (key) {
    case 'plays': {
      const d = g.delta?.plays;
      return `<span class="${cls}" title="${full(g.plays)} plays">${compact(g.plays)}${d > 0 ? `<span class="delta">+${compact(d)} this week</span>` : ''}</span>`;
    }
    case 'players':
      return `<span class="${cls}" title="${full(g.players)} unique players">${compact(g.players)}</span>`;
    case 'time':
      return `<span class="${cls}" title="${full(g.time / 3600)} hours">${hours(g.time)} h</span>`;
    case 'session':
      return `<span class="${cls}">${duration(g.session)}</span>`;
    case 'rating':
      return `<span class="${cls} col-rating">${g.votes ? `<span class="stars">${g.rating.toFixed(2)}<small>(${compact(g.votes)})</small></span>` : '<span class="delta--flat">—</span>'}</span>`;
  }
}

function row(g, b) {
  const metric = b.metric;
  const podium = g.rank <= 3 ? ' row--podium' : '';
  return `
    <li><a class="row${podium}" href="${gameHref(g)}">
      <span class="${rankClass(g.rank)}">${g.rank}</span>
      <span class="row__game">
        <img class="row__thumb" src="${esc(g.cover || '')}" alt="" loading="lazy" decoding="async">
        <span style="min-width:0">
          <span class="row__title" style="display:block">${esc(g.title)}</span>
          <span class="row__studio" style="display:block">${esc(g.studio?.name || 'Unknown studio')}${metric === 'released' ? ` <span>released ${date(g.released)}</span>` : ''}</span>
        </span>
      </span>
      <span class="row__tags col-cat">${g.tags.map((t) => esc(t.title)).join(', ') || '<span class="delta--flat">—</span>'}</span>
      ${['plays', 'players', 'time', 'session', 'rating'].map((k) => metricCell(g, k, k === metric)).join('')}
    </a></li>`;
}

function moreButton() {
  const { items, data } = homeState;
  if (items.length >= data.total) return data.total > PAGE ? `<p class="delta--flat" style="margin:0">That’s every game in this view.</p>` : '';
  const next = Math.min(PAGE, data.total - items.length);
  return `<button class="btn" type="button" id="load-more">Show the next ${next}</button>`;
}

function emptyState(s) {
  return `
    <div class="empty">
      <h2>No games match</h2>
      <p>Nothing ${s.tag ? `in ${esc(tagTitle(s.tag))} ` : ''}matches “${esc(s.q)}”. Try a shorter name or clear the category.</p>
      <a class="btn" href="${homeHref({ sort: s.sort })}">Clear filters</a>
    </div>`;
}

let filterTimer;
function bindHome() {
  const s = homeState;
  const go = (patch) => (location.hash = homeHref({ sort: s.sort, tag: s.tag, q: s.q, studio: s.studio, ...patch }));
  main.querySelectorAll('[data-sort]').forEach((el) => el.addEventListener('click', () => go({ sort: el.dataset.sort })));
  main.querySelectorAll('[data-clear]').forEach((el) => el.addEventListener('click', () => go({ [el.dataset.clear]: '' })));
  $('#tag')?.addEventListener('change', (e) => go({ tag: e.target.value }));
  $('#filter')?.addEventListener('input', (e) => {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => go({ q: e.target.value.trim() }), 220);
  });
  $('#load-more')?.addEventListener('click', loadMore);
}

async function loadMore() {
  const btn = $('#load-more');
  btn.disabled = true;
  btn.textContent = 'Loading';
  const s = homeState;
  const data = await api(s.query(s.items.length));
  s.items.push(...data.items);
  $('#rows').insertAdjacentHTML('beforeend', data.items.map((g) => row(g, board(s.sort))).join(''));
  $('#more').innerHTML = moreButton();
  $('#load-more')?.addEventListener('click', loadMore);
}

// ------------------------------------------------------------ search

const input = $('#search');
const results = $('#search-results');
const combo = input.closest('.search');
let searchItems = [];
let active = -1;
let searchSeq = 0;

function highlight(text, q) {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (!q || i < 0) return esc(text);
  return `${esc(text.slice(0, i))}<mark>${esc(text.slice(i, i + q.length))}</mark>${esc(text.slice(i + q.length))}`;
}

async function runSearch() {
  const q = input.value.trim();
  const seq = ++searchSeq;
  if (!q) return closeSearch();
  if (!meta?.ready) return;
  const { items } = await api(`/api/search?q=${encodeURIComponent(q)}`);
  if (seq !== searchSeq) return;
  searchItems = items;
  active = items.length ? 0 : -1;
  results.innerHTML = items.length
    ? items.map((g, i) => `
        <a class="sr" id="sr-${i}" role="option" href="${gameHref(g)}" aria-selected="${i === active}">
          <img class="sr__thumb" src="${esc(g.cover || '')}" alt="" loading="lazy">
          <span style="min-width:0">
            <span class="sr__title" style="display:block">${highlight(g.title, q)}</span>
            <span class="sr__studio" style="display:block">${esc(g.studio?.name || '')}</span>
          </span>
          <span class="sr__meta"><span class="sr__rank" style="display:block">#${full(g.rank)}</span><span class="sr__plays">${compact(g.plays)} plays</span></span>
        </a>`).join('') + `<a class="search__all" id="sr-all" role="option" href="${homeHref({ q })}">See every game matching “${esc(q)}” ranked</a>`
    : `<div class="search__empty">No game or studio called “${esc(q)}”. Check the spelling, or try part of the name.</div>`;
  results.hidden = false;
  combo.setAttribute('aria-expanded', 'true');
}

function closeSearch() {
  results.hidden = true;
  combo.setAttribute('aria-expanded', 'false');
  active = -1;
}

function moveActive(dir) {
  const opts = [...results.querySelectorAll('[role=option]')];
  if (!opts.length) return;
  active = (active + dir + opts.length) % opts.length;
  opts.forEach((o, i) => o.setAttribute('aria-selected', String(i === active)));
  opts[active].scrollIntoView({ block: 'nearest' });
  input.setAttribute('aria-activedescendant', opts[active].id);
}

let searchTimer;
input.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => runSearch().catch(console.error), 90);
});
input.addEventListener('focus', () => input.value.trim() && runSearch().catch(() => {}));
input.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); moveActive(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); moveActive(-1); }
  else if (e.key === 'Escape') { closeSearch(); input.blur(); }
  else if (e.key === 'Enter') {
    e.preventDefault();
    const opt = results.querySelectorAll('[role=option]')[active];
    if (opt) location.hash = opt.getAttribute('href');
    else if (input.value.trim()) location.hash = homeHref({ q: input.value.trim() });
    input.blur();
  }
});
results.addEventListener('click', () => { closeSearch(); input.blur(); });
document.addEventListener('click', (e) => { if (!combo.contains(e.target)) closeSearch(); });
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && !/input|textarea|select/i.test(document.activeElement.tagName)) {
    e.preventDefault();
    input.focus();
    input.select();
  }
});

// ------------------------------------------------------------ game page

async function renderGame(sid) {
  main.innerHTML = gameSkeleton();
  const r = await api(`/api/game/${encodeURIComponent(sid)}`);
  const g = r.game;
  document.title = `${g.title} — gxFinder`;
  const plays = r.overall.find((o) => o.key === 'plays');
  const genres = r.categories.filter((c) => c.parent === 'genre');
  const others = r.categories.filter((c) => !['genre', 'event', 'state', 'accessibility', 'sorting', 'other', 'pgc-until'].includes(c.parent));
  const ratingVotes = (g.ratings || []).reduce((a, b) => a + b, 0);
  const media = g.video && !reduceMotion
    ? `<video src="${esc(g.video)}" poster="${esc(g.coverLarge || g.cover || '')}" autoplay muted loop playsinline aria-hidden="true"></video>`
    : `<img src="${esc(g.coverLarge || g.cover || '')}" alt="">`;

  main.innerHTML = `
    <article class="game">
      <div class="backdrop" aria-hidden="true">${g.cover ? `<img src="${esc(g.cover)}" alt="">` : ''}</div>

      <div class="wrap">
        <nav class="crumbs" aria-label="Breadcrumb"><a href="#/">Standings</a><span aria-hidden="true">/</span><span>${esc(g.title)}</span></nav>

        <header class="ghero">
          <div class="ghero__media">${media}</div>
          <div>
            <h1>${esc(g.title)}</h1>
            ${g.studio ? `<div class="ghero__studio">by <a href="${homeHref({ studio: g.studio.id })}">${esc(g.studio.name)}</a></div>` : ''}
            ${g.blurb ? `<p class="ghero__blurb">${esc(g.blurb)}</p>` : ''}
            <div class="tags">${g.allTags.filter((t) => genres.some((x) => x.alias === t.alias)).map((t) => `<a class="tag" href="${homeHref({ tag: t.alias })}">${esc(t.title)}</a>`).join('')}</div>
            <div class="headline-rank">
              <div class="headline-rank__no"><small>#</small>${full(plays.rank)}</div>
              <div class="headline-rank__what"><strong>Most played on GX.games</strong><span>out of ${full(plays.total)} games, ${pct(plays.rank, plays.total).toLowerCase()}</span></div>
            </div>
            <div class="ghero__actions">
              <a class="btn btn--primary" href="${esc(g.url)}" target="_blank" rel="noopener">Play on GX.games ${extIcon}</a>
              <button class="btn" type="button" id="share-btn">${shareIcon}Share card</button>
              ${g.studio ? `<a class="btn" href="${homeHref({ studio: g.studio.id })}">All games by this studio</a>` : ''}
            </div>
          </div>
        </header>
      </div>

      <section class="wrap section" aria-labelledby="h-numbers">
        <div class="section__head"><h2 id="h-numbers">The numbers</h2><p>All-time totals, live from GX.games</p></div>
        <div class="figures">
          ${fig('Total plays', compact(g.plays), `${full(g.plays)} plays`, g.delta?.plays)}
          ${fig('Unique players', compact(g.players), `${full(g.players)} people`, g.delta?.players)}
          ${fig('Time played', hours(g.time), `${full(g.time / 3600)} hours in total`, null, 'hrs')}
          ${fig('Average session', duration(g.session), r.overall.find((o) => o.key === 'session').rank ? `Longer than ${Math.round((1 - (r.overall.find((o) => o.key === 'session').rank - 1) / r.overall.find((o) => o.key === 'session').total) * 100)}% of games` : 'Needs 100 plays to rank')}
          ${fig('Plays per player', g.players ? (g.plays / g.players).toFixed(2) : '0', 'How often people come back')}
          ${fig('Time per player', duration(g.players ? g.time / g.players : 0), 'Across all of their sessions')}
        </div>
      </section>

      <section class="wrap section" aria-labelledby="h-standings">
        <div class="split">
          <div>
            <div class="section__head"><h2 id="h-standings">Standings</h2><p>Where it ranks across GX.games</p></div>
            <div class="ranks">${r.overall.map(rankRow).join('')}</div>
          </div>
          <div>
            <div class="section__head"><h2 id="h-rating">Player rating</h2><p>${ratingVotes ? `${full(ratingVotes)} ratings` : 'No ratings yet'}</p></div>
            ${ratingBlock(g, ratingVotes, r.catalogue.meanRating)}
          </div>
        </div>
      </section>

      ${r.categories.length ? `
      <section class="wrap section" aria-labelledby="h-cats">
        <div class="section__head"><h2 id="h-cats">Category ranks</h2><p>Ranked by plays within each category</p></div>
        ${genres.length ? `<div class="cats">${genres.map(catCell).join('')}</div>` : ''}
        ${others.length ? `<div class="cat-group">Themes, style and other tags</div><div class="cats">${others.map(catCell).join('')}</div>` : ''}
      </section>` : ''}

      <section class="wrap section" aria-labelledby="h-rivals">
        <div class="split">
          <div>
            <div class="section__head"><h2 id="h-rivals">Closest rivals</h2><p>Neighbours on the most played board</p></div>
            <div class="rivals">${r.rivals.map((x) => rivalRow(x, g)).join('')}</div>
          </div>
          <div>
            <div class="section__head"><h2 id="h-trend">Plays over time</h2><p>${r.history.length > 1 ? `Since ${date(r.history[0].ts)}` : 'Snapshot every 6 hours'}</p></div>
            ${chart(r.history)}
          </div>
        </div>
      </section>

      ${r.studio ? `
      <section class="wrap section" aria-labelledby="h-studio">
        <div class="section__head"><h2 id="h-studio">${esc(r.studio.name)}</h2><p><a href="${homeHref({ studio: r.studio.id })}">See studio standings</a></p></div>
        <p class="studio-line"><strong>${full(r.studio.games)}</strong> ${r.studio.games === 1 ? 'game' : 'games'} on GX.games with <strong>${compact(r.studio.plays)}</strong> plays in total.</p>
        ${r.studioGames.length ? `<div class="cards">${r.studioGames.map(gcard).join('')}</div>` : ''}
      </section>` : ''}

      <section class="wrap section" aria-labelledby="h-about">
        <div class="split">
          <div>
            <div class="section__head"><h2 id="h-about">About the game</h2></div>
            <div class="prose">${markdown(r.detail?.description || g.blurb || 'The developer hasn’t written a description.')}</div>
          </div>
          <div>
            <div class="section__head"><h2>Details</h2></div>
            <dl class="facts">
              <dt>Released</dt><dd>${date(g.released)}</dd>
              <dt>Last updated</dt><dd>${date(g.modified)}</dd>
              <dt>Platforms</dt><dd>${g.platforms.map((p) => p[0] + p.slice(1).toLowerCase()).join(' and ') || '—'}</dd>
              <dt>Multiplayer</dt><dd>${g.multiplayer ? 'Yes' : 'No'}</dd>
              ${r.detail?.engine ? `<dt>Engine</dt><dd>${esc(r.detail.engine)}</dd>` : ''}
              ${r.detail?.ageRating ? `<dt>Age rating</dt><dd>${esc(r.detail.ageRating[0] + r.detail.ageRating.slice(1).toLowerCase())}</dd>` : ''}
              ${r.detail?.controls?.length ? `<dt>Controls</dt><dd>${r.detail.controls.map(esc).join(', ')}</dd>` : ''}
              ${r.detail?.stickers?.length ? `<dt>Stickers</dt><dd>${r.detail.stickers.map((s) => `${esc(s.title)} (${full(s.uses)})`).join(', ')}</dd>` : ''}
            </dl>
            ${r.detail?.gallery?.length ? `<div class="gallery" style="margin-top:26px">${r.detail.gallery.map((u) => `<img src="${esc(u)}" alt="" loading="lazy">`).join('')}</div>` : ''}
          </div>
        </div>
      </section>
    </article>`;
  $('#share-btn').addEventListener('click', () => openShare(r));
}

const shareIcon = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4.5" y="4.5" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M2.5 11V2.5H11" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';
const extIcon = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3H3v10h10v-3M9 2h5v5M14 2L7 9" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>';

function gameSkeleton() {
  return `
    <div class="wrap">
      <div class="crumbs"><a href="#/">Standings</a></div>
      <div class="ghero">
        <div class="ghero__media sk"></div>
        <div><div class="sk" style="height:64px;width:80%"></div><div class="sk" style="height:18px;width:40%;margin-top:16px"></div><div class="sk" style="height:84px;width:60%;margin-top:40px"></div></div>
      </div>
      <div class="sk" style="height:220px"></div>
    </div>`;
}

function fig(label, value, note, delta, unit) {
  return `
    <div class="fig">
      <div class="fig__label">${label}</div>
      <div class="fig__value">${value}${unit ? `<small>${unit}</small>` : ''}</div>
      <div class="fig__note">${delta > 0 ? `<b>+${compact(delta)}</b> this week. ` : ''}${note}</div>
    </div>`;
}

function rankRow(o) {
  if (!o.rank) {
    return `<div class="rk"><div class="rk__label">${o.label}${o.note ? `<small>${o.note}</small>` : ''}</div><div class="rk__no rk__no--none">Not ranked</div></div>`;
  }
  const share = Math.max(1.5, (1 - (o.rank - 1) / o.total) * 100);
  return `
    <a class="rk" href="${homeHref({ sort: o.key })}">
      <div class="rk__label">${o.label}${o.note ? `<small>${o.note}</small>` : ''}</div>
      <div class="rk__no">#${full(o.rank)}</div>
      <div class="rk__track" aria-hidden="true"><i style="width:${share}%"></i></div>
      <div class="rk__foot"><span>of ${full(o.total)}</span><b>${pct(o.rank, o.total)}</b></div>
    </a>`;
}

function ratingBlock(g, votes, mean) {
  if (!votes) return `<div class="ratings"><p class="chart__note" style="padding:20px 0">Nobody has rated this game yet.<small>Ratings appear once players leave stars on GX.games.</small></p></div>`;
  const max = Math.max(...g.ratings);
  const diff = g.rating - mean;
  return `
    <div class="ratings">
      <div class="ratings__top"><div class="ratings__avg">${g.rating.toFixed(2)}</div><span>out of 5. ${Math.abs(diff) < 0.05 ? 'About the GX.games average' : `${Math.abs(diff).toFixed(2)} ${diff > 0 ? 'above' : 'below'} the GX.games average of ${mean.toFixed(2)}`}.</span></div>
      ${[4, 3, 2, 1, 0].map((i) => `
        <div class="rbar"><span>${i + 1}</span><div class="rbar__track"><i style="width:${max ? (g.ratings[i] / max) * 100 : 0}%"></i></div><span>${Math.round((g.ratings[i] / votes) * 100)}%</span></div>`).join('')}
    </div>`;
}

function catCell(c, i) {
  const lead = c.rank <= 10 ? ' cat--lead' : '';
  return `
    <a class="cat${lead}" href="${homeHref({ tag: c.alias })}">
      <span class="cat__name">${esc(c.title)}</span><span class="cat__no">#${full(c.rank)}</span>
      <span class="cat__of">of ${full(c.total)} games, ${pct(c.rank, c.total).toLowerCase()}</span>
    </a>`;
}

function rivalRow(x, self) {
  const isSelf = x.id === self.id;
  const gap = x.plays - self.plays;
  const inner = `
    <span class="${rankClass(x.rank)}">${x.rank}</span>
    <img class="rv__thumb" src="${esc(x.cover || '')}" alt="" loading="lazy">
    <span style="min-width:0"><span class="rv__title" style="display:block">${esc(x.title)}</span><span class="rv__studio">${esc(x.studio?.name || '')}</span></span>
    <span class="rv__gap">${isSelf ? `${compact(x.plays)} plays<small>This game</small>` : `${gap > 0 ? '+' : '−'}${compact(Math.abs(gap))}<small>${gap > 0 ? 'plays ahead' : 'plays behind'}</small>`}</span>`;
  return isSelf ? `<div class="rv rv--self">${inner}</div>` : `<a class="rv" href="${gameHref(x)}">${inner}</a>`;
}

function chart(history) {
  if (history.length < 2) {
    return `<div class="chart"><p class="chart__note">Tracking started ${date(history[0]?.ts)}.<small>The trend line appears after the next snapshot, and gets more useful every day the server runs.</small></p></div>`;
  }
  const W = 560, H = 220, P = { l: 52, r: 12, t: 12, b: 26 };
  const xs = history.map((h) => h.ts), ys = history.map((h) => h.plays);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  let y0 = Math.min(...ys), y1 = Math.max(...ys);
  if (y0 === y1) { y0 -= 1; y1 += 1; }
  const pad = (y1 - y0) * 0.1; y0 = Math.max(0, y0 - pad); y1 += pad;
  const X = (t) => P.l + ((t - x0) / (x1 - x0 || 1)) * (W - P.l - P.r);
  const Y = (v) => H - P.b - ((v - y0) / (y1 - y0)) * (H - P.t - P.b);
  const pts = history.map((h) => `${X(h.ts).toFixed(1)},${Y(h.plays).toFixed(1)}`).join(' ');
  const ticks = [0, 0.5, 1].map((f) => y0 + (y1 - y0) * f);
  const last = history.at(-1);
  return `
    <div class="chart">
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Total plays from ${full(history[0].plays)} to ${full(last.plays)}">
        ${ticks.map((v) => `<line x1="${P.l}" x2="${W - P.r}" y1="${Y(v)}" y2="${Y(v)}" stroke="#24212b"/><text x="${P.l - 8}" y="${Y(v) + 4}" text-anchor="end">${compact(v)}</text>`).join('')}
        <polygon points="${P.l},${H - P.b} ${pts} ${X(last.ts)},${H - P.b}" fill="rgba(250,30,78,0.10)"/>
        <polyline points="${pts}" fill="none" stroke="#fa1e4e" stroke-width="2" vector-effect="non-scaling-stroke"/>
        <circle cx="${X(last.ts)}" cy="${Y(last.plays)}" r="4" fill="#fa1e4e"/>
        <text x="${P.l}" y="${H - 6}">${date(x0)}</text><text x="${W - P.r}" y="${H - 6}" text-anchor="end">${date(x1)}</text>
      </svg>
    </div>`;
}

function gcard(x) {
  return `
    <a class="gcard" href="${gameHref(x)}">
      <img class="gcard__img" src="${esc(x.cover || '')}" alt="" loading="lazy">
      <div class="gcard__title">${esc(x.title)}</div>
      <div class="gcard__meta"><span>#${full(x.rank)}</span><span>${compact(x.plays)} plays</span></div>
    </a>`;
}

// Minimal, safe markdown: headings, lists, bold, italics, links.
function markdown(src) {
  const inline = (s) =>
    esc(s)
      .replace(/\[([^\]]+)\]\(&lt;(https?:\/\/[^)\s]+?)&gt;\)/g, (_, t, u) => `<a href="${u}" target="_blank" rel="noopener nofollow">${t}</a>`)
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, t, u) => `<a href="${u}" target="_blank" rel="noopener nofollow">${t}</a>`)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|\W)\*([^*\n]+)\*(?=\W|$)/g, '$1<em>$2</em>');
  const out = [];
  let list = null;
  for (const raw of src.replace(/\r/g, '').split(/\n{2,}/)) {
    const lines = raw.split('\n').filter((l) => l.trim());
    if (!lines.length) continue;
    if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
      list ??= [];
      list.push(...lines.map((l) => `<li>${inline(l.replace(/^\s*[-*]\s+/, ''))}</li>`));
      continue;
    }
    if (list) { out.push(`<ul>${list.join('')}</ul>`); list = null; }
    const h = lines[0].match(/^#{1,6}\s+(.*)/);
    if (h && lines.length === 1) out.push(`<h3>${inline(h[1])}</h3>`);
    else out.push(`<p>${lines.map(inline).join('<br>')}</p>`);
  }
  if (list) out.push(`<ul>${list.join('')}</ul>`);
  return out.join('');
}

// ------------------------------------------------------------ boot

route();
