// Share card: renders a 1200×630 PNG of a game's standing for pasting into chats,
// plus a plain-text version that reads well in Discord, Slack and iMessage.

const W = 1200;
const H = 630;
const C = {
  bg: '#09080c',
  text: '#f2f0f5',
  text2: '#bdb8c7',
  muted: '#827c8f',
  line: '#24212b',
  gx: '#fa1e4e',
};
const DISPLAY = '"Big Shoulders Display", "Arial Narrow", sans-serif';
const BODY = '"Be Vietnam Pro", system-ui, sans-serif';

const nf = new Intl.NumberFormat('en');
const cf = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const full = (n) => nf.format(Math.round(n || 0));
const compact = (n) => (Math.abs(n) < 10000 ? full(n) : cf.format(n));
function duration(sec) {
  if (!sec || !isFinite(sec)) return '0s';
  sec = Math.round(sec);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, '0')}s`;
  return `${Math.floor(sec / 3600)}h ${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}m`;
}
const topPct = (rank, total) => {
  const p = (rank / total) * 100;
  return p < 1 ? `top ${p < 0.1 ? p.toFixed(2) : p.toFixed(1)}%` : `top ${Math.ceil(p)}%`;
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const pageUrl = (g) => `${location.origin}/#/game/${g.sid}`;

// Best genre rank, falling back to any category in the top 10%.
function bestCategory(r) {
  const genres = r.categories.filter((c) => c.parent === 'genre');
  const pool = genres.length ? genres : r.categories.filter((c) => !['event', 'state', 'accessibility', 'sorting', 'other', 'pgc-until'].includes(c.parent));
  return pool.sort((a, b) => a.rank / a.total - b.rank / b.total)[0] || null;
}

// ------------------------------------------------------------ text

export function shareText(r) {
  const g = r.game;
  const plays = r.overall.find((o) => o.key === 'plays');
  const week = r.overall.find((o) => o.key === 'week');
  const cats = r.categories.filter((c) => c.parent === 'genre').slice(0, 3);
  const lines = [
    `**${g.title}**${g.studio ? ` by ${g.studio.name}` : ''}`,
    `#${full(plays.rank)} most played on GX.games (${topPct(plays.rank, plays.total)} of ${full(plays.total)})`,
    `${compact(g.plays)} plays, ${compact(g.players)} players, ${duration(g.session)} average session`,
  ];
  if (cats.length) lines.push(`Category ranks: ${cats.map((c) => `#${full(c.rank)} in ${c.title}`).join(', ')}`);
  if (week?.rank) lines.push(`Trending this week: #${full(week.rank)}`);
  if (g.votes) lines.push(`Rated ${g.rating.toFixed(2)}/5 from ${full(g.votes)} players`);
  lines.push(pageUrl(g));
  return lines.join('\n');
}

// ------------------------------------------------------------ image

function loadImage(src) {
  return new Promise((resolve) => {
    if (!src) return resolve(null);
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = `/api/img?url=${encodeURIComponent(src)}`;
  });
}

function chamfer(ctx, x, y, w, h, cut) {
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + w - cut, y);
  ctx.lineTo(x + w, y + cut);
  ctx.lineTo(x + w, y + h);
  ctx.lineTo(x + cut, y + h);
  ctx.lineTo(x, y + h - cut);
  ctx.closePath();
}

function drawCover(ctx, img, x, y, w, h) {
  const s = Math.max(w / img.width, h / img.height);
  const iw = img.width * s;
  const ih = img.height * s;
  ctx.drawImage(img, x + (w - iw) / 2, y + (h - ih) / 2, iw, ih);
}

// Wraps text to at most `maxLines`, adding an ellipsis if it overflows.
function wrap(ctx, text, maxWidth, maxLines) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (let i = 0; i < words.length; i++) {
    const test = line ? `${line} ${words[i]}` : words[i];
    if (ctx.measureText(test).width <= maxWidth || !line) {
      line = test;
      continue;
    }
    lines.push(line);
    line = words[i];
    if (lines.length === maxLines) {
      line = '';
      let last = lines[maxLines - 1];
      while (ctx.measureText(`${last}…`).width > maxWidth && last.length) last = last.slice(0, -1);
      lines[maxLines - 1] = `${last.trimEnd()}…`;
      break;
    }
  }
  if (line) lines.push(line);
  // A single unbroken word can still be too wide
  return lines.map((l) => {
    if (ctx.measureText(l).width <= maxWidth) return l;
    while (ctx.measureText(`${l}…`).width > maxWidth && l.length) l = l.slice(0, -1);
    return `${l}…`;
  });
}

function brandMark(ctx, x, y, size) {
  const k = size / 28;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(k, k);
  ctx.fillStyle = C.gx;
  ctx.beginPath();
  ctx.moveTo(0, 0); ctx.lineTo(21, 0); ctx.lineTo(28, 7); ctx.lineTo(28, 28); ctx.lineTo(7, 28); ctx.lineTo(0, 21);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = C.bg;
  ctx.lineWidth = 2.6;
  ctx.beginPath();
  ctx.moveTo(8, 9); ctx.lineTo(20, 9);
  ctx.moveTo(8, 14); ctx.lineTo(16, 14);
  ctx.moveTo(8, 19); ctx.lineTo(18, 19);
  ctx.stroke();
  ctx.restore();
}

export async function renderCard(r) {
  const g = r.game;
  await Promise.all([
    document.fonts.load(`900 120px ${DISPLAY}`),
    document.fonts.load(`800 40px ${DISPLAY}`),
    document.fonts.load(`600 24px ${BODY}`),
    document.fonts.load(`400 20px ${BODY}`),
  ]).catch(() => {});
  const cover = await loadImage(g.coverLarge || g.cover);

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);

  // Cover art on the right, fading into the background
  const CX = 540;
  if (cover) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(CX, 0, W - CX, H);
    ctx.clip();
    drawCover(ctx, cover, CX, 0, W - CX, H);
    ctx.restore();
  }
  let grad = ctx.createLinearGradient(CX, 0, CX + 300, 0);
  grad.addColorStop(0, C.bg);
  grad.addColorStop(1, 'rgba(9,8,12,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(CX, 0, 300, H);
  grad = ctx.createLinearGradient(0, H - 200, 0, H);
  grad.addColorStop(0, 'rgba(9,8,12,0)');
  grad.addColorStop(1, 'rgba(9,8,12,0.85)');
  ctx.fillStyle = grad;
  ctx.fillRect(CX, H - 200, W - CX, 200);

  const X = 64;
  ctx.textBaseline = 'alphabetic';

  // Brand
  brandMark(ctx, X, 50, 30);
  ctx.font = `800 30px ${DISPLAY}`;
  ctx.fillStyle = C.text;
  ctx.fillText('gx', X + 42, 76);
  ctx.fillStyle = C.gx;
  ctx.fillText('Finder', X + 42 + ctx.measureText('gx').width, 76);

  // Title + studio
  let titleSize = 78;
  ctx.font = `900 ${titleSize}px ${DISPLAY}`;
  let lines = wrap(ctx, g.title, 600, 2);
  if (lines.length > 1) {
    titleSize = 58;
    ctx.font = `900 ${titleSize}px ${DISPLAY}`;
    lines = wrap(ctx, g.title, 600, 2);
  }
  ctx.fillStyle = C.text;
  let y = lines.length > 1 ? 160 : 172;
  for (const l of lines) {
    ctx.fillText(l, X, y);
    y += titleSize * (lines.length > 1 ? 0.95 : 0.92);
  }
  if (g.studio) {
    ctx.font = `400 24px ${BODY}`;
    ctx.fillStyle = C.text2;
    const studio = wrap(ctx, `by ${g.studio.name}`, 600, 1)[0];
    ctx.fillText(studio, X, y + 2);
  }

  // Headline rank
  const plays = r.overall.find((o) => o.key === 'plays');
  const rankY = 430;
  ctx.fillStyle = C.gx;
  ctx.font = `900 64px ${DISPLAY}`;
  ctx.fillText('#', X, rankY - 70);
  const hashW = ctx.measureText('#').width + 4;
  const rankText = full(plays.rank);
  const rankSize = rankText.length > 5 ? 128 : 156;
  ctx.font = `900 ${rankSize}px ${DISPLAY}`;
  ctx.fillText(rankText, X + hashW, rankY);
  const labelX = X + hashW + ctx.measureText(rankText).width + 24;
  ctx.font = `600 25px ${BODY}`;
  ctx.fillStyle = C.text;
  ctx.fillText('Most played', labelX, rankY - 52);
  ctx.fillText('on GX.games', labelX, rankY - 20);
  ctx.font = `400 19px ${BODY}`;
  ctx.fillStyle = C.muted;
  ctx.fillText(`of ${full(plays.total)}, ${topPct(plays.rank, plays.total)}`, labelX, rankY + 6);

  // Stat row
  ctx.fillStyle = C.line;
  ctx.fillRect(X, 482, 600, 1);
  const cat = bestCategory(r);
  const stats = [
    ['Plays', compact(g.plays)],
    ['Players', compact(g.players)],
    ['Avg. session', duration(g.session)],
    cat ? [cat.title, `#${full(cat.rank)}`] : g.votes ? ['Rating', g.rating.toFixed(2)] : null,
  ].filter(Boolean);
  const widths = stats.length === 4 ? [130, 130, 190, 150] : stats.map(() => 600 / stats.length);
  let sx = X;
  stats.forEach(([label, value], i) => {
    const colW = widths[i];
    ctx.font = `400 18px ${BODY}`;
    ctx.fillStyle = C.muted;
    ctx.fillText(wrap(ctx, label, colW - 16, 1)[0], sx, 522);
    ctx.font = `800 44px ${DISPLAY}`;
    ctx.fillStyle = i === 3 && cat ? C.gx : C.text;
    ctx.fillText(value, sx, 570);
    sx += colW;
  });

  // Site, bottom right
  ctx.font = `500 18px ${BODY}`;
  ctx.fillStyle = C.text2;
  ctx.textAlign = 'right';
  ctx.fillText(location.host, W - 40, H - 34);
  ctx.textAlign = 'left';

  // Red chamfer accent in the top-right corner
  ctx.fillStyle = C.gx;
  ctx.beginPath();
  ctx.moveTo(W - 44, 0); ctx.lineTo(W, 0); ctx.lineTo(W, 44);
  ctx.closePath();
  ctx.fill();

  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

// ------------------------------------------------------------ dialog

let dialog;
function ensureDialog() {
  if (dialog) return dialog;
  dialog = document.createElement('dialog');
  dialog.className = 'share';
  dialog.setAttribute('aria-labelledby', 'share-title');
  document.body.append(dialog);
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close();
  });
  return dialog;
}

const ICONS = {
  image: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M2 12l4-4 3 3 2-2 3 3" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
  text: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4h10M3 8h10M3 12h6" stroke="currentColor" stroke-width="1.6"/></svg>',
  link: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M7 9l2-2M6 5l1.5-1.5a2.5 2.5 0 013.5 3.5L9.5 8.5M10 11l-1.5 1.5a2.5 2.5 0 01-3.5-3.5L6.5 7.5" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
  down: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2v8M4.5 7L8 10.5 11.5 7M2.5 13.5h11" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
  share: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 10V2M5 5l3-3 3 3M3 8v6h10V8" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
};

function flash(btn, msg, ok = true) {
  const label = btn.querySelector('span');
  const prev = btn.dataset.label || label.textContent;
  btn.dataset.label = prev;
  label.textContent = msg;
  btn.classList.toggle('is-done', ok);
  btn.classList.toggle('is-failed', !ok);
  clearTimeout(btn._t);
  btn._t = setTimeout(() => {
    label.textContent = prev;
    btn.classList.remove('is-done', 'is-failed');
  }, 2200);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

export function openShare(r) {
  const d = ensureDialog();
  const g = r.game;
  const text = shareText(r);
  const file = `${g.slug || g.sid}-gxfinder.png`;
  const blob = renderCard(r); // promise, started right away

  d.innerHTML = `
    <div class="share__head">
      <h2 id="share-title">Share ${esc(g.title)}</h2>
      <button class="share__close" type="button" aria-label="Close">${'<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M1 1l10 10M11 1L1 11" stroke="currentColor" stroke-width="1.8"/></svg>'}</button>
    </div>
    <div class="share__preview"><div class="sk" style="position:absolute;inset:0"></div></div>
    <div class="share__actions">
      <button class="btn btn--primary" type="button" data-act="image">${ICONS.image}<span>Copy image</span></button>
      <button class="btn" type="button" data-act="text">${ICONS.text}<span>Copy text</span></button>
      <button class="btn" type="button" data-act="link">${ICONS.link}<span>Copy link</span></button>
      <button class="btn" type="button" data-act="download">${ICONS.down}<span>Download</span></button>
      <button class="btn" type="button" data-act="native" hidden>${ICONS.share}<span>Share</span></button>
    </div>
    <details class="share__text"><summary>Text version</summary><pre>${esc(text)}</pre></details>`;

  d.querySelector('.share__close').addEventListener('click', () => d.close());

  blob.then((b) => {
    if (!b) return;
    const url = URL.createObjectURL(b);
    d.querySelector('.share__preview').innerHTML = `<img src="${url}" alt="Share card for ${esc(g.title)}" width="${W}" height="${H}">`;
    const f = new File([b], file, { type: 'image/png' });
    if (navigator.canShare?.({ files: [f] })) d.querySelector('[data-act=native]').hidden = false;
  });

  d.querySelector('.share__actions').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'image') {
      try {
        // Pass the promise straight in so Safari keeps the user gesture
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        flash(btn, 'Image copied');
      } catch {
        flash(btn, 'Use Download instead', false);
      }
    } else if (act === 'text') {
      flash(btn, (await copyText(text)) ? 'Text copied' : 'Copy failed', true);
    } else if (act === 'link') {
      flash(btn, (await copyText(pageUrl(g))) ? 'Link copied' : 'Copy failed', true);
    } else if (act === 'download') {
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(await blob), download: file });
      a.click();
      flash(btn, 'Downloaded');
    } else if (act === 'native') {
      const f = new File([await blob], file, { type: 'image/png' });
      navigator.share({ files: [f], text }).catch(() => {});
    }
  });

  d.showModal();
  d.querySelector('[data-act=image]').focus();
}
