import { icon } from './icons.js';
import { Player, SEG_NAMES, lastAt } from './player.js';
import * as lib from './library.js';
import * as sync from './sync.js';
import { mountComments, mountChat } from './social.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const app = $('#app');
const body = document.body;
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------- utilidades ----------
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 });
const big = (n, word) => { const s = nf.format(n); return /\s(mi|bi)$/.test(s) ? `${s} de ${word}` : `${s} ${word}`; }; // "1 mi de", mas "27 mil"
const views = (n) => (n ? big(n, 'visualizações') : '');
const subsCount = (n) => (n ? big(n, 'inscritos') : '');
const dur = (s) => {
  s = Math.floor(s || 0);
  if (!s) return '';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`;
};
const rtf = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'auto' });
// d: "AAAAMMDD"; ts (opcional): momento exato em ms, para os vídeos de hoje ("há 20 minutos", "há 3 horas").
const ago = (d, ts) => {
  const ms = ts ? Date.now() - ts : -1;
  if (ms >= 0 && ms < 864e5) return ms < 6e4 ? 'agora' : ms < 36e5 ? rtf.format(-Math.round(ms / 6e4), 'minute') : rtf.format(-Math.round(ms / 36e5), 'hour');
  if (!d || d.length !== 8) return '';
  const days = (Date.now() - new Date(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8))) / 864e5;
  if (days < 1) return 'hoje';
  if (days < 30) return rtf.format(-Math.round(days), 'day');
  if (days < 365) return rtf.format(-Math.round(days / 30), 'month');
  return rtf.format(-Math.round(days / 365), 'year');
};
const thumbUrl = (v) => v.thumb || `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`;
const hue = (s) => [...(s || '?')].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
// Sem foto conhecida: inicial colorida com data-cid; hydrateAvatars() troca pela foto real quando ela chega.
const avatar = (name, url, cls = '', cid = '') => url
  ? `<img class="avatar ${cls}" src="${esc(url)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
  : `<span class="avatar ${cls}" ${cid ? `data-cid="${cid}"` : ''} style="--h:${hue(name)}" aria-hidden="true">${esc((name || '?').trim().charAt(0).toUpperCase() || '?')}</span>`;

// Logo do MeuTube (cada cópia com id próprio de degradê).
let logoN = 0;
const logoMark = () => {
  const id = `lg${++logoN}`;
  return `<svg class="logo-mark" width="36" height="28" viewBox="0 0 36 28" aria-hidden="true">
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2f8cff"/><stop offset=".55" stop-color="#38c6ff"/><stop offset="1" stop-color="#8ef0ff"/></linearGradient></defs>
    <rect x="1" y="2" width="32" height="25" rx="9" fill="url(#${id})"/>
    <path class="logo-play" d="M13.6 9.6v9.8c0 .95 1.05 1.5 1.8 1l7.5-4.9c.72-.47.72-1.53 0-2l-7.5-4.9c-.75-.5-1.8.05-1.8 1z" fill="#fff"/>
    <path class="logo-spark" d="M31 .6l1.05 2.85 2.85 1.05-2.85 1.05L31 8.4l-1.05-2.85L27.1 4.5l2.85-1.05z" fill="#fff" stroke="#070b12" stroke-width=".9" stroke-linejoin="round"/>
  </svg>`;
};
const logo = () => `${logoMark()}<span class="wordmark">meu<b>tube</b></span>`;
const vf = (on) => (on ? `<span class="vf" title="Verificado">${icon('verified', 14)}</span>` : '');
const dot = (...parts) => parts.filter(Boolean).join('<span class="sep">•</span>');

// Barra vermelha de carregamento no topo (como no YouTube).
let pending = 0;
const bar = $('#loadbar');
function loading(delta) {
  pending = Math.max(0, pending + delta);
  if (pending > 0 && !bar.classList.contains('run')) {
    bar.classList.remove('done');
    void bar.offsetWidth;
    bar.classList.add('run');
  } else if (pending === 0 && bar.classList.contains('run')) {
    bar.classList.replace('run', 'done');
  }
}

// Cache no navegador: voltar para uma tela ou abrir de novo um vídeo é instantâneo (3 minutos).
const apiCache = new Map();
const CACHEABLE = /^\/api\/(search|channel|feed|video|segments|votes|chapters)\b/;
async function api(path, { fresh = false } = {}) {
  const hit = apiCache.get(path);
  if (!fresh && hit && Date.now() - hit.t < 3 * 60e3) return hit.data;
  loading(1);
  try {
    const r = await fetch(path);
    const j = await r.json().catch(() => ({ error: 'O servidor respondeu algo inesperado.' }));
    if (!r.ok) throw Object.assign(new Error(j.error || 'Algo deu errado.'), { code: j.code || '' });
    if (CACHEABLE.test(path)) {
      apiCache.set(path, { t: Date.now(), data: j });
      if (apiCache.size > 300) apiCache.delete(apiCache.keys().next().value);
    }
    return j;
  } finally {
    loading(-1);
  }
}

async function send(path, data, method = 'POST') {
  loading(1);
  try {
    const r = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: data ? JSON.stringify(data) : undefined });
    const j = await r.json().catch(() => ({ error: 'O servidor respondeu algo inesperado.' }));
    if (!r.ok) throw new Error(j.error || 'Algo deu errado.');
    return j;
  } finally {
    loading(-1);
  }
}

// Conta do YouTube conectada (o login vem do navegador escolhido; a senha nunca passa pelo site).
let account = { connected: false, browsers: [] };
let accountChannels = [];
async function loadAccount() {
  try { account = await api('/api/account'); } catch {}
  body.classList.toggle('has-account', account.connected);
  accountChannels = [];
  renderGuide();
  if (account.connected) {
    api('/api/feed?k=channels').then((c) => { accountChannels = c; renderGuide(); }).catch(() => {});
  }
  renderMe();
}
// Botão de conta no topo: sua foto do YouTube quando conectado; o ícone padrão quando não.
const ME_ICON = $('.me svg')?.outerHTML || '';
let meInfo = {}; // nome, @ e foto da conta do YouTube conectada
async function renderMe() {
  const btn = $('.me');
  if (!btn) return;
  const me = account.connected ? await fetch('/api/account/me').then((r) => r.json()).catch(() => ({})) : {};
  const changed = (me.photo || '') !== (meInfo.photo || '');
  meInfo = me;
  if (changed) renderGuide();
  if (changed && account.connected && location.hash === '#/account') accountView();
  const label = me.name ? `Conta do YouTube: ${me.name}${me.handle ? ` (${me.handle})` : ''}` : 'Conta do YouTube';
  btn.setAttribute('aria-label', label);
  btn.title = label;
  btn.classList.toggle('has-photo', Boolean(me.photo));
  btn.querySelector('svg, .me-photo')?.remove();
  btn.insertAdjacentHTML('afterbegin', me.photo
    ? `<img class="me-photo" src="${esc(me.photo)}" alt="" referrerpolicy="no-referrer" onerror="this.closest('.me').classList.remove('has-photo');this.outerHTML=${esc(JSON.stringify(ME_ICON))}">`
    : ME_ICON);
}
const allChannels = () => {
  const local = subs();
  const ids = new Set(local.map((c) => c.id));
  return [...local, ...accountChannels.filter((c) => !ids.has(c.id))];
};

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}

// ---------- dados locais (só neste navegador) ----------
const known = new Map();
const remember = (list) => list.forEach((v) => known.set(v.id, { ...known.get(v.id), ...v }));
const slim = (v) => ({ id: v.id, title: v.title, channel: v.channel, channelId: v.channelId, avatar: v.avatar, verified: v.verified, duration: v.duration, views: v.views, thumb: v.thumb, members: v.members || undefined });

const later = () => store.get('later', []);
const subs = () => store.get('subs', []);
const progress = () => store.get('progress', {});
const isLater = (id) => later().some((x) => x.id === id);
const isSub = (cid) => subs().some((x) => x.id === cid) || accountChannels.some((x) => x.id === cid);

function toggleLater(id) {
  const list = later();
  const on = !list.some((x) => x.id === id);
  store.set('later', on ? [slim(known.get(id) || { id }), ...list] : list.filter((x) => x.id !== id));
  return on;
}
function toggleSub(cid, name, pic) {
  const list = subs();
  const on = !list.some((x) => x.id === cid);
  store.set('subs', on ? [...list, { id: cid, name, avatar: pic || '' }] : list.filter((x) => x.id !== cid));
  renderGuide();
  return on;
}

// ---------- componentes ----------
function thumbBlock(v) {
  const p = progress()[v.id];
  const pct = p && p.d ? Math.min(100, (p.t / p.d) * 100) : 0;
  const saved = isLater(v.id);
  return `<div class="thumb-wrap">
    <a class="thumb" href="#/watch/${v.id}" data-watch tabindex="-1" aria-hidden="true">
      <img loading="lazy" decoding="async" src="${esc(thumbUrl(v))}" alt="" onerror="this.onerror=null;this.src='https://i.ytimg.com/vi/${v.id}/mqdefault.jpg'">
      ${v.live ? `<span class="dur live">${icon('live', 13)}AO VIVO</span>` : v.duration ? `<span class="dur">${dur(v.duration)}</span>` : ''}
      ${v.members ? `<span class="members-badge">${icon('lock', 12)}Só membros</span>` : ''}
      ${pct ? `<span class="prog"><i style="width:${pct}%"></i></span>` : ''}
    </a>
    <button class="later ${saved ? 'on' : ''}" data-later="${v.id}" aria-pressed="${saved}" aria-label="Assistir mais tarde" data-tip="${saved ? 'Salvo' : 'Assistir mais tarde'}">${icon(saved ? 'check' : 'clock', 18)}</button>
  </div>`;
}
const chanLink = (v, cls = 'meta') => v.channelId
  ? `<a class="${cls} ch" href="#/channel/${v.channelId}">${esc(v.channel)}${vf(v.verified)}</a>`
  : `<span class="${cls}">${esc(v.channel)}${vf(v.verified)}</span>`;
const chanAvatar = (v, cls = '') => v.channelId
  ? `<a class="av-link" href="#/channel/${v.channelId}" tabindex="-1" aria-hidden="true">${avatar(v.channel, v.avatar, cls, v.channelId)}</a>`
  : avatar(v.channel, v.avatar, cls);
const stagger = (i) => `style="--i:${Math.min(i, 16)}"`;
// Botão "⋯" de cada vídeo: salvar em playlist, assistir mais tarde, esconder canal, copiar link.
const moreBtn = (v) => `<button class="more rpl" data-more="${v.id}" aria-label="Mais ações" aria-haspopup="menu">${icon('more', 20)}</button>`;

function gridCard(v, i = 0) {
  return `<article class="card" data-vid="${v.id}" ${stagger(i)}>
    ${thumbBlock(v)}
    <div class="card-body">
      ${chanAvatar(v)}
      <div class="card-text">
        <a class="title" href="#/watch/${v.id}" data-watch>${esc(v.title)}</a>
        ${chanLink(v)}
        <span class="meta">${dot(v.live ? (v.views ? `${nf.format(v.views)} assistindo` : '') : views(v.views), ago(v.date, v.published))}</span>
      </div>
      ${moreBtn(v)}
    </div>
  </article>`;
}
function rowCard(v, i = 0) {
  return `<article class="row-card" data-vid="${v.id}" ${stagger(i)}>
    ${thumbBlock(v)}
    ${moreBtn(v)}
    <div class="row-text">
      <a class="title lg" href="#/watch/${v.id}" data-watch>${esc(v.title)}</a>
      <span class="meta sm">${dot(v.live ? (v.views ? `${nf.format(v.views)} assistindo` : '') : views(v.views), ago(v.date, v.published))}</span>
      ${v.channel ? `<div class="row-ch">${chanAvatar(v, 'xs')}${chanLink(v, 'meta sm')}</div>` : ''}
      ${v.description ? `<p class="snippet">${esc(v.description)}</p>` : ''}
    </div>
  </article>`;
}
function compactCard(v, i = 0) {
  return `<article class="compact" data-vid="${v.id}" ${stagger(i)}>
    ${thumbBlock(v)}
    ${moreBtn(v)}
    <div class="compact-text">
      <a class="title sm" href="#/watch/${v.id}" data-watch>${esc(v.title)}</a>
      ${chanLink(v, 'meta sm')}
      <span class="meta sm">${views(v.views)}</span>
    </div>
  </article>`;
}
function subButton(c, extra = '') {
  const on = isSub(c.id);
  return `<button class="sub-btn rpl ${on ? 'on' : ''} ${extra}" data-sub="${c.id}" data-name="${esc(c.name)}" data-avatar="${esc(c.avatar || '')}" aria-pressed="${on}">
    ${on ? `<span class="bell">${icon('bell', 18)}</span>Inscrito` : 'Inscrever-se'}</button>`;
}
function channelRow(c, i = 0) {
  return `<article class="ch-row" ${stagger(i)}>
    <a class="ch-row-av" href="#/channel/${c.id}" tabindex="-1" aria-hidden="true">${avatar(c.name, c.avatar, 'xl', c.id)}</a>
    <div class="ch-row-text">
      <a class="ch-row-name" href="#/channel/${c.id}">${esc(c.name)}${vf(c.verified)}</a>
      <span class="meta sm">${dot(esc(c.handle), subsCount(c.followers))}</span>
      ${c.description ? `<p class="snippet">${esc(c.description)}</p>` : ''}
    </div>
    ${subButton(c)}
  </article>`;
}

// Toda lista passa pelo filtro de canais e palavras bloqueados (Ajustes).
const list = (items, render, cls) => {
  items = items.filter((v) => !lib.isBlocked(v));
  remember(items);
  return `<div class="${cls}">${items.map(render).join('')}</div>`;
};
const grid = (items) => list(items, gridCard, 'grid');
const rows = (items) => list(items, rowCard, 'rows');
const compacts = (items) => list(items, compactCard, 'compacts');

const skGrid = (n = 12) => `<div class="grid" aria-busy="true">${'<div class="card sk"><div class="thumb-wrap"><div class="thumb"></div></div><div class="card-body"><span class="avatar"></span><div class="card-text"><i></i><i></i></div></div></div>'.repeat(n)}</div>`;
const skRows = (n = 6) => `<div class="rows" aria-busy="true">${'<div class="row-card sk"><div class="thumb-wrap"><div class="thumb"></div></div><div class="row-text"><i></i><i></i><i></i></div></div>'.repeat(n)}</div>`;
const skCompact = (n = 8) => `<div class="compacts" aria-busy="true">${'<div class="compact sk"><div class="thumb-wrap"><div class="thumb"></div></div><div class="compact-text"><i></i><i></i></div></div>'.repeat(n)}</div>`;
// Carregamento infinito: um "sentinela" no fim da lista busca a próxima página quando chega perto da tela.
const RENDERERS = { grid: gridCard, rows: rowCard, compacts: compactCard };
function infinite(list, load, t, { page = 1, onItems } = {}) {
  if (!list || !('IntersectionObserver' in window)) return;
  const render = RENDERERS[list.className.split(' ')[0]] || gridCard;
  const sk = list.classList.contains('grid') ? skGrid(4) : list.classList.contains('rows') ? skRows(2) : skCompact(3);
  const sentinel = document.createElement('div');
  sentinel.className = 'sentinel';
  sentinel.innerHTML = sk;
  list.after(sentinel);
  const seen = new Set($$('[data-vid]', list).map((e) => e.dataset.vid));
  let busy = false;
  let fails = 0;
  const obs = new IntersectionObserver(async ([e]) => {
    if (!e.isIntersecting || busy) return;
    if (t !== token || !sentinel.isConnected) return obs.disconnect();
    busy = true;
    try {
      const r = await load(page);
      if (t !== token) return obs.disconnect();
      fails = 0;
      page++;
      const fresh = r.items.filter((v) => !seen.has(v.id) && !lib.isBlocked(v));
      fresh.forEach((v) => seen.add(v.id));
      onItems?.(fresh);
      remember(fresh);
      list.insertAdjacentHTML('beforeend', fresh.map((v, i) => render(v, i)).join(''));
      if (!r.more || !r.items.length) {
        obs.disconnect();
        sentinel.innerHTML = `<p class="list-end">${icon('check', 16)} Você chegou ao fim</p>`;
      }
    } catch (err) {
      obs.disconnect();
      if (err.code === 'bot') {
        // Limite do YouTube no meio da rolagem: mantém o "carregando" e tenta a mesma página de novo sozinho.
        fails = Math.min(fails + 1, 5);
        setTimeout(() => { if (t === token && sentinel.isConnected) obs.observe(sentinel); }, 5000 * fails);
      } else {
        sentinel.innerHTML = `${failure(err)}<button class="pill rpl" data-retry>Tentar de novo</button>`;
        sentinel.querySelector('[data-retry]').addEventListener('click', () => { sentinel.innerHTML = sk; obs.observe(sentinel); });
      }
    } finally {
      busy = false;
    }
    // Se o sentinela continua visível (tela grande), dispara de novo.
    if (sentinel.isConnected && sentinel.querySelector('.sk')) { obs.unobserve(sentinel); obs.observe(sentinel); }
  }, { rootMargin: '0px 0px 1200px 0px' });
  obs.observe(sentinel);
}

const empty = (ic, title, text = '') => `<div class="empty">${icon(ic, 72)}<h3>${title}</h3>${text ? `<p>${text}</p>` : ''}</div>`;
// Quando o YouTube segura os pedidos, o servidor já tentou várias identidades e clientes. Aqui não aparece
// aviso de bloqueio: a tela continua "carregando" e tenta de novo sozinha, com esperas crescentes, até conseguir.
const RETRY_STEPS = [4, 8, 15, 25, 40, 60]; // segundos; depois fica tentando a cada 60 s
const retryCount = new Map(); // tela (hash) -> tentativas seguidas
const failure = (e) => e.code === 'bot'
  ? `<div class="soft-wait" role="status" data-blocked>
      <span class="sw-spin"></span>
      <div><b>Carregando…</b><span class="meta sm">O YouTube está respondendo devagar; continuo tentando sozinho.</span></div>
      <button class="pill rpl" data-retry-now>Tentar agora</button>
    </div>`
  : `<div class="alert" role="alert">${icon('alert', 22)}<div><strong>Não deu certo.</strong> ${esc(e.message)}</div></div>`;

// ---------- menu lateral ----------
const NAV = [
  { id: 'home', href: '#/', label: 'Início', ic: 'home' },
  { id: 'shorts', href: '#/shorts', label: 'Shorts', ic: 'zap' },
  { id: 'subs', href: '#/subs', label: 'Inscrições', ic: 'subs' },
];
const YOU = [
  { id: 'library', href: '#/library', label: 'Meus vídeos', ic: 'film' },
  { id: 'history', href: '#/history', label: 'Histórico', ic: 'history' },
  { id: 'later', href: '#/later', label: 'Assistir mais tarde', ic: 'clock' },
  { id: 'playlists', href: '#/playlists', label: 'Playlists', ic: 'playlist' },
];
const EXTRA = [
  { id: 'stats', href: '#/stats', label: 'Suas estatísticas', ic: 'chart' },
  { id: 'settings', href: '#/settings', label: 'Ajustes', ic: 'sliders' },
];
const navItem = (n) => `<a class="g-item rpl" data-nav="${n.id}" href="${n.href}">${icon(n.ic, 22)}<span>${n.label}</span></a>`;

function renderGuide() {
  const s = allChannels();
  const you = [...YOU, ...(account.connected ? [{ id: 'liked', href: '#/liked', label: 'Vídeos curtidos', ic: 'heart' }] : []),
    { id: 'account', href: '#/account', label: account.connected ? 'Conta do YouTube' : 'Conectar conta', ic: 'key' }];
  $('#guide').innerHTML = `
    <div class="guide-head">
      <button class="icon-btn rpl" data-menu aria-label="Fechar menu">${icon('menu', 24)}</button>
      <a class="logo" href="#/" aria-label="MeuTube, início">${logo()}</a>
    </div>
    <div class="g-section">${NAV.map(navItem).join('')}</div>
    <div class="g-section"><a class="g-title rpl" href="#/history">Você ${icon('chevron', 16)}</a>${you.map(navItem).join('')}
      ${lib.playlists().slice(0, 8).map((p) => `<a class="g-item g-pl rpl" data-nav="pl-${p.id}" href="#/playlist/${p.id}">${icon('playlist', 20)}<span>${esc(p.name)}</span></a>`).join('')}</div>
    <div class="g-section"><h3 class="g-title">Só no MeuTube</h3>${EXTRA.map(navItem).join('')}</div>
    ${s.length ? `<div class="g-section"><h3 class="g-title">Inscrições</h3>${s.map((c) => `<a class="g-item g-ch rpl" data-nav="ch-${c.id}" href="#/channel/${c.id}">${avatar(c.name, c.avatar, 'xs', c.id)}<span>${esc(c.name)}</span>${liveChannels.has(c.id) ? '<i class="g-live" title="Ao vivo agora"></i>' : ''}</a>`).join('')}</div>` : ''}
    <p class="g-foot">Sem anúncios. ${account.connected ? 'Conta do YouTube conectada.' : 'Inscrições, histórico e “assistir mais tarde” ficam salvos só neste navegador.'}</p>`;
  // Barra de baixo (celular) e atalhos da lateral: Início, Shorts, Inscrições, Meus vídeos e Mim (sua conta).
  const me = { id: 'account', href: '#/account', label: 'Mim', ic: 'user' };
  const mini = [...NAV, YOU[0], me].map((n) => `<a class="m-item rpl" data-nav="${n.id}" href="${n.href}">${n.id === 'account' && meInfo.photo ? `<img class="m-photo" src="${esc(meInfo.photo)}" alt="">` : icon(n.ic, 22)}<span>${n.label}</span></a>`).join('');
  $('#mini').innerHTML = mini;
  $('#bottom').innerHTML = mini;
  markNav();
}

function markNav() {
  const h = location.hash.slice(1) || '/';
  const parts = h.split('/');
  const section = parts[1] === 'channel' ? `ch-${parts[2]}` : parts[1] === 'playlist' ? `pl-${parts[2]}` : (parts[1] || 'home').split('?')[0];
  $$('[data-nav]').forEach((a) => {
    const on = a.dataset.nav === section;
    a.classList.toggle('on', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
}

function layout() {
  const w = innerWidth;
  const watching = body.classList.contains('watching');
  const docked = !watching && w >= 1312 && !store.get('guideCollapsed', false);
  body.classList.toggle('docked', docked);
  body.classList.toggle('mini', !watching && !docked && w >= 792);
  if (docked) body.classList.remove('drawer-open');
}
function toggleGuide() {
  if (!body.classList.contains('watching') && innerWidth >= 1312) {
    store.set('guideCollapsed', !store.get('guideCollapsed', false));
    return layout();
  }
  body.classList.toggle('drawer-open');
}

// ---------- navegação ----------
let token = 0;
let player = null;
let mini = null; // player que ficou no miniplayer depois que você saiu da página dele

function go(hash, fromEl) {
  body.classList.remove('drawer-open');
  if (hash === location.hash) return route();
  const run = () => { history.pushState(null, '', hash); route(); };
  if (!document.startViewTransition || reduced || document.hidden) return run();
  $$('.player').forEach((p) => (p.style.viewTransitionName = 'none'));
  if (fromEl) fromEl.style.viewTransitionName = 'media';
  const vt = document.startViewTransition(run);
  // Se a animação for interrompida, a navegação acontece do mesmo jeito; só ignoramos o aviso.
  vt.ready.catch(() => {});
  vt.finished.catch(() => {});
}

// Rolagem: ao voltar (botão Voltar), a página reabre onde você estava.
const scrollPos = new Map();
let lastHash = location.hash;
let fromPop = false;
function restoreScroll(y) {
  if (!y) return;
  // A lista chega em seguida; tenta algumas vezes até a página ter altura suficiente.
  [0, 120, 400, 900, 1600].forEach((ms) => setTimeout(() => {
    if (Math.abs(scrollY - y) > 4 && document.documentElement.scrollHeight - innerHeight >= y - 4) window.scrollTo({ top: y, behavior: 'instant' });
  }, ms));
}

function route() {
  const t = ++token;
  const prevHash = lastHash;
  stopShorts();
  if (document.fullscreenElement) document.exitFullscreen?.().catch?.(() => {}); // trocar de tela sai da tela cheia
  scrollPos.set(lastHash, scrollY);
  lastHash = location.hash;
  const restore = fromPop ? scrollPos.get(location.hash) : 0;
  fromPop = false;
  closePopups();
  const h = location.hash.slice(1) || '/';
  // Vídeo no miniplayer continua tocando enquanto você navega; abrir outro vídeo substitui o que estava nele.
  const watchId = h.match(/^\/watch\/([\w-]{11})/)?.[1];
  if (player?.pipWin) { closeMini(); mini = player; mini.opts.onEnded = mini.opts.onNext = null; }
  // Saiu da página do vídeo: ele continua tocando no miniplayer de baixo (como no app do YouTube).
  else if (player && watchId !== player.info.id && !player.v.ended && !h.startsWith('/shorts')) { closeMini(); mini = player; mini.opts.onEnded = mini.opts.onNext = null; showMiniBar(mini, prevHash); }
  else player?.destroy();
  player = null;
  if (mini && ((watchId && watchId !== mini.info.id) || h.startsWith('/shorts'))) closeMini();
  body.classList.toggle('watching', h.startsWith('/watch/'));
  if (!h.startsWith('/watch/')) lastPage = location.hash || '#/';
  body.classList.toggle('shorts-mode', h.startsWith('/shorts'));
  body.classList.remove('drawer-open');
  layout();
  markNav();
  window.scrollTo({ top: 0, behavior: 'instant' });
  restoreScroll(restore);
  let m;
  if ((m = h.match(/^\/watch\/([\w-]{11})/))) return watchView(m[1], t, new URLSearchParams(h.split('?')[1] || '').get('list'));
  if ((m = h.match(/^\/playlist\/(\w+)/))) return playlistView(m[1]);
  if (h === '/playlists') return playlistsView();
  if (h === '/stats') return statsView();
  if (h === '/settings') return settingsView();
  if ((m = h.match(/^\/search\/(.+)$/))) return searchView(decodeURIComponent(m[1]), t);
  if ((m = h.match(/^\/channel\/(UC[\w-]{22})/))) return channelView(m[1], t);
  if (h === '/subs') return subsView(t);
  if (h === '/shorts') return shortsView(t);
  if (h === '/library') return libraryView(t);
  if (h === '/later') return laterView(t);
  if (h === '/history') return historyView(t);
  if (h === '/liked') return likedView(t);
  if (h === '/account') return accountView();
  return homeView(t);
}

// ---------- miniplayer de baixo ----------
// Ao sair da página do vídeo, o próprio player encolhe numa barrinha acima do menu e segue tocando; tocar nela
// volta para o vídeo, sem recomeçar. O vídeo é movido de lugar na página (não é recriado), então não para.
let miniTimer = 0;
function showMiniBar(p, hash) {
  const bar = $('#minibar');
  if (!bar) return;
  bar.innerHTML = `<div class="mb-video" data-mb-open></div>
    <button class="mb-info rpl" data-mb-open><b>${esc(p.info.title)}</b><span>${esc(p.info.channel)}</span></button>
    <button class="mb-btn rpl" data-mb-toggle aria-label="Pausar">${icon('pause', 22)}</button>
    <button class="mb-btn rpl" data-mb-close aria-label="Fechar">${icon('x', 22)}</button>`;
  bar.dataset.hash = /^#\/watch\//.test(hash) ? hash : `#/watch/${p.info.id}`;
  p.root.classList.add('in-mini');
  bar.querySelector('.mb-video').append(p.root);
  bar.hidden = false;
  body.classList.add('has-minibar');
  renderMiniBar();
  clearInterval(miniTimer);
  miniTimer = setInterval(renderMiniBar, 800);
}
function renderMiniBar() {
  const b = $('[data-mb-toggle]');
  if (!b || !mini) return;
  const playing = mini.playing && !mini.v.ended;
  if (b.dataset.on === String(playing)) return;
  b.dataset.on = String(playing);
  b.innerHTML = icon(playing ? 'pause' : 'play', 22);
  b.setAttribute('aria-label', playing ? 'Pausar' : 'Tocar');
}
function hideMiniBar() {
  const bar = $('#minibar');
  clearInterval(miniTimer);
  body.classList.remove('has-minibar');
  if (!bar) return;
  bar.hidden = true;
  bar.innerHTML = '';
}
function closeMini() {
  if (!mini) return;
  mini.destroy();
  mini = null;
  hideMiniBar();
}
$('#minibar')?.addEventListener('click', (e) => {
  if (e.target.closest('[data-mb-close]')) return closeMini();
  if (e.target.closest('[data-mb-toggle]')) { mini?.toggle(); return renderMiniBar(); }
  if (e.target.closest('[data-mb-open]') && mini) { history.pushState(null, '', $('#minibar').dataset.hash); route(); }
});

// Arrastar o vídeo para baixo (no celular): a página do vídeo desce junto com o dedo e, se passar do ponto,
// vira o miniplayer de baixo e você volta para a tela anterior (como no app do YouTube).
let lastPage = '#/'; // última tela que não era um vídeo (para onde o gesto volta)
(() => {
  let drag = null;
  let quietUntil = 0;
  addEventListener('click', (ev) => { if (Date.now() < quietUntil) { ev.stopPropagation(); ev.preventDefault(); } }, true);
  const view = () => $('.view.watch');
  const reset = (animate) => {
    const v = view();
    if (!v) return;
    v.style.transition = animate ? 'transform 0.25s var(--out), opacity 0.25s' : '';
    v.style.transform = '';
    v.style.opacity = '';
  };
  app.addEventListener('touchstart', (e) => {
    if (!body.classList.contains('watching') || e.touches.length !== 1) return;
    const p = e.target.closest('.player');
    // Só pelo vídeo (não pelos controles, nem pela barra de tempo) e com a página no topo.
    if (!p || e.target.closest('.p-bar, .p-menu, .p-progress') || scrollY > 4 || document.fullscreenElement) return;
    drag = { x: e.touches[0].clientX, y: e.touches[0].clientY, dy: 0, on: false };
  }, { passive: true, capture: true });
  app.addEventListener('touchmove', (e) => {
    if (!drag) return;
    const dx = e.touches[0].clientX - drag.x;
    const dy = e.touches[0].clientY - drag.y;
    if (!drag.on) {
      if (Math.abs(dy) < 12 && Math.abs(dx) < 12) return;
      if (dy <= 0 || Math.abs(dx) > Math.abs(dy)) { drag = null; return; } // para cima ou para o lado: não é o gesto
      drag.on = true;
    }
    e.preventDefault();
    drag.dy = Math.max(0, dy);
    const v = view();
    if (v) {
      v.style.transition = 'none';
      v.style.transform = `translateY(${drag.dy}px) scale(${Math.max(0.82, 1 - drag.dy / 1600)})`;
      v.style.opacity = String(Math.max(0.35, 1 - drag.dy / 600));
    }
  }, { passive: false, capture: true });
  const end = () => {
    if (!drag) return;
    const { on, dy } = drag;
    drag = null;
    if (!on) return;
    quietUntil = Date.now() + 450; // o toque que terminou o gesto não deve pausar o vídeo
    setTimeout(() => reset(false), 400);
    if (dy > 110) {
      // Sem a animação de troca de tela: a página já desceu junto com o dedo.
      history.pushState(null, '', lastPage);
      route();
    } else reset(true);
  };
  app.addEventListener('touchend', end, true);
  app.addEventListener('touchcancel', end, true);
})();

// ---------- Meus vídeos ----------
// Tudo seu num lugar só: histórico, playlists (assistir mais tarde, curtidos e as suas) e atalhos.
function libTile(href, ic, title, sub, thumb) {
  return `<a class="lib-tile rpl" href="${href}">
    <span class="lib-cover">${thumb ? `<img src="${esc(thumb)}" alt="" loading="lazy">` : ''}<span class="lib-ic">${icon(ic, 26)}</span></span>
    <b>${esc(title)}</b>${sub ? `<span class="meta xs">${esc(sub)}</span>` : ''}</a>`;
}
const libLink = (href, ic, title, sub = '') => `<a class="lib-link rpl" href="${href}">${icon(ic, 22)}<span><b>${esc(title)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</span>${icon('chevron', 18)}</a>`;
const nVideos = (n) => `${n} ${n === 1 ? 'vídeo' : 'vídeos'}`;
function libraryView(t) {
  document.title = 'Meus vídeos - MeuTube';
  const hist = store.get('history', []).slice(0, 12);
  const lt = later();
  const pls = lib.playlists();
  app.innerHTML = `<section class="view library">
    <h2 class="lib-title enter">Meus vídeos</h2>
    <div class="lib-sec">
      <div class="lib-head"><h3>Histórico</h3><a class="rpl" href="#/history">Ver tudo</a></div>
      <div id="lib-hist">${hist.length ? rail(hist) : '<p class="meta sm">Os vídeos que você assistir aparecem aqui.</p>'}</div>
    </div>
    <div class="lib-sec">
      <div class="lib-head"><h3>Playlists</h3><a class="rpl" href="#/playlists">Ver tudo</a></div>
      <div class="lib-tiles">
        ${libTile('#/later', 'clock', 'Assistir mais tarde', nVideos(lt.length), lt[0] && thumbUrl(lt[0]))}
        ${account.connected ? libTile('#/liked', 'like', 'Vídeos com “Gostei”', 'da sua conta', '') : ''}
        ${pls.map((p) => libTile(`#/playlist/${p.id}`, 'playlist', p.name, nVideos(p.items.length), p.items[0] && thumbUrl(p.items[0]))).join('')}
        ${libTile('#/playlists', 'listPlus', 'Nova playlist', '', '')}
      </div>
    </div>
    <nav class="lib-links" aria-label="Seus vídeos">
      ${libLink('#/subs', 'subs', 'Inscrições', `${allChannels().length} canais`)}
      ${libLink('#/history', 'history', 'Histórico')}
      ${libLink('#/later', 'clock', 'Assistir mais tarde', 'Salve vídeos para ver depois')}
      ${account.connected ? libLink('#/liked', 'heart', 'Vídeos curtidos') : ''}
      ${libLink('#/playlists', 'playlist', 'Playlists', `${pls.length} ${pls.length === 1 ? 'playlist' : 'playlists'}`)}
      ${libLink('#/stats', 'chart', 'Suas estatísticas')}
    </nav>
  </section>`;
  // Com a conta conectada, o histórico vem do YouTube (inclui o que você viu em outros aparelhos).
  if (account.connected) {
    api('/api/feed?k=history').then((r) => {
      if (t !== token || !r.items?.length) return;
      remember(r.items);
      $('#lib-hist').innerHTML = rail(r.items.slice(0, 12));
    }).catch(() => {});
  }
}

// ---------- Shorts ----------
// Vídeos em pé, um por tela, passando com o dedo. Só o Short que está na tela toca (imagem e som separados,
// como no player principal, em loop).
let shortsCtl = null;
function stopShorts() {
  shortsCtl?.stop();
  shortsCtl = null;
}
const shortCard = (s) => `<article class="short" data-short="${s.id}">
  <div class="sh-stage">
    <img class="sh-poster" src="${esc(s.thumb || `https://i.ytimg.com/vi/${s.id}/oardefault.jpg`)}" alt="" loading="lazy">
    <div class="sh-tap" data-sh-toggle aria-hidden="true"></div>
    <span class="sh-state" aria-hidden="true">${icon('play', 40)}</span>
    <div class="sh-meta"><a class="sh-ch" href="#/watch/${s.id}"></a><p>${esc(s.title)}</p><span class="meta xs">${esc(s.viewsText || '')}</span></div>
    <div class="sh-side">
      <button class="sh-btn rpl" data-sh-like aria-pressed="false" aria-label="Gostei">${icon('like', 26)}<span>Gostei</span></button>
      <a class="sh-btn rpl" href="#/watch/${s.id}" aria-label="Comentários">${icon('chat', 26)}<span>Comentar</span></a>
      <button class="sh-btn rpl" data-share="${s.id}" aria-label="Compartilhar">${icon('share', 26)}<span>Partilhar</span></button>
    </div>
  </div>
</article>`;
function shortsView(t) {
  document.title = 'Shorts - MeuTube';
  app.innerHTML = `<section class="shorts" id="shorts" aria-label="Shorts"><div class="sh-end" id="sh-more"><span class="btn-spin"></span></div></section>`;
  const box = $('#shorts');
  const seen = new Set();
  let page = 0, busy = false, done = false, cur = null, v = null, a = null, stopped = false;

  async function more() {
    if (busy || done) return;
    busy = true;
    try {
      const r = await api('/api/shorts?page=' + page);
      if (t !== token) return;
      page++;
      const fresh = r.items.filter((x) => !seen.has(x.id) && !lib.isBlocked(x));
      fresh.forEach((x) => seen.add(x.id));
      $('#sh-more').insertAdjacentHTML('beforebegin', fresh.map(shortCard).join(''));
      $$('.short:not([data-obs])', box).forEach((el) => { el.dataset.obs = '1'; io.observe(el); });
      if (!r.more) { done = true; $('#sh-more').innerHTML = '<p class="meta">Você viu todos por agora.</p>'; }
    } catch (e) {
      $('#sh-more').innerHTML = failure(e);
    } finally {
      busy = false;
    }
  }

  // Para o Short anterior e toca o que está na tela.
  function release() {
    for (const m of [v, a]) { if (!m) continue; m.pause(); m.removeAttribute('src'); m.load(); m.remove(); }
    v = a = null;
    cur?.classList.remove('playing', 'paused');
  }
  async function activate(el) {
    if (el === cur || stopped) return;
    release();
    cur = el;
    const id = el.dataset.short;
    const all = $$('.short', box);
    if (all.indexOf(el) >= all.length - 3) more();
    mini?.pause();
    let info;
    try { info = await api('/api/video?id=' + id); } catch (e) { if (cur === el) toast(e.message); return; }
    if (cur !== el || stopped) return;
    el.querySelector('.sh-ch').textContent = info.channel || '';
    if (account.connected) {
      fetch('/api/vstate?id=' + id).then((r) => r.json()).then((st) => { if (st.like) setLike(el, st.like === 'LIKE'); }).catch(() => {});
    }
    // Qualidade: a melhor até 1280 de altura (Shorts são em pé: 720 x 1280).
    const q = info.qualities.find((x) => x.height <= 1280) || info.qualities[info.qualities.length - 1];
    if (!q) return;
    v = document.createElement('video');
    v.playsInline = true;
    v.loop = true;
    v.preload = 'auto';
    v.className = 'sh-video';
    v.src = q.src;
    if (info.audio) {
      const snd = (a = new Audio(info.audio));
      snd.loop = true;
      v.muted = true;
      if (window.meutubeApp) { snd.hidden = true; document.body.append(snd); }
      const vid = v; // este Short (v muda quando você passa para o próximo)
      vid.addEventListener('playing', () => { snd.currentTime = vid.currentTime; snd.play().catch(() => {}); });
      vid.addEventListener('waiting', () => snd.pause());
      vid.addEventListener('pause', () => snd.pause());
      vid.addEventListener('timeupdate', () => { if (Math.abs(snd.currentTime - vid.currentTime) > 0.4) snd.currentTime = vid.currentTime; });
    }
    el.querySelector('.sh-poster').after(v);
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({ title: info.title, artist: info.channel, artwork: [{ src: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, sizes: '480x360', type: 'image/jpeg' }] });
      navigator.mediaSession.setActionHandler('play', () => toggle(true));
      navigator.mediaSession.setActionHandler('pause', () => toggle(false));
    }
    v.play().then(() => el.classList.add('playing')).catch(() => el.classList.add('paused'));
  }
  function toggle(force) {
    if (!v || !cur) return;
    const play = force ?? v.paused;
    if (play) v.play().catch(() => {}); else v.pause();
    cur.classList.toggle('paused', !play);
    cur.classList.toggle('playing', play);
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = play ? 'playing' : 'paused';
  }
  function setLike(el, on) {
    const b = el.querySelector('[data-sh-like]');
    b.setAttribute('aria-pressed', String(on));
    b.classList.toggle('on', on);
  }

  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) activate(e.target);
  }, { root: box, threshold: 0.6 });
  const onClick = (e) => {
    const el = e.target.closest('.short');
    if (!el) return;
    if (e.target.closest('[data-sh-toggle]')) { if (el === cur) toggle(); return; }
    const like = e.target.closest('[data-sh-like]');
    if (like) {
      if (!account.connected) return toast('Conecte sua conta do YouTube (em Mim) para curtir.');
      const on = like.getAttribute('aria-pressed') !== 'true';
      setLike(el, on);
      send('/api/rate', { id: el.dataset.short, status: on ? 'LIKE' : 'INDIFFERENT' }).catch((err) => { setLike(el, !on); toast(err.message); });
    }
  };
  // Saiu do app ou apagou a tela: o Short pausa (para ouvir em segundo plano, abra o vídeo normal).
  const onHide = () => { if (document.hidden) toggle(false); };
  box.addEventListener('click', onClick);
  document.addEventListener('visibilitychange', onHide);
  shortsCtl = {
    stop() {
      stopped = true;
      io.disconnect();
      document.removeEventListener('visibilitychange', onHide);
      release();
      if ('mediaSession' in navigator) navigator.mediaSession.metadata = null;
    },
  };
  more();
}

// ---------- telas ----------
const CHIPS = ['Música', 'Podcasts', 'Games', 'Notícias', 'Ao vivo', 'Ciência', 'Tecnologia', 'Culinária', 'Esportes', 'Humor', 'Viagem', 'Documentários', 'Mixes'];

// Ao abrir o MeuTube com a conta conectada, o início sempre começa em "Para você" (depois vale o tema que você escolher).
let firstHome = true;
let recFresh = true; // a primeira lista do "Para você" desde que a página abriu vem sempre nova
function homeView(t) {
  const chips = account.connected ? ['Para você', ...CHIPS] : CHIPS;
  let active = store.get('chip', chips[0]);
  if (firstHome && account.connected) { active = 'Para você'; firstHome = false; }
  if (!chips.includes(active)) active = chips[0];
  document.title = 'MeuTube';
  $('#q').value = '';
  app.innerHTML = `<section class="view home">
    <div class="chips-bar"><div class="chips has-ind" role="tablist" aria-label="Temas"><span class="chip-ind" aria-hidden="true"></span>${chips.map((c) => `<button class="chip rpl ${c === active ? 'on' : ''}" role="tab" aria-selected="${c === active}" data-chip="${esc(c)}">${esc(c)}</button>`).join('')}</div></div>
    <div id="subs-top"></div>
    <div id="feed"></div>
  </section>`;
  loadChip(active, t);
  loadSubsTop(t);
}

// ---------- topo da tela inicial: quem você segue está ao vivo / postou vídeo novo ----------
// Conta conectada: o feed de inscrições do YouTube já vem em ordem de postagem e marca quem está ao vivo.
// Canais seguidos só no MeuTube: lives pela aba "Ao vivo" de cada canal; vídeos pelas páginas dos canais.
// "Novo" = ainda não estava na lista da última vez que você abriu o início (o YouTube não manda a data no feed).
let liveChannels = new Set();
const rail = (items) => `<div class="rail">${items.map((v, i) => gridCard(v, i)).join('')}</div>`;
async function loadSubsTop(t) {
  const box = $('#subs-top');
  const localOnly = subs().filter((c) => !accountChannels.some((a) => a.id === c.id));
  if (!box || (!account.connected && !subs().length)) return;
  const [feedR, localLive, localNews] = await Promise.all([
    account.connected ? api('/api/feed?k=subs').catch(() => null) : null,
    localOnly.length ? api('/api/live-now?ids=' + localOnly.slice(0, 12).map((c) => c.id).join(',')).catch(() => []) : [],
    !account.connected ? subsFeed().catch(() => []) : [],
  ]);
  if (t !== token || !box.isConnected) return;
  const all = [...(feedR?.items || []), ...localLive, ...localNews].filter((v) => !lib.isBlocked(v));
  const seenIds = new Set();
  const uniq = all.filter((v) => !seenIds.has(v.id) && seenIds.add(v.id));
  const lives = uniq.filter((v) => v.live);
  const news = uniq.filter((v) => !v.live).slice(0, 16);
  remember(uniq);

  const before = store.get('subsSeen', null);
  const wasSeen = new Set(before || news.map((v) => v.id)); // primeira vez: nada aparece como novo
  const fresh = news.filter((v) => !wasSeen.has(v.id));
  store.set('subsSeen', [...new Set([...news.map((v) => v.id), ...(before || [])])].slice(0, 400));

  liveChannels = new Set(lives.map((v) => v.channelId));
  renderGuide();

  box.innerHTML = `${lives.length ? `<section class="subs-sec live-sec">
      <h3 class="sec-title rail-title"><span class="live-dot" aria-hidden="true"></span>Ao vivo agora<span class="meta sm">${lives.length === 1 ? '1 canal que você segue' : `${lives.length} lives de quem você segue`}</span></h3>
      ${rail(lives)}
    </section>` : ''}
    ${news.length ? `<section class="subs-sec">
      <h3 class="sec-title rail-title">${icon('subs', 20)}Novos das suas inscrições${fresh.length ? `<span class="new-count">${fresh.length} ${fresh.length === 1 ? 'novo' : 'novos'}</span>` : ''}<a class="rail-more" href="#/subs">Ver tudo ${icon('chevron', 16)}</a></h3>
      ${rail([...fresh, ...news.filter((v) => !fresh.includes(v))])}
    </section>` : ''}`;
  fresh.forEach((v) => box.querySelector(`[data-vid="${v.id}"] .thumb`)?.insertAdjacentHTML('beforeend', '<span class="new-badge">NOVO</span>'));
}

// O YouTube repete quase os mesmos recomendados de uma vez para outra. Para cada abertura parecer nova: os vídeos
// que já apareceram no topo antes vão para o fim, e os que você ainda não viu vêm primeiro, embaralhados.
function freshFirst(items) {
  const seen = new Set(store.get('recSeen', []));
  const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const novos = shuffle(items.filter((v) => !seen.has(v.id) && !v.live));
  const out = [...items.filter((v) => v.live), ...novos, ...items.filter((v) => seen.has(v.id) && !v.live)];
  store.set('recSeen', [...out.slice(0, 16).map((v) => v.id), ...seen].slice(0, 300));
  return out;
}

async function loadChip(chip, t) {
  store.set('chip', chip);
  $$('[data-chip]').forEach((b) => {
    const on = b.dataset.chip === chip;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', String(on));
  });
  moveChipInd();
  const feed = $('#feed');
  feed.innerHTML = skGrid();
  const myLoad = ++chipLoad; // trocar de tema no meio do carregamento descarta a resposta antiga
  // Cada tema sabe buscar a página N: recomendações da conta, inscrições locais ou uma busca.
  const query = chip === 'Mixes' ? 'mix música brasileira' : chip;
  // "Ao vivo" usa o filtro de lives do YouTube: só transmissões acontecendo agora.
  const live = chip === 'Ao vivo' ? '&live=1' : '';
  const searchPage = async (p) => { const r = await api(`/api/search?ch=0&page=${p}${live}&q=${encodeURIComponent(query)}`); return { items: r.videos, more: r.more }; };
  // "Para você": ao abrir ou recarregar o MeuTube, pede recomendações novas ao YouTube (sem usar a lista guardada).
  const freshRec = chip === 'Para você' && recFresh;
  if (freshRec) recFresh = false;
  const load = chip === 'Para você' ? (p) => api(`/api/feed?k=rec&page=${p}${p === 0 && freshRec ? '&fresh=1' : ''}`)
    : searchPage;
  try {
    const r = await load(0);
    if (t !== token || myLoad !== chipLoad) return;
    if (freshRec) r.items = freshFirst(r.items);
    feed.innerHTML = r.items.length ? grid(r.items) : empty('film', 'Nada por aqui', 'Tente outro tema.');
    if (r.more) infinite($('#feed .grid'), load, t);
  } catch (e) {
    if (t === token && myLoad === chipLoad) feed.innerHTML = failure(e);
  }
}
let chipLoad = 0;

async function subsFeed() {
  const chans = subs();
  const results = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(4, chans.length) }, async () => {
    while (i < chans.length) {
      const c = chans[i++];
      results.push(await api('/api/channel?id=' + c.id).catch(() => null));
    }
  }));
  // Intercala os vídeos mais novos de cada canal.
  const lists = results.filter(Boolean).map((r) => r.videos.slice(0, 8));
  const out = [];
  for (let k = 0; k < 8; k++) for (const l of lists) if (l[k]) out.push(l[k]);
  return out;
}

let lastSearch = null;
async function searchView(term, t) {
  $('#q').value = term;
  document.title = `${term} - MeuTube`;
  const filter = 'Tudo';
  app.innerHTML = `<section class="view search-view">
    <div class="chips filters has-ind" role="tablist" aria-label="Filtros"><span class="chip-ind" aria-hidden="true"></span>${['Tudo', 'Vídeos', 'Canais'].map((c) => `<button class="chip rpl ${c === filter ? 'on' : ''}" role="tab" aria-selected="${c === filter}" data-filter="${c}">${c}</button>`).join('')}</div>
    <div id="res">${skRows()}</div>
  </section>`;
  moveChipInd();
  try {
    const r = await api('/api/search?q=' + encodeURIComponent(term));
    if (t !== token) return;
    lastSearch = { ...r, term, page: 1, t };
    renderResults('Tudo');
  } catch (e) {
    if (t === token) $('#res').innerHTML = failure(e);
  }
}

function renderResults(filter) {
  const r = lastSearch;
  if (!r || !$('#res')) return;
  $$('[data-filter]').forEach((b) => { const on = b.dataset.filter === filter; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); });
  moveChipInd();
  const chans = filter !== 'Vídeos' ? r.channels : [];
  const vids = filter !== 'Canais' ? r.videos : [];
  if (!chans.length && !vids.length) {
    $('#res').innerHTML = empty('search', 'Nenhum resultado encontrado', filter === 'Canais' ? 'Nenhum canal com esse nome.' : 'Tente outras palavras.');
    return;
  }
  $('#res').innerHTML = `${chans.length ? `<div class="ch-rows">${chans.map(channelRow).join('')}</div>${vids.length ? '<hr class="divider">' : ''}` : ''}${vids.length ? rows(vids) : ''}`;
  // Mais resultados ao rolar; as páginas novas também entram no filtro "Tudo/Vídeos".
  if (vids.length && r.more) {
    infinite($('#res .rows'), async (p) => {
      const n = await api(`/api/search?ch=0&page=${p}&q=${encodeURIComponent(r.term)}`);
      return { items: n.videos, more: n.more };
    }, r.t, { page: r.page, onItems: (items) => { r.videos.push(...items); r.page++; } });
  }
}

function linkify(text) {
  return esc(text)
    .replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`)
    .replace(/(^|\s)((?:\d{1,2}:)?\d{1,2}:\d{2})(?=\s|$)/gm, (all, pre, ts) => {
      const s = ts.split(':').reduce((acc, n) => acc * 60 + Number(n), 0);
      return `${pre}<button class="ts" data-seek="${s}">${ts}</button>`;
    })
    .replace(/(^|\s)(#[\p{L}\p{N}_]+)/gu, '$1<span class="tag">$2</span>');
}

// ---------- fila da playlist (tocando uma playlist) ----------
const queueMode = () => store.get('queueMode', { shuffle: false, loop: false });
function queueHtml(pl, id) {
  const idx = pl.items.findIndex((v) => v.id === id);
  const q = queueMode();
  return `<div class="queue" id="queue">
    <div class="q-head">
      <div><a class="q-title" href="#/playlist/${pl.id}">${esc(pl.name)}</a><span class="meta sm">${idx + 1} / ${pl.items.length}</span></div>
      <div class="q-tools">
        <button class="icon-btn rpl ${q.loop ? 'on' : ''}" data-queue="loop" aria-pressed="${q.loop}" title="Repetir a playlist">${icon('repeat', 18)}</button>
        <button class="icon-btn rpl ${q.shuffle ? 'on' : ''}" data-queue="shuffle" aria-pressed="${q.shuffle}" title="Ordem aleatória">${icon('shuffle', 18)}</button>
      </div>
    </div>
    <div class="q-list">${pl.items.map((v, i) => `<a class="q-item ${v.id === id ? 'on' : ''}" href="#/watch/${v.id}?list=${pl.id}">
      <span class="q-n">${v.id === id ? icon('play', 12) : i + 1}</span>
      <img src="${esc(thumbUrl(v))}" alt="" loading="lazy"><span class="q-text"><b>${esc(v.title)}</b><span class="meta xs">${esc(v.channel)}</span></span></a>`).join('')}</div>
  </div>`;
}
function queueNext(pl, id) {
  const items = pl.items;
  if (!items.length) return null;
  const q = queueMode();
  const idx = items.findIndex((v) => v.id === id);
  if (q.shuffle) {
    const others = items.filter((v) => v.id !== id);
    return others.length ? others[Math.floor(Math.random() * others.length)] : null;
  }
  if (idx + 1 < items.length) return items[idx + 1];
  return q.loop ? items[0] : null;
}

// ---------- momentos marcados ----------
function renderMarks(id) {
  const box = $('#w-marks');
  if (!box) return;
  const list = lib.marks(id);
  player?.setMarks(list);
  box.innerHTML = list.length ? `<div class="marks">
    <h3 class="sec-title sm">${icon('bookmark', 18)}Seus momentos <span class="meta sm">aparecem como pontinhos na barra do vídeo</span></h3>
    ${list.map((mk, i) => `<div class="mark" style="--i:${i}">
      <button class="ts mark-t" data-seek="${mk.t}">${dur(mk.t) || '0:00'}</button>
      <input class="mark-note" data-mark-note="${i}" value="${esc(mk.note)}" placeholder="Escreva uma nota (opcional)" aria-label="Nota do momento ${dur(mk.t)}">
      <button class="icon-btn rpl" data-mark-del="${i}" aria-label="Apagar momento">${icon('trash', 16)}</button>
    </div>`).join('')}</div>` : '';
}

// ---------- transcrição: todas as falas do vídeo, para ler, buscar uma palavra e pular para o trecho ----------
// Busca sem acento e sem maiúsculas ("acao" acha "Ação"); "at" guarda de que letra do texto veio cada letra da versão simplificada.
function fold(s) {
  let n = '';
  const at = [];
  for (let i = 0; i < s.length; i++) for (const c of s[i].normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()) { n += c; at.push(i); }
  return { n, at };
}
function highlight(text, q) {
  if (!q) return esc(text);
  const { n, at } = fold(text);
  let out = '', last = 0;
  for (let k = n.indexOf(q); k >= 0; k = n.indexOf(q, k + q.length)) {
    const a = at[k], b = at[k + q.length - 1] + 1;
    out += esc(text.slice(last, a)) + `<mark>${esc(text.slice(a, b))}</mark>`;
    last = b;
  }
  return out + esc(text.slice(last));
}
// Em tela estreita a lateral fica no fim da página (depois dos comentários): o painel vai para logo abaixo do vídeo.
function placePanel(box) {
  if (matchMedia('(max-width: 1100px)').matches) $('#w-row')?.after(box);
  requestAnimationFrame(() => box.scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' }));
}
async function openTranscript() {
  const box = $('#w-transcript');
  const btn = $('[data-transcript]');
  if (!box || !player?.info.subtitles?.length) return;
  const t = token;
  const info = player.info;
  if (box.firstChild) { box.innerHTML = ''; btn?.setAttribute('aria-pressed', 'false'); return; }
  btn?.setAttribute('aria-pressed', 'true');
  const tracks = info.subtitles;
  const pick = player.subKey || (tracks.find((s) => /^pt/.test(s.lang)) || tracks[0]).key;
  box.innerHTML = `<section class="transcript" aria-label="Transcrição do vídeo">
    <div class="tr-head"><h3>${icon('transcript', 18)}Transcrição</h3><button class="icon-btn rpl" data-tr-close aria-label="Fechar transcrição">${icon('x', 18)}</button></div>
    <div class="tr-tools">
      <label class="tr-search">${icon('search', 16)}<input type="search" placeholder="Buscar no que é falado…" aria-label="Buscar na transcrição"></label>
      ${tracks.length > 1 ? `<select aria-label="Idioma da transcrição">${tracks.map((s) => `<option value="${esc(s.key)}" ${s.key === pick ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}</select>` : ''}
    </div>
    <p class="tr-count meta xs" aria-live="polite"></p>
    <div class="tr-list"></div>
  </section>`;
  placePanel(box);
  const list = box.querySelector('.tr-list');
  const input = box.querySelector('input');
  const count = box.querySelector('.tr-count');
  let cues = [];
  let lines = [];
  let cur = -1;

  const load = async (key) => {
    list.innerHTML = '<div class="tr-wait"><span class="sw-spin"></span>Carregando as falas…</div>';
    cues = [];
    try { cues = await player.cues(key); } catch (e) { if (t === token) list.innerHTML = failure(e); return; }
    if (t !== token || !list.isConnected) return;
    list.innerHTML = cues.map((c, i) => `<button class="tr-line" data-cue="${i}"><span class="tr-t">${dur(c.s) || '0:00'}</span><span class="tr-x">${esc(c.t.replace(/\n/g, ' '))}</span></button>`).join('');
    lines = [...list.children];
    cur = -1;
    filter();
  };
  const filter = () => {
    const q = fold(input.value.trim()).n;
    let hits = 0;
    lines.forEach((el, i) => {
      const text = cues[i].t.replace(/\n/g, ' ');
      const ok = !q || fold(text).n.includes(q);
      el.hidden = !ok;
      if (ok) hits++;
      el.lastElementChild.innerHTML = highlight(text, q);
    });
    count.textContent = q ? (hits ? `${hits} ${hits === 1 ? 'trecho' : 'trechos'} com “${input.value.trim()}”` : 'Nada encontrado nesse idioma') : '';
  };
  let typing;
  input.addEventListener('input', () => { clearTimeout(typing); typing = setTimeout(filter, 120); });
  box.querySelector('select')?.addEventListener('change', (e) => load(e.target.value));
  box.addEventListener('click', (e) => {
    if (e.target.closest('[data-tr-close]')) { box.innerHTML = ''; btn?.setAttribute('aria-pressed', 'false'); return; }
    const line = e.target.closest('[data-cue]');
    if (!line || !player) return;
    player.seek(cues[Number(line.dataset.cue)].s);
    player.play();
  });
  // Acompanha o vídeo: destaca a fala atual e rola a lista até ela (menos enquanto você busca ou passa o mouse).
  const follow = setInterval(() => {
    if (!list.isConnected || t !== token) return clearInterval(follow);
    if (!cues.length || !player) return;
    const i = lastAt(cues, player.now);
    if (i === cur) return;
    lines[cur]?.classList.remove('on');
    cur = i;
    const el = lines[i];
    if (!el) return;
    el.classList.add('on');
    if (!input.value && !list.matches(':hover') && !el.hidden) list.scrollTo({ top: el.offsetTop - list.clientHeight / 3, behavior: reduced ? 'auto' : 'smooth' });
  }, 400);
  await load(pick);
}

// ---------- IA: perguntas sobre o vídeo (o servidor pergunta ao Codex CLI, com a sua conta do ChatGPT) ----------
// Markdown simples da resposta: negrito, código, listas e títulos; [4:05] vira um botão que pula para o momento.
function aiHtml(text) {
  const inline = (s) => esc(s)
    .replace(/\[([^\]]+)\]\((#\/[^\s)]+|https?:\/\/[^\s)]+)\)/g, (all, label, url) => (url.startsWith('#') ? `<a href="${url}">${label}</a>` : `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`))
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*\w])\*(?!\s)([^*]+?)\*(?!\w)/g, '$1<i>$2</i>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[((?:\d{1,2}:)?\d{1,2}:\d{2})\]/g, (all, ts) => `<button class="ts" data-seek="${ts.split(':').reduce((a, n) => a * 60 + Number(n), 0)}">${ts}</button>`);
  const blocks = [];
  let list = null;
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    const li = /^([-*•]|\d+[.)])\s+(.*)/.exec(line);
    if (li) {
      const tag = /\d/.test(li[1]) ? 'ol' : 'ul';
      if (!list || list.tag !== tag) blocks.push((list = { tag, items: [] }));
      list.items.push(inline(li[2]));
      continue;
    }
    list = null;
    if (!line) continue;
    const h = /^#{1,4}\s+(.*)/.exec(line);
    blocks.push(h ? `<p class="ai-h">${inline(h[1])}</p>` : `<p>${inline(line)}</p>`);
  }
  return blocks.map((b) => (typeof b === 'string' ? b : `<${b.tag}>${b.items.map((i) => `<li>${i}</li>`).join('')}</${b.tag}>`)).join('');
}
// A IA é uma gaveta do site todo: continua aberta enquanto você (ou ela) navega. A conversa fica até recarregar a página.
const aiChat = []; // [{ q, imgs, frameAt, a | err, status }]
let aiInfo = null; // { ok, error, models: [{ id, name, efforts }], model, effort } (o que o Codex da sua conta oferece)
let aiPending = []; // imagens anexadas esperando a próxima pergunta (data URLs)
let aiBusy = null; // pergunta em andamento (AbortController)
const EFFORTS = { none: 'Nenhum', minimal: 'Mínimo', low: 'Baixo', medium: 'Médio', high: 'Alto', xhigh: 'Muito alto', max: 'Máximo', ultra: 'Ultra' };
const AI_SUGGEST_VIDEO = ['Resuma o vídeo', 'O que está acontecendo agora?', 'Quais são os pontos principais?', 'Me recomende vídeos parecidos'];
const AI_SUGGEST = ['O que tem de novo nas minhas inscrições?', 'Me recomende vídeos de ciência', 'Busque lives de jogos acontecendo agora', 'Abra um vídeo de receita rápida'];
const aiVideo = () => player || mini; // o vídeo da página ou o do miniplayer
const aiDrawer = $('#ai-drawer');
if (window.meutubeApp) $('.ai-top').forEach((b) => b.remove()); // no celular não tem Codex

function aiToggle(open = aiDrawer.hidden) {
  aiDrawer.hidden = !open;
  body.classList.toggle('ai-open', open);
  $$('[data-ai]').forEach((b) => b.setAttribute('aria-pressed', String(open)));
  if (!open) return;
  if (!aiDrawer.firstChild) aiBuild();
  aiRender();
  aiDrawer.querySelector('textarea').focus({ preventScroll: true });
  if (!aiInfo?.ok) {
    fetch('/api/ai').then((r) => r.json()).catch(() => ({ ok: false, error: 'O servidor do MeuTube não respondeu. Ele precisa estar rodando a versão nova (reinicie o servidor).' }))
      .then((st) => { aiInfo = st; aiBuildOptions(); aiRender(); });
  }
}

function aiBuild() {
  aiDrawer.classList.toggle('wide', store.get('aiWide', false));
  aiDrawer.innerHTML = `
    <div class="ai-head">
      <h3>${icon('sparkles', 18)}IA <span class="meta xs">Codex · sua conta do ChatGPT</span></h3>
      <button class="icon-btn rpl" data-ai-new title="Nova conversa" aria-label="Nova conversa">${icon('edit', 18)}</button>
      <button class="icon-btn rpl" data-ai-wide title="Aumentar ou diminuir" aria-label="Aumentar ou diminuir o painel">${icon('maximize', 18)}</button>
      <button class="icon-btn rpl" data-ai-close title="Fechar" aria-label="Fechar a IA">${icon('x', 18)}</button>
    </div>
    <div class="ai-opts">
      <label><span>Modelo</span><select data-ai-model aria-label="Modelo"></select></label>
      <label><span>Esforço</span><select data-ai-effort aria-label="Esforço de raciocínio"></select></label>
    </div>
    <div class="ai-ctx meta xs"></div>
    <div class="ai-log" aria-live="polite"></div>
    <form class="ai-form">
      <div class="ai-attach"></div>
      <div class="ai-tools">
        <button type="button" class="ai-tool" data-ai-frame title="Manda junto o que está na tela do vídeo agora">${icon('camera', 16)}Tela</button>
        <label class="ai-tool" title="Anexar imagem (também dá para colar com Ctrl+V ou arrastar)">${icon('image', 16)}Imagem<input type="file" accept="image/*" multiple hidden></label>
        <span class="ai-hint">${icon('globe', 14)}pesquisa na web e mexe no MeuTube</span>
      </div>
      <div class="ai-row">
        <textarea rows="1" maxlength="4000" placeholder="Pergunte ou peça qualquer coisa…" aria-label="Sua mensagem para a IA"></textarea>
        <button class="ai-send rpl" aria-label="Enviar">${icon('send', 18)}</button>
      </div>
    </form>`;
  const ta = aiDrawer.querySelector('textarea');
  const form = aiDrawer.querySelector('form');
  form.addEventListener('submit', (e) => { e.preventDefault(); aiBusy ? aiBusy.abort() : aiAsk(ta.value); });
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!aiBusy) aiAsk(ta.value); } });
  ta.addEventListener('input', () => { ta.style.height = ''; ta.style.height = `${Math.min(ta.scrollHeight, 180)}px`; });
  ta.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (files.length) { e.preventDefault(); aiAttach(files); }
  });
  aiDrawer.addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); aiDrawer.classList.add('drop'); } });
  aiDrawer.addEventListener('dragleave', (e) => { if (!aiDrawer.contains(e.relatedTarget)) aiDrawer.classList.remove('drop'); });
  aiDrawer.addEventListener('drop', (e) => { e.preventDefault(); aiDrawer.classList.remove('drop'); aiAttach([...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'))); });
  aiDrawer.querySelector('input[type=file]').addEventListener('change', (e) => { aiAttach([...e.target.files]); e.target.value = ''; });
  aiDrawer.addEventListener('change', (e) => {
    if (e.target.matches('[data-ai-model]')) { store.set('aiModel', e.target.value); aiBuildOptions(); }
    if (e.target.matches('[data-ai-effort]')) store.set('aiEffort', e.target.value);
  });
  aiDrawer.addEventListener('click', (e) => {
    const b = e.target.closest('button, a');
    if (!b) return;
    if (b.matches('[data-ai-close]')) return aiToggle(false);
    if (b.matches('[data-ai-wide]')) { store.set('aiWide', aiDrawer.classList.toggle('wide')); return; }
    if (b.matches('[data-ai-new]')) { aiBusy?.abort(); aiChat.length = 0; aiPending = []; return aiRender(); }
    if (b.matches('[data-ai-frame]')) { store.set('aiFrame', !store.get('aiFrame', true)); return aiRender(); }
    if (b.dataset.aiUnattach) { aiPending.splice(Number(b.dataset.aiUnattach), 1); return aiRender(); }
    if (b.dataset.ask) return aiAsk(b.dataset.ask);
    // Na tela estreita a gaveta cobre o site: ao abrir um link de vídeo/página da resposta, ela sai da frente.
    if (b.matches('a[href^="#/"]') && innerWidth < 1100) aiToggle(false);
  });
}

// Modelos e esforços que a sua conta oferece (o padrão é o do seu config.toml do Codex).
function aiBuildOptions() {
  const ms = aiDrawer.querySelector('[data-ai-model]');
  const es = aiDrawer.querySelector('[data-ai-effort]');
  if (!ms || !aiInfo) return;
  const models = aiInfo.models || [];
  const model = models.find((m) => m.id === store.get('aiModel', '')) || models.find((m) => m.id === aiInfo.model) || models[0];
  ms.innerHTML = models.length ? models.map((m) => `<option value="${esc(m.id)}" ${m === model ? 'selected' : ''}>${esc(m.name)}${m.id === aiInfo.model ? ' (padrão)' : ''}</option>`).join('') : '<option value="">Padrão do Codex</option>';
  const efforts = model?.efforts?.length ? model.efforts : ['low', 'medium', 'high'];
  const want = store.get('aiEffort', 'low');
  const effort = efforts.includes(want) ? want : efforts.includes('low') ? 'low' : efforts[0];
  es.innerHTML = efforts.map((x) => `<option value="${x}" ${x === effort ? 'selected' : ''}>${EFFORTS[x] || x}${x === 'low' ? ' (mais rápido)' : ''}</option>`).join('');
}

// Linha do contexto ("Vendo: … · 4:05"): acompanha a navegação e o vídeo sem redesenhar a conversa.
function aiCtx() {
  if (aiDrawer.hidden || !aiDrawer.firstChild) return;
  const v = aiVideo();
  aiDrawer.querySelector('.ai-ctx').innerHTML = v
    ? `${icon('video', 14)}<span>Vendo: <b>${esc(v.info.title)}</b>${v.info.live ? ' · ao vivo' : ` · ${dur(v.now) || '0:00'}`}</span>`
    : `${icon('home', 14)}<span>${esc(document.title.replace(/ - MeuTube$/, '') || 'MeuTube')}</span>`;
  const fb = aiDrawer.querySelector('[data-ai-frame]');
  fb.setAttribute('aria-pressed', String(store.get('aiFrame', true)));
  fb.hidden = !v;
}
function aiRender() {
  if (aiDrawer.hidden || !aiDrawer.firstChild) return;
  const log = aiDrawer.querySelector('.ai-log');
  const v = aiVideo();
  aiCtx();
  aiDrawer.querySelector('.ai-attach').innerHTML = aiPending.map((src, i) => `<span class="ai-thumb"><img src="${src}" alt=""><button type="button" data-ai-unattach="${i}" aria-label="Tirar imagem">${icon('x', 12)}</button></span>`).join('');
  const send = aiDrawer.querySelector('.ai-send');
  send.innerHTML = icon(aiBusy ? 'x' : 'send', 18);
  send.setAttribute('aria-label', aiBusy ? 'Parar a resposta' : 'Enviar');
  send.classList.toggle('stop', Boolean(aiBusy));
  const blocked = aiInfo && !aiInfo.ok ? aiInfo.error : '';
  log.innerHTML = aiChat.length
    ? aiChat.map((m) => `<div class="ai-q">${m.imgs?.length ? `<div class="ai-q-imgs">${m.imgs.map((s) => `<img src="${s}" alt="">`).join('')}</div>` : ''}${m.frameAt != null ? `<span class="ai-q-tag">${icon('camera', 12)}tela em ${m.frameAt}</span>` : ''}${esc(m.q)}</div>
      ${m.a ? `<div class="ai-a">${aiHtml(m.a)}</div>`
        : m.err ? `<div class="ai-a ai-err">${icon('alert', 16)}<span>${esc(m.err)}</span></div>`
          : `<div class="ai-a ai-wait"><span class="ai-dots"><i></i><i></i><i></i></span><span>${esc(m.status || 'Pensando…')}</span></div>`}`).join('')
    : `<div class="ai-empty">
        <p>Pergunte sobre o vídeo, peça para buscar e abrir vídeos, controlar o player, salvar em playlists ou pesquisar na web. A IA vê a transcrição, os comentários, o chat da live, a tela do vídeo e as imagens que você mandar.</p>
        ${blocked ? `<div class="alert">${icon('alert', 20)}<div>${esc(blocked)}</div></div>` : `<div class="ai-chips">${(v ? AI_SUGGEST_VIDEO : AI_SUGGEST).map((s) => `<button type="button" class="chip" data-ask="${esc(s)}">${esc(s)}</button>`).join('')}</div>`}
      </div>`;
  log.scrollTop = log.scrollHeight;
}
setInterval(aiCtx, 2000);
addEventListener('hashchange', () => setTimeout(() => { aiCtx(); if (!aiChat.length) aiRender(); }, 600));

// Imagens anexadas: diminuídas no navegador (até 1600 px, JPEG) para irem rápido.
async function aiShrink(file, max = 1600) {
  const bmp = await createImageBitmap(file);
  const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * s);
  c.height = Math.round(bmp.height * s);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.86);
}
async function aiAttach(files) {
  for (const f of files.slice(0, 4 - aiPending.length)) { try { aiPending.push(await aiShrink(f)); } catch {} }
  if (files.length > 4) toast('Até 4 imagens por pergunta');
  aiRender();
}
// O quadro que está na tela agora (o vídeo passa pelo próprio servidor, então o navegador deixa copiar a imagem).
function aiFrame() {
  const v = aiVideo();
  if (!v || v.audioOnly || !v.v.videoWidth) return null;
  const s = Math.min(1, 1280 / v.v.videoWidth);
  const c = document.createElement('canvas');
  c.width = Math.round(v.v.videoWidth * s);
  c.height = Math.round(v.v.videoHeight * s);
  try { c.getContext('2d').drawImage(v.v, 0, 0, c.width, c.height); return c.toDataURL('image/jpeg', 0.85); } catch { return null; }
}

async function aiAsk(q) {
  q = q.trim();
  if (!q || aiBusy || (aiInfo && !aiInfo.ok)) return;
  const ta = aiDrawer.querySelector('textarea');
  const v = aiVideo();
  const frame = store.get('aiFrame', true) ? aiFrame() : null;
  const turn = { q, imgs: aiPending, frameAt: frame ? (v.info.live ? 'ao vivo' : dur(v.now) || '0:00') : null, status: '' };
  const history = aiChat.filter((m) => m.a).slice(-8).map((m) => ({ q: m.q, a: m.a }));
  aiChat.push(turn);
  aiPending = [];
  ta.value = '';
  ta.style.height = '';
  aiBusy = new AbortController();
  aiRender();
  loading(1);
  try {
    const r = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: aiBusy.signal,
      body: JSON.stringify({
        q, history, id: v?.info.id || '', at: v && !v.info.live ? v.now : null, frame, images: turn.imgs,
        page: `${document.title.replace(/ - MeuTube$/, '')} (${location.hash || '#/'})`,
        model: aiDrawer.querySelector('[data-ai-model]')?.value || '', effort: aiDrawer.querySelector('[data-ai-effort]')?.value || '',
      }),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'O servidor não aceitou a pergunta.');
    // Resposta em partes: o andamento, as ações no site e, no fim, a resposta.
    const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === 'status') { turn.status = ev.text; aiRender(); }
        if (ev.type === 'action') aiDo(ev.action).catch((e) => `Não deu: ${e.message}`).then((result) => send('/api/ai/act-result', { actionId: ev.actionId, result }).catch(() => {}));
        if (ev.type === 'answer') turn.a = ev.answer;
        if (ev.type === 'error') turn.err = ev.error;
      }
    }
    if (!turn.a && !turn.err) turn.err = 'A conexão com o servidor caiu antes da resposta.';
  } catch (e) {
    turn.err = e.name === 'AbortError' ? 'Você parou a resposta.' : e.message;
  } finally {
    loading(-1);
    aiBusy = null;
    aiRender();
  }
}

// ---------- ações que a IA pede no site ----------
const AI_PAGES = { inicio: '#/', inscricoes: '#/subs', shorts: '#/shorts', historico: '#/history', assistir_mais_tarde: '#/later', curtidos: '#/liked', playlists: '#/playlists', estatisticas: '#/stats', ajustes: '#/settings', meus_videos: '#/library' };
const findPlaylist = (name) => lib.playlists().find((p) => p.name.toLowerCase() === String(name || '').trim().toLowerCase());
const waitFor = async (test, ms = 20000) => { for (let t = 0; t < ms && !test(); t += 250) await new Promise((r) => setTimeout(r, 250)); return test(); };
async function aiVideoInfo(id) {
  if (!known.get(id)?.title) { try { known.set(id, { ...known.get(id), ...slim(await api('/api/video?id=' + id)) }); } catch {} }
  return known.get(id) || { id };
}
async function aiDo(a) {
  if (a.kind === 'open_video') {
    if (!/^[\w-]{11}$/.test(a.id || '')) return 'Código de vídeo inválido.';
    go(`#/watch/${a.id}`);
    if (!(await waitFor(() => player?.info.id === a.id))) return 'Abri a página do vídeo, mas ele ainda está carregando.';
    if (a.start > 0) { player.seek(a.start); player.play(); }
    return `Vídeo aberto e tocando${a.start > 0 ? ` a partir de ${dur(a.start)}` : ''}: ${player.info.title}`;
  }
  if (a.kind === 'open_page') {
    let hash = AI_PAGES[a.page];
    if (a.page === 'busca') hash = a.query ? `#/search/${encodeURIComponent(a.query)}` : '';
    if (a.page === 'canal') hash = /^UC[\w-]{22}$/.test(a.channelId || '') ? `#/channel/${a.channelId}` : '';
    if (a.page === 'playlist') { const p = findPlaylist(a.playlist); hash = p ? `#/playlist/${p.id}` : ''; if (!p) return `Não existe playlist chamada "${a.playlist}". Existentes: ${lib.playlists().map((x) => x.name).join(', ') || 'nenhuma'}.`; }
    if (!hash) return 'Faltou dizer o que abrir.';
    go(hash);
    return `Página aberta: ${a.page}${a.query ? ` (${a.query})` : ''}.`;
  }
  if (a.kind === 'player') {
    const p = aiVideo();
    if (!p) return 'Nenhum vídeo aberto agora.';
    const n = Number(a.value);
    const acts = {
      tocar: () => p.play(), pausar: () => p.pause(),
      pular_para: () => p.seek(n || 0), avancar: () => p.seek(p.now + (n || 10)), voltar: () => p.seek(p.now - (n || 10)),
      velocidade: () => p.setRate(Math.min(3, Math.max(0.25, n || 1))),
      legendas_ligar: () => { if (!p.subKey && p.subs.length) p.toggleSubs(); },
      legendas_desligar: () => p.setSubs(null),
      tela_cheia: () => p.fullscreen(),
      proximo: () => p.opts.onNext?.(),
    };
    if (!acts[a.action]) return 'Ação de player desconhecida.';
    acts[a.action]();
    if (a.action === 'legendas_ligar' && !p.subs.length) return 'Este vídeo não tem legendas.';
    return `Feito (${a.action}). O vídeo está em ${dur(p.now) || '0:00'}${p.playing ? ', tocando' : ', pausado'}.`;
  }
  if (a.kind === 'save') {
    if (!/^[\w-]{11}$/.test(a.id || '')) return 'Código de vídeo inválido.';
    const v = await aiVideoInfo(a.id);
    if (/^assistir|later/i.test(a.where || '')) { if (!isLater(a.id)) toggleLater(a.id); toast('Salvo em Assistir mais tarde'); return 'Salvo em Assistir mais tarde.'; }
    const p = findPlaylist(a.where) || lib.createPlaylist(a.where);
    lib.addToPlaylist(p.id, v);
    renderGuide();
    toast(`Salvo em ${p.name}`);
    return `Salvo na playlist "${p.name}".`;
  }
  if (a.kind === 'library') {
    const short = (v) => ({ id: v.id, titulo: v.title, canal: v.channel });
    return {
      playlists: lib.playlists().map((p) => ({ nome: p.name, videos: p.items.slice(0, 60).map(short) })),
      assistir_mais_tarde: later().slice(0, 60).map(short),
      historico_recente: store.get('history', []).slice(0, 40).map(short),
      canais_inscritos: allChannels().map((c) => ({ id: c.id, nome: c.name })),
      conta_do_youtube_conectada: account.connected,
    };
  }
  return 'Ação desconhecida.';
}

async function watchView(id, t, listId) {
  const m = known.get(id) || {};
  const pl = listId ? lib.getPlaylist(listId) : null;
  const autoplay = store.get('autoplay', true);
  document.title = m.title ? `${m.title} - MeuTube` : 'MeuTube';
  app.innerHTML = `<section class="view watch">
    <div class="w-main">
      <div class="ambient" aria-hidden="true"><img src="https://i.ytimg.com/vi/${id}/mqdefault.jpg" alt=""></div>
      <div class="player loading" id="player" style="view-transition-name:media">
        <img class="poster" src="https://i.ytimg.com/vi/${id}/maxresdefault.jpg" alt="" onerror="this.onerror=null;this.src='https://i.ytimg.com/vi/${id}/hqdefault.jpg'">
        <div class="p-spin" aria-hidden="true"></div>
      </div>
      <h1 class="w-title enter" style="--d:120ms">${m.title ? esc(m.title) : '<i class="sk-line"></i>'}</h1>
      <div class="w-row enter" style="--d:200ms" id="w-row"></div>
      <div id="w-desc" class="enter" style="--d:280ms"></div>
      <div id="w-marks"></div>
      <div id="w-comments"></div>
    </div>
    <aside class="w-side enter" style="--d:160ms">
      <div id="w-transcript"></div>
      <div id="w-chat"></div>
      ${pl ? queueHtml(pl, id) : ''}
      <div class="side-head">
        <div class="chips small"><button class="chip on">A seguir</button>${m.channel ? `<span class="chip ghost">De ${esc(m.channel)}</span>` : ''}</div>
        <label class="switch" title="Reprodução automática"><input type="checkbox" id="autoplay" ${autoplay ? 'checked' : ''}><span>Automático</span></label>
      </div>
      <div id="related">${skCompact()}</div>
    </aside>
  </section>`;
  $('#autoplay').addEventListener('change', (e) => store.set('autoplay', e.target.checked));

  let info;
  try {
    info = await api('/api/video?id=' + id);
  } catch (e) {
    if (t !== token) return;
    $('#player').classList.remove('loading');
    $('#w-desc').innerHTML = failure(e);
    $('#related').innerHTML = '';
    return;
  }
  if (t !== token) return;

  const ch = { id: info.channelId, name: info.channel, avatar: info.avatar || m.avatar || '', verified: info.verified };
  known.set(id, { ...m, ...slim(info), avatar: ch.avatar, thumb: m.thumb });
  document.title = `${info.title} - MeuTube`;
  $('.w-title').textContent = info.title;
  if (lib.settings().dearrow && lib.settings().dearrowTitles) {
    loadBranding([id]).then(() => {
      const b = brandCache.get(id);
      const h = $('.w-title');
      if (t !== token || !b?.title || !h) return;
      h.textContent = b.title;
      h.title = `Título original: ${info.title}`;
    });
  }
  $('#w-row').innerHTML = `
    <div class="w-owner">
      ${info.channelId ? `<a href="#/channel/${info.channelId}" class="av-link" id="w-av" tabindex="-1" aria-hidden="true">${avatar(ch.name, ch.avatar, 'md', ch.id)}</a>` : avatar(ch.name, ch.avatar, 'md')}
      <div class="w-owner-text"><a class="ch-name" href="#/channel/${info.channelId}">${esc(info.channel)}${vf(info.verified)}</a>
      <span class="meta xs" id="w-subs">${subsCount(info.followers)}</span></div>
      ${info.channelId ? subButton(ch) : ''}
    </div>
    <div class="w-actions">
      <span class="pill votes rate" id="w-votes" data-like="INDIFFERENT">
        <button class="rate-btn rpl" data-rate="LIKE" aria-pressed="false" title="Gostei">${icon('like', 20)}<b id="w-likes">${info.likes ? nf.format(info.likes) : 'Gostei'}</b></button>
        <i class="v-sep"></i>
        <button class="rate-btn rpl" data-rate="DISLIKE" aria-pressed="false" title="Não gostei">${icon('dislike', 20)}<b id="w-dislikes"></b></button>
        <span class="v-bar" hidden><i></i></span>
      </span>
      ${info.live ? '' : `<button class="pill rpl" data-bg aria-pressed="false">${icon('headphones', 20)}<span class="pl-long">Ouvir em segundo plano</span><span class="pl-short">Segundo plano</span></button>`}
      ${IN_APP ? '' : `<button class="pill rpl ai-pill" data-ai aria-pressed="false" title="Perguntas sobre o vídeo, respondidas pelo Codex com a sua conta do ChatGPT">${icon('sparkles', 20)}<span>Perguntar à IA</span></button>`}
      <button class="pill rpl" data-goto-comments>${icon('chat', 20)}<span>Comentários</span></button>
      ${info.subtitles?.length ? `<button class="pill rpl" data-transcript aria-pressed="false" title="Ler, buscar e pular para qualquer fala do vídeo">${icon('transcript', 20)}<span>Transcrição</span></button>` : ''}
      <button class="pill rpl" data-save="${id}">${icon('listPlus', 20)}<span>Salvar</span></button>
      <button class="pill rpl" data-mark title="Guarda o momento atual do vídeo com uma nota">${icon('bookmark', 20)}<span class="pl-long">Marcar momento</span><span class="pl-short">Marcar</span></button>
      <button class="pill rpl" data-share="${id}">${icon('share', 20)}<span>Compartilhar</span></button>
      ${info.live || IN_APP ? '' : downloadMenu(info)}
    </div>`;
  const watching = (n) => `<span id="w-watching">${n ? `${nf.format(n)} assistindo agora` : ''}</span>`;
  const liveSince = info.startedAt ? `ao vivo desde ${new Date(info.startedAt * 1000).toLocaleString('pt-BR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : 'ao vivo';
  $('#w-desc').innerHTML = `<div class="desc" id="desc" tabindex="0" role="button" aria-expanded="false">
    <div class="d-meta">${info.live ? dot(watching(info.viewers), liveSince) : dot(views(info.views), ago(info.date, info.published))}</div>
    <div class="d-text">${linkify(info.description) || 'Sem descrição.'}</div>
    <span class="d-more">...mais</span><span class="d-less">Mostrar menos</span>
  </div>`;

  // Chat da live na lateral (atualiza sozinho) e comentários abaixo da descrição (carregam ao rolar até eles).
  const alive = () => t === token;
  if (info.live) {
    mountChat($('#w-chat'), id, { alive, toast, onViewers: (n) => { const w = $('#w-watching'); if (w) w.textContent = `${nf.format(n)} assistindo agora`; } });
  }
  mountComments($('#w-comments'), id, { alive, toast });

  // Foto e inscritos do canal: se o servidor ainda não conhece, busca na página do canal.
  if ((!ch.avatar || !info.followers) && info.channelId) {
    api('/api/channel?id=' + info.channelId).then((c) => {
      if (t !== token) return;
      if (c.followers) $('#w-subs').textContent = subsCount(c.followers);
      if (!c.avatar) return;
      $('#w-av').innerHTML = avatar(c.name, c.avatar, 'md');
      const s = subs().map((x) => (x.id === c.id ? { ...x, avatar: c.avatar } : x));
      store.set('subs', s);
    }).catch(() => {});
  }

  const hist = store.get('history', []).filter((x) => x.id !== id);
  store.set('history', [{ ...slim(known.get(id)), date: info.date }, ...hist].slice(0, 200));

  const el = $('#player');
  el.querySelector('.poster')?.remove();
  el.querySelector('.p-spin')?.remove();
  let related = [];
  const cfg = lib.settings();
  if (!info.qualities.length) {
    el.classList.remove('loading');
    el.insertAdjacentHTML('beforeend', `<div class="p-error">${icon('alert', 32)}<p>Este vídeo não tem um formato que o navegador consiga tocar.</p></div>`);
  } else {
    // Próximo: na playlist segue a fila (aleatória/repetindo se ligado); fora dela, a primeira sugestão.
    const next = () => {
      const fresh = pl && lib.getPlaylist(pl.id);
      const n = fresh ? queueNext(fresh, id) : related[0];
      if (n) go(`#/watch/${n.id}${fresh ? `?list=${fresh.id}` : ''}`, fresh ? null : $('#related .thumb'));
      else if (fresh) toast('Fim da playlist');
    };
    const p = progress()[id];
    // Voltou para o vídeo que estava no miniplayer: ele volta para a página, sem recomeçar.
    if (mini && mini.info.id === id) {
      player = mini;
      mini = null;
      Object.assign(player.opts, { onNext: next, onEnded: () => { if (pl || $('#autoplay')?.checked) next(); } });
      if (player.root.classList.contains('in-mini')) {
        el.replaceWith(player.root);
        player.root.classList.remove('in-mini');
        hideMiniBar();
      } else player.dock(el);
    } else player = new Player(el, info, {
      onPipBack: () => { if (mini?.info.id === id) go(`#/watch/${id}${pl ? `?list=${pl.id}` : ''}`); else player?.exitPip(); },
      onPipClosed: () => { if (mini?.info.id === id) { mini.destroy(); mini = null; } },
      start: p && p.d - p.t > 15 ? p.t : 0,
      rate: lib.channelSpeed(info.channelId),
      onNext: next,
      onEnded: () => { if (pl || $('#autoplay')?.checked) next(); },
      onProgress: (time, d) => {
        if (info.live) return; // live não tem "continuar de onde parou"
        const all = progress();
        if (time > 10 && d - time > 15) all[id] = { t: Math.round(time), d: Math.round(d) };
        else if (d - time <= 15) delete all[id];
        store.set('progress', all);
      },
      onTick: (secs) => { lib.addWatch(secs, known.get(id) || slim(info)); sync.scheduleSync(); },
      onToast: toast,
      onRate: (r) => {
        lib.setChannelSpeed(info.channelId, r);
        if (info.channelId) toast(r === 1 ? 'Velocidade normal para este canal' : `${String(r).replace('.', ',')}x lembrada para ${info.channel}`);
      },
      onSkipToggle: (on) => { lib.setSetting('sponsor', on); toast(on ? 'Vou pular patrocínios' : 'Patrocínios não serão pulados'); },
    });
    renderMarks(id);
    // Sem capítulos do canal, usa os que a comunidade marcou no SponsorBlock.
    if (!info.live && !info.chapters?.length) {
      api('/api/chapters?id=' + id).then((list) => {
        if (t === token && player?.info.id === id && list.length) player.setChapters(list, true);
      }).catch(() => {});
    }
    // Extras em paralelo: trechos de patrocínio (SponsorBlock). Busca sempre, para os trechos aparecerem
    // na barra e o pulo poder ser ligado no menu ⚙ mesmo se estiver desligado nos Ajustes.
    api('/api/segments?id=' + id).then((segs) => {
      if (t !== token || !player) return;
      player.setSegments(segs.filter((s) => cfg.sponsorCats.includes(s.category)), cfg.sponsor);
    }).catch(() => {});
    // Pré-carrega o próximo da playlist para a troca ser instantânea.
    const n = pl && queueNext(pl, id);
    if (n && !queueMode().shuffle) fetch('/api/prefetch?id=' + n.id).catch(() => {});
  }
  const box = $('#w-votes');
  box.dataset.likes = info.likes || 0;
  if (cfg.dislikes) {
    api('/api/votes?id=' + id).then((vt) => {
      if (t !== token || !vt) return;
      box.dataset.likes = info.likes || vt.likes;
      box.dataset.dislikes = vt.dislikes;
      box.title = '“Não gostei” estimado pelo Return YouTube Dislike';
      renderVotes();
    }).catch(() => {});
  }
  // Sua conta neste vídeo: se você já curtiu e se é inscrita no canal (o botão de inscrição passa a ser o do YouTube).
  if (account.connected) {
    fetch('/api/vstate?id=' + id).then((r) => r.json()).then((st) => {
      if (t !== token || !st.loggedIn) return;
      box.dataset.like = st.like;
      renderVotes();
      if (st.channelId && st.subscribed !== isSub(st.channelId)) {
        accountChannels = st.subscribed ? [...accountChannels, { id: st.channelId, name: info.channel, avatar: ch.avatar }] : accountChannels.filter((c) => c.id !== st.channelId);
        refreshSubButtons({ id: st.channelId, name: info.channel, avatar: ch.avatar });
      }
    }).catch(() => {});
  }
  related = await loadRelated(info, t);
}

// Desenha os números e o estado de "Gostei / Não gostei" a partir do que está guardado no próprio elemento.
function renderVotes() {
  const box = $('#w-votes');
  if (!box) return;
  const like = box.dataset.like;
  const likes = Number(box.dataset.likes) || 0;
  const dislikes = box.dataset.dislikes == null ? null : Number(box.dataset.dislikes) || 0;
  box.querySelector('[data-rate="LIKE"]').setAttribute('aria-pressed', String(like === 'LIKE'));
  box.querySelector('[data-rate="DISLIKE"]').setAttribute('aria-pressed', String(like === 'DISLIKE'));
  $('#w-likes').textContent = likes ? nf.format(likes) : 'Gostei';
  $('#w-dislikes').textContent = dislikes == null ? '' : nf.format(dislikes);
  const bar = box.querySelector('.v-bar');
  bar.hidden = dislikes == null;
  if (dislikes != null) bar.firstElementChild.style.width = `${likes + dislikes ? (likes / (likes + dislikes)) * 100 : 100}%`;
}
function refreshSubButtons(c) {
  const on = isSub(c.id);
  $$(`[data-sub="${c.id}"].sub-btn`).forEach((b) => {
    const lg = b.classList.contains('lg') ? 'lg' : '';
    b.outerHTML = subButton(c, `${lg}`);
  });
  return on;
}

async function loadRelated(info, t) {
  try {
    const words = info.title.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length > 2).slice(0, 4).join(' ');
    const q = encodeURIComponent(`${info.channel} ${words}`);
    // Uma busca só devolvia sempre a mesma lista. Mistura três fontes (mesmo canal, só o assunto e as
    // recomendações da conta), embaralha e manda para o fim o que já apareceu em sugestões antes.
    const [r, topic, rec] = await Promise.all([
      api('/api/search?ch=0&q=' + q),
      api('/api/search?ch=0&q=' + encodeURIComponent(words || info.title)).catch(() => ({ videos: [] })),
      api('/api/feed?k=rec&page=0').catch(() => ({ items: [] })),
    ]);
    const ids = new Set([info.id]);
    const pool = [...r.videos.slice(0, 6), ...topic.videos, ...(rec.items || [])].filter((v) => !ids.has(v.id) && ids.add(v.id) && !v.live);
    const seen = new Set(store.get('relSeen', []));
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    const items = [...pool.filter((v) => !seen.has(v.id)), ...pool.filter((v) => seen.has(v.id))];
    store.set('relSeen', [...items.slice(0, 20).map((v) => v.id), ...seen].slice(0, 300));
    if (t !== token) return [];
    $('#related').innerHTML = items.length ? compacts(items) : empty('film', 'Sem sugestões');
    if (items.length && r.more) {
      infinite($('#related .compacts'), async (p) => {
        const n = await api(`/api/search?ch=0&page=${p}&q=${q}`);
        return { items: n.videos.filter((v) => v.id !== info.id), more: n.more };
      }, t);
    }
    return items;
  } catch {
    if (t === token) $('#related').innerHTML = '';
    return [];
  }
}

async function channelView(cid, t) {
  const s = subs().find((x) => x.id === cid);
  app.innerHTML = `<section class="view channel">
    <div id="ch-top"><div class="banner sk-block"></div>
      <div class="ch-head">${avatar(s?.name, s?.avatar, 'xxl', cid)}<div class="ch-info"><i class="sk-line"></i><i class="sk-line short"></i></div></div></div>
    <div class="tabs" role="tablist"><button class="tab on" role="tab" aria-selected="true">Vídeos</button></div>
    <div id="ch-videos">${skGrid()}</div>
  </section>`;
  try {
    const c = await api('/api/channel?id=' + cid);
    if (t !== token) return;
    document.title = `${c.name} - MeuTube`;
    if (s && c.avatar && s.avatar !== c.avatar) { store.set('subs', subs().map((x) => (x.id === cid ? { ...x, avatar: c.avatar } : x))); renderGuide(); }
    $('#ch-top').innerHTML = `
      ${c.banner ? `<div class="banner"><img src="${esc(c.banner)}" alt="" referrerpolicy="no-referrer"></div>` : ''}
      <div class="ch-head">
        ${avatar(c.name, c.avatar, 'xxl', cid)}
        <div class="ch-info">
          <h1>${esc(c.name)}${vf(c.verified)}</h1>
          <p class="meta">${dot(c.handle ? `<strong>${esc(c.handle)}</strong>` : '', subsCount(c.followers), c.videos.length ? `${c.videos.length}+ vídeos` : '')}</p>
          ${c.description ? `<p class="meta ch-desc">${esc(c.description)}</p>` : ''}
          ${subButton(c, 'lg')}
        </div>
      </div>`;
    $('#ch-videos').innerHTML = c.videos.length ? grid(c.videos) : empty('film', 'Este canal não tem vídeos públicos');
    if (c.videos.length && c.more) {
      infinite($('#ch-videos .grid'), async (p) => {
        const n = await api(`/api/channel?id=${cid}&page=${p}`);
        return { items: n.videos, more: n.more };
      }, t);
    }
  } catch (e) {
    if (t === token) { $('#ch-top').remove(); $('#ch-videos').innerHTML = failure(e); }
  }
}

const connectCta = (text) => `<a class="connect-cta rpl" href="#/account">${icon('key', 20)}<span>${text}</span>${icon('chevron', 18)}</a>`;

async function subsView(t) {
  const s = allChannels();
  document.title = 'Inscrições - MeuTube';
  if (!s.length && !account.connected) {
    app.innerHTML = `<section class="view">${empty('subs', 'Não perca os vídeos novos', 'Inscreva-se em canais pela busca, por um vídeo ou pela página do canal. Os vídeos novos aparecem aqui.')}
      <div class="center">${connectCta('Ou conecte sua conta do YouTube para trazer suas inscrições')}</div></section>`;
    return;
  }
  const local = new Set(subs().map((c) => c.id));
  app.innerHTML = `<section class="view">
    <div class="page-head"><h2>Inscrições</h2></div>
    ${s.length ? `<div class="ch-strip">${s.map((c, i) => `<div class="ch-tile" ${stagger(i)}><a href="#/channel/${c.id}">${avatar(c.name, c.avatar, 'lg', c.id)}<span>${esc(c.name)}</span></a>${local.has(c.id) ? `<button class="unsub rpl" data-sub="${c.id}" data-name="${esc(c.name)}" data-avatar="${esc(c.avatar || '')}" aria-label="Cancelar inscrição em ${esc(c.name)}">${icon('x', 14)}</button>` : ''}</div>`).join('')}</div>` : ''}
    <h3 class="sec-title">Mais recentes</h3>
    <div id="sfeed">${skGrid()}</div>
  </section>`;
  try {
    const r = account.connected ? await api('/api/feed?k=subs') : { items: await subsFeed(), more: false };
    if (t !== token) return;
    $('#sfeed').innerHTML = r.items.length ? grid(r.items) : empty('film', 'Nenhum vídeo novo');
    if (r.items.length && r.more) infinite($('#sfeed .grid'), (p) => api(`/api/feed?k=subs&page=${p}`), t);
  } catch (e) {
    if (t === token) $('#sfeed').innerHTML = failure(e);
  }
}

function playlistPage(title, items, side, emptyHtml) {
  return `<section class="view playlist">
    <div class="pl-head"><h2>${title}</h2>${side}</div>
    ${items.length ? rows(items) : emptyHtml}
  </section>`;
}

// Abas "Neste site" / "Conta do YouTube" nas listas que existem nos dois lugares.
const sourceTabs = (key) => {
  if (!account.connected) return '';
  const cur = store.get('src:' + key, 'site');
  return `<div class="seg" role="tablist">${[['site', 'Neste site'], ['yt', 'Conta do YouTube']].map(([v, l]) => `<button class="seg-btn rpl ${cur === v ? 'on' : ''}" role="tab" aria-selected="${cur === v}" data-src="${key}:${v}">${l}</button>`).join('')}<span class="seg-pill"></span></div>`;
};
const fromAccount = (key) => account.connected && store.get('src:' + key, 'site') === 'yt';

async function accountList(kind, t) {
  $('#pl-list').innerHTML = skRows(5);
  try {
    const r = await api('/api/feed?k=' + kind);
    if (t !== token) return;
    $('#pl-list').innerHTML = r.items.length ? rows(r.items) : empty('film', 'Nada por aqui na sua conta');
    if (r.items.length && r.more) infinite($('#pl-list .rows'), (p) => api(`/api/feed?k=${kind}&page=${p}`), t);
  } catch (e) {
    if (t === token) $('#pl-list').innerHTML = failure(e);
  }
}

function laterView(t) {
  const yt = fromAccount('later');
  const items = later();
  document.title = 'Assistir mais tarde - MeuTube';
  app.innerHTML = `<section class="view playlist">
    <div class="pl-head"><h2>Assistir mais tarde</h2>${sourceTabs('later')}${yt ? '' : `<span class="meta">${items.length} ${items.length === 1 ? 'vídeo' : 'vídeos'}</span>`}</div>
    <div id="pl-list">${yt ? '' : items.length ? rows(items) : empty('clock', 'Sua lista está vazia', 'Toque no relógio de um vídeo para guardar aqui.')}</div>
  </section>`;
  if (yt) accountList('later', t);
}

function historyView(t) {
  const yt = fromAccount('history');
  const items = store.get('history', []);
  document.title = 'Histórico - MeuTube';
  app.innerHTML = `<section class="view playlist">
    <div class="pl-head"><h2>Histórico de exibição</h2>${sourceTabs('history')}${!yt && items.length ? `<button class="pill rpl" data-clear>${icon('trash', 20)}Limpar histórico deste site</button>` : ''}</div>
    <div id="pl-list">${yt ? '' : items.length ? rows(items) : empty('history', 'Nada assistido ainda', 'Os vídeos que você assistir aparecem aqui.')}</div>
  </section>`;
  if (yt) accountList('history', t);
}

function likedView(t) {
  document.title = 'Vídeos curtidos - MeuTube';
  if (!account.connected) {
    app.innerHTML = `<section class="view">${empty('heart', 'Seus vídeos curtidos', 'Conecte sua conta do YouTube para ver os vídeos que você curtiu.')}<div class="center">${connectCta('Conectar conta do YouTube')}</div></section>`;
    return;
  }
  app.innerHTML = `<section class="view playlist"><div class="pl-head"><h2>Vídeos curtidos</h2></div><div id="pl-list"></div></section>`;
  accountList('liked', t);
}

// ---------- playlists ----------
const relTime = (ms) => {
  const min = (Date.now() - ms) / 60000;
  if (min < 1) return 'agora';
  if (min < 60) return rtf.format(-Math.round(min), 'minute');
  if (min < 1440) return rtf.format(-Math.round(min / 60), 'hour');
  return rtf.format(-Math.round(min / 1440), 'day');
};
const longDur = (secs) => (secs >= 3600 ? `${Math.floor(secs / 3600)} h ${Math.round((secs % 3600) / 60)} min` : `${Math.max(secs ? 1 : 0, Math.round(secs / 60))} min`);

function plCard(p, i) {
  const thumbs = p.items.slice(0, 4);
  return `<a class="pl-card" href="#/playlist/${p.id}" style="--i:${Math.min(i, 16)}">
    <div class="pl-cover" data-n="${thumbs.length}">
      ${thumbs.length ? thumbs.map((v) => `<img src="${esc(thumbUrl(v))}" alt="" loading="lazy">`).join('') : `<span class="pl-empty">${icon('playlist', 36)}</span>`}
      <span class="pl-count">${icon('playlist', 15)}${p.items.length}</span>
      <span class="pl-play">${icon('play', 20)}Tocar tudo</span>
    </div>
    <b>${esc(p.name)}</b><span class="meta sm">${p.items.length} ${p.items.length === 1 ? 'vídeo' : 'vídeos'} · atualizada ${relTime(p.updated)}</span>
  </a>`;
}

function playlistsView() {
  document.title = 'Playlists - MeuTube';
  const pls = lib.playlists();
  app.innerHTML = `<section class="view playlists">
    <div class="page-head split"><h2>Playlists</h2>
      <form class="inline-form" data-form="new-pl"><input name="name" placeholder="Nome da nova playlist" maxlength="80" aria-label="Nome da nova playlist" required><button class="sub-btn rpl">${icon('plus', 16)}Criar</button></form>
    </div>
    <form class="import-bar" data-form="import-pl">
      <span class="import-ic">${icon('importIc', 18)}</span>
      <input name="list" placeholder="Cole o link de uma playlist do YouTube para trazer para cá" aria-label="Link da playlist do YouTube" required>
      <button class="pill rpl">Importar</button>
    </form>
    ${pls.length ? `<div class="pl-grid">${pls.map(plCard).join('')}</div>` : empty('playlist', 'Nenhuma playlist ainda', 'Crie uma acima, importe do YouTube ou use “Salvar” num vídeo.')}
  </section>`;
}

function plItem(v, i, pid, total) {
  return `<div class="pl-item" draggable="true" data-idx="${i}" style="--i:${Math.min(i, 16)}">
    <span class="grip" title="Arraste para reordenar">${icon('grip', 18)}</span>
    <span class="pl-n">${i + 1}</span>
    <a class="pl-thumb" href="#/watch/${v.id}?list=${pid}" draggable="false"><img src="${esc(thumbUrl(v))}" alt="" loading="lazy">${v.duration ? `<span class="dur">${dur(v.duration)}</span>` : ''}</a>
    <div class="pl-text"><a class="title sm" href="#/watch/${v.id}?list=${pid}" draggable="false">${esc(v.title)}</a><span class="meta sm">${esc(v.channel)}</span></div>
    <div class="pl-tools">
      <button class="icon-btn rpl" data-pl-move="${i}:-1" ${i === 0 ? 'disabled' : ''} aria-label="Subir">${icon('chevronLeft', 16)}</button>
      <button class="icon-btn rpl" data-pl-move="${i}:1" ${i === total - 1 ? 'disabled' : ''} aria-label="Descer">${icon('chevron', 16)}</button>
      <button class="icon-btn rpl" data-pl-remove="${v.id}" aria-label="Tirar da playlist">${icon('x', 18)}</button>
    </div>
  </div>`;
}

function playlistView(id) {
  const p = lib.getPlaylist(id);
  if (!p) { app.innerHTML = `<section class="view">${empty('playlist', 'Playlist não encontrada', 'Ela pode ter sido apagada.')}</section>`; return; }
  document.title = `${p.name} - MeuTube`;
  const total = p.items.reduce((a, v) => a + (v.duration || 0), 0);
  const cover = p.items[0];
  app.innerHTML = `<section class="view pl-page">
    <div class="pl-hero">
      ${cover ? `<div class="pl-hero-bg" aria-hidden="true"><img src="https://i.ytimg.com/vi/${cover.id}/mqdefault.jpg" alt=""></div>` : ''}
      <div class="pl-hero-cover">${cover ? `<img src="${esc(thumbUrl(cover))}" alt="">` : icon('playlist', 56)}</div>
      <div class="pl-hero-info">
        <p class="eyebrow">Playlist</p>
        <h1 class="pl-name" id="pl-name">${esc(p.name)}</h1>
        <p class="meta">${dot(`${p.items.length} ${p.items.length === 1 ? 'vídeo' : 'vídeos'}`, total ? longDur(total) : '', `atualizada ${relTime(p.updated)}`)}</p>
        <div class="pl-actions">
          <button class="sub-btn rpl" data-pl-play="${id}" ${p.items.length ? '' : 'disabled'}>${icon('play', 16)}Tocar tudo</button>
          <button class="pill rpl" data-pl-shuffle="${id}" ${p.items.length ? '' : 'disabled'}>${icon('shuffle', 18)}Aleatório</button>
          <button class="pill rpl" data-pl-rename="${id}">${icon('edit', 18)}Renomear</button>
          <button class="pill rpl danger" data-pl-delete="${id}">${icon('trash', 18)}Apagar</button>
        </div>
      </div>
    </div>
    <div class="pl-items" id="pl-items" data-pid="${id}">${p.items.length ? p.items.map((v, i) => plItem(v, i, id, p.items.length)).join('') : empty('listPlus', 'Playlist vazia', 'Use o botão “Salvar” num vídeo ou o menu ⋯ das miniaturas.')}</div>
  </section>`;
}
function refreshPlItems(pid) {
  const p = lib.getPlaylist(pid);
  const box = $('#pl-items');
  if (!p || !box) return;
  box.innerHTML = p.items.length ? p.items.map((v, i) => plItem(v, i, pid, p.items.length)).join('') : empty('listPlus', 'Playlist vazia');
  $$('.pl-item', box).forEach((el) => (el.style.animation = 'none'));
}

// Arrastar para reordenar
let dragFrom = null;
document.addEventListener('dragstart', (e) => {
  const it = e.target.closest?.('.pl-item');
  if (!it) return;
  dragFrom = Number(it.dataset.idx);
  it.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
});
document.addEventListener('dragover', (e) => {
  const it = e.target.closest?.('.pl-item');
  if (!it || dragFrom == null) return;
  e.preventDefault();
  $$('.pl-item.over').forEach((x) => x !== it && x.classList.remove('over'));
  it.classList.add('over');
});
document.addEventListener('drop', (e) => {
  const it = e.target.closest?.('.pl-item');
  if (!it || dragFrom == null) return;
  e.preventDefault();
  const pid = $('#pl-items').dataset.pid;
  lib.movePlaylistItem(pid, dragFrom, Number(it.dataset.idx));
  dragFrom = null;
  refreshPlItems(pid);
});
document.addEventListener('dragend', () => { dragFrom = null; $$('.pl-item.dragging, .pl-item.over').forEach((x) => x.classList.remove('dragging', 'over')); });

// ---------- janela "Salvar em…" ----------
let modalVideo = null;
function closePopups() {
  $('.pop')?.remove();
  const back = $('.modal-back');
  if (back) { back.classList.add('closing'); setTimeout(() => back.remove(), 220); }
}
function openSaveModal(v) {
  closePopups();
  modalVideo = v;
  const pls = lib.playlists();
  document.body.insertAdjacentHTML('beforeend', `<div class="modal-back" data-close-modal>
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="save-title">
      <div class="modal-head"><h3 id="save-title">Salvar em…</h3><button class="icon-btn rpl" data-close-modal aria-label="Fechar">${icon('x', 20)}</button></div>
      <div class="modal-video"><img src="${esc(thumbUrl(v))}" alt=""><span>${esc(v.title || '')}</span></div>
      <div class="save-list">
        <label class="save-opt"><input type="checkbox" data-save-later="${v.id}" ${isLater(v.id) ? 'checked' : ''}><span class="box">${icon('check', 14)}</span>${icon('clock', 18)}<span class="so-name">Assistir mais tarde</span></label>
        ${pls.map((p) => `<label class="save-opt"><input type="checkbox" data-save-pl="${p.id}" ${lib.inPlaylist(p.id, v.id) ? 'checked' : ''}><span class="box">${icon('check', 14)}</span>${icon('playlist', 18)}<span class="so-name">${esc(p.name)}</span><span class="meta xs">${p.items.length}</span></label>`).join('')}
      </div>
      <form class="modal-new" data-form="save-new"><input name="name" placeholder="Nova playlist" maxlength="80" aria-label="Nome da nova playlist" required><button class="sub-btn rpl">${icon('plus', 16)}Criar</button></form>
    </div>
  </div>`);
  $('.modal input')?.focus({ preventScroll: true });
}

// ---------- menu "⋯" dos vídeos ----------
function openMore(btn, v) {
  const already = $('.pop');
  closePopups();
  if (already && already.dataset.for === v.id) return;
  const r = btn.getBoundingClientRect();
  const later = isLater(v.id);
  document.body.insertAdjacentHTML('beforeend', `<div class="pop" role="menu" data-for="${v.id}">
    <button role="menuitem" data-pop="save">${icon('listPlus', 18)}Salvar em playlist…</button>
    <button role="menuitem" data-pop="later">${icon('clock', 18)}${later ? 'Tirar de “Assistir mais tarde”' : 'Assistir mais tarde'}</button>
    <button role="menuitem" data-pop="link">${icon('share', 18)}Copiar link</button>
    ${v.channelId ? `<hr><button role="menuitem" data-pop="block">${icon('ban', 18)}Não mostrar vídeos de ${esc(v.channel)}</button>` : ''}
  </div>`);
  const pop = $('.pop');
  const w = pop.offsetWidth, h = pop.offsetHeight;
  pop.style.left = `${Math.max(8, Math.min(r.right - w, innerWidth - w - 8))}px`;
  pop.style.top = `${r.bottom + h + 8 > innerHeight ? Math.max(8, r.top - h - 6) : r.bottom + 6}px`;
  pop.querySelector('button').focus({ preventScroll: true });
}
addEventListener('scroll', () => $('.pop')?.remove(), { passive: true });

// ---------- estatísticas ----------
// Quadro para juntar as estatísticas do PC e do celular (pelo GitHub).
function syncPanel() {
  const st = sync.syncState();
  const other = IN_APP ? 'PC' : 'celular';
  if (!st.on) {
    return `<div class="panel sync-panel"><h3>${icon('repeat', 20)}Juntar com o ${other}</h3>
      <p class="meta sm">As estatísticas ficam iguais no PC e no celular. Elas ficam guardadas num arquivo secreto da sua conta do GitHub (só quem tem o código consegue mexer).</p>
      <ol class="acc-steps">
        <li><span>1</span><div>Abra <a href="${sync.TOKEN_URL}" target="_blank" rel="noopener noreferrer"><strong>esta página do GitHub</strong></a> já entrando na sua conta. A opção <strong>gist</strong> já vem marcada; em “Expiration” escolha <strong>No expiration</strong>.</div></li>
        <li><span>2</span><div>Clique em <strong>Generate token</strong> no fim da página e copie o código (começa com <code>ghp_</code>).</div></li>
        <li><span>3</span><div>Cole aqui e toque em Conectar. Faça o mesmo no ${other}, com o <strong>mesmo código</strong>.</div></li>
      </ol>
      <div class="inline-form sync-form"><input id="sync-token" type="password" placeholder="ghp_..." autocomplete="off" spellcheck="false" aria-label="Código do GitHub"><button class="sub-btn rpl" data-sync-connect>Conectar</button></div>
      <div id="sync-msg" aria-live="polite"></div>
    </div>`;
  }
  const devs = st.devices.map((d) => `<b>${esc(d.name)}</b> (atualizado ${relTime(d.updated)})`).join(', ');
  return `<div class="panel sync-panel"><h3>${icon('check', 20)}Juntando com o ${other}</h3>
    <p class="meta sm">Somando: <b>${esc(sync.deviceName())}</b> (este aparelho)${devs ? `, ${devs}` : `. O ${other} aparece aqui depois que você conectar nele com o mesmo código`}.${st.last ? ` Última sincronização ${relTime(st.last)}.` : ''}</p>
    ${st.error ? `<p class="meta sm sync-err">${esc(st.error)}</p>` : ''}
    <div class="blocked-actions"><button class="pill rpl" data-sync-now>${icon('repeat', 18)}Sincronizar agora</button><button class="pill rpl" data-sync-off>${icon('logout', 18)}Parar de juntar</button></div>
  </div>`;
}

function statsView() {
  document.title = 'Suas estatísticas - MeuTube';
  const s = lib.statsSummary();
  const max = Math.max(60, ...s.last7.map((d) => d.secs));
  // Estimativa divertida: ~1,5 anúncio a cada 8 minutos assistidos, ~15 s cada.
  const ads = Math.round((s.total / 60 / 8) * 1.5);
  const wd = new Intl.DateTimeFormat('pt-BR', { weekday: 'short' });
  const card = (ic, label, value, sub = '', count = '') => `<div class="stat-card"><span class="stat-ic">${icon(ic, 20)}</span><span class="meta sm">${label}</span><b ${count !== '' ? `data-count="${count}"` : ''}>${value}</b>${sub ? `<span class="meta xs">${sub}</span>` : ''}</div>`;
  app.innerHTML = `<section class="view stats">
    <div class="page-head"><h2>Suas estatísticas</h2><p class="meta">${sync.syncState().on ? 'Somando o PC e o celular.' : `Só ${IN_APP ? 'neste celular' : 'neste navegador'}.`} Conta o tempo em que o vídeo esteve tocando de verdade.</p></div>
    <div class="stat-cards">
      ${card('clock', 'Hoje', longDur(s.today))}
      ${card('chart', 'Últimos 7 dias', longDur(s.week))}
      ${card('history', 'No total', longDur(s.total))}
      ${card('film', 'Vídeos assistidos', s.videos, '', s.videos)}
      ${card('shield', 'Anúncios evitados', ads, `uns ${longDur(ads * 15)} que você não perdeu`, ads)}
    </div>
    <div class="stat-panels">
      <div class="panel"><h3>Últimos 7 dias</h3>
        <div class="bars">${s.last7.map((d, i) => `<div class="bar-col"><span class="bar-val">${d.secs ? longDur(d.secs) : ''}</span><div class="bar ${i === 6 ? 'today' : ''}" style="--h:${(d.secs / max) * 100}%;--i:${i}"></div><span class="bar-day">${i === 6 ? 'hoje' : wd.format(d.date).replace('.', '')}</span></div>`).join('')}</div>
      </div>
      <div class="panel"><h3>Canais que você mais assiste</h3>
        ${s.top.length ? s.top.map((c, i) => `<a class="top-ch" href="#/channel/${c.id}" style="--i:${i}">${avatar(c.name, c.avatar, 'md', c.id)}<span class="top-text"><b>${esc(c.name)}</b><span class="meta sm">${longDur(c.secs)}</span><i class="top-bar" style="--w:${(c.secs / s.top[0].secs) * 100}%"></i></span></a>`).join('') : '<p class="meta">Assista a alguns vídeos e seus canais favoritos aparecem aqui.</p>'}
      </div>
    </div>
    ${syncPanel()}
    <button class="pill rpl" data-stats-reset>${icon('trash', 18)}Zerar estatísticas</button>
  </section>`;
  // Traz as dos outros aparelhos; se mudou algo, desenha de novo.
  if (sync.syncState().on) sync.syncNow().then((changed) => { if (changed && location.hash === '#/stats') statsView(); }).catch(() => {});
  // Números contando até o valor (animação).
  $$('[data-count]').forEach((el) => {
    const target = Number(el.dataset.count);
    if (reduced || !target) return;
    const t0 = performance.now();
    const stepFn = (now) => {
      const p = Math.min(1, (now - t0) / 900);
      el.textContent = Math.round(target * (1 - Math.pow(1 - p, 3)));
      if (p < 1) requestAnimationFrame(stepFn);
    };
    requestAnimationFrame(stepFn);
  });
}

// ---------- ajustes ----------
function settingsView() {
  document.title = 'Ajustes - MeuTube';
  const s = lib.settings();
  const b = lib.blocked();
  const sw = (key, on) => `<label class="switch big"><input type="checkbox" data-set="${key}" ${on ? 'checked' : ''}><span class="sr-only">Ligar ou desligar</span></label>`;
  app.innerHTML = `<section class="view settings">
    <div class="page-head"><h2>Ajustes</h2><p class="meta">Funções que o YouTube não tem. Tudo fica salvo só neste navegador.</p></div>
    <div class="set-card" style="--i:0">
      <div class="set-row"><span class="set-ic">${icon('skipForward', 22)}</span><div><h3>Pular patrocínios automaticamente</h3><p class="meta sm">Usa o SponsorBlock, uma base aberta em que a comunidade marca trechos de patrocínio. O site envia só o código do vídeo. Os trechos também aparecem coloridos na barra do vídeo.</p></div>${sw('sponsor', s.sponsor)}</div>
      <div class="cats">${Object.entries(SEG_NAMES).map(([k, l]) => `<label class="cat-chip"><input type="checkbox" data-cat="${k}" ${s.sponsorCats.includes(k) ? 'checked' : ''}><span class="seg-dot seg-${k}"></span>${l}</label>`).join('')}</div>
    </div>
    <div class="set-card" style="--i:1">
      <div class="set-row"><span class="set-ic">${icon('dislike', 22)}</span><div><h3>Mostrar “não gostei”</h3><p class="meta sm">O YouTube escondeu esse número. Mostramos a estimativa do Return YouTube Dislike, com uma barrinha de aprovação.</p></div>${sw('dislikes', s.dislikes)}</div>
    </div>
    <div class="set-card" style="--i:2">
      <div class="set-row"><span class="set-ic">${icon('sparkles', 22)}</span><div><h3>Títulos e miniaturas sem clickbait</h3><p class="meta sm">Usa o DeArrow, do mesmo criador do SponsorBlock: a comunidade reescreve títulos sensacionalistas e escolhe um quadro do vídeo que mostra o que ele é. O site envia só o código do vídeo.</p></div>${sw('dearrow', s.dearrow)}</div>
      <div class="set-row sub"><span class="set-ic"></span><div><h3>Trocar também os títulos</h3><p class="meta sm">Os títulos da comunidade quase sempre estão em inglês, mesmo quando o YouTube mostra o título em português. Pare o mouse no título para ver o original.</p></div>${sw('dearrowTitles', s.dearrowTitles)}</div>
    </div>
    <div class="set-card" style="--i:2">
      <div class="set-row"><span class="set-ic">${icon('zap', 22)}</span><div><h3>Pré-carregar ao passar o mouse</h3><p class="meta sm">Quando o mouse para numa miniatura, o vídeo já começa a carregar e abre bem mais rápido.</p></div>${sw('prefetch', s.prefetch)}</div>
    </div>
    <div class="set-card" style="--i:3">
      <div class="set-row"><span class="set-ic">${icon('ban', 22)}</span><div><h3>Esconder vídeos</h3><p class="meta sm">Vídeos destes canais ou com estas palavras no título somem do site inteiro.</p></div></div>
      <form class="inline-form" data-form="word"><input name="w" placeholder="Palavra ou expressão (ex.: spoiler)" maxlength="60" aria-label="Palavra para esconder" required><button class="pill rpl">${icon('plus', 16)}Adicionar</button></form>
      <div class="tag-wrap">${b.words.map((w) => `<span class="tag-chip">“${esc(w)}”<button data-unword="${esc(w)}" aria-label="Parar de esconder ${esc(w)}">${icon('x', 14)}</button></span>`).join('') || '<span class="meta sm">Nenhuma palavra.</span>'}</div>
      <h4 class="set-sub">Canais escondidos</h4>
      <div class="tag-wrap">${b.channels.map((c) => `<span class="tag-chip">${esc(c.name)}<button data-unblock="${c.id}" aria-label="Mostrar ${esc(c.name)} de novo">${icon('x', 14)}</button></span>`).join('') || '<span class="meta sm">Nenhum. Use o menu ⋯ de um vídeo para esconder um canal.</span>'}</div>
    </div>
    <div class="set-card" style="--i:4">
      <div class="set-row"><span class="set-ic">${icon('gear', 22)}</span><div><h3>Atalhos do player</h3>
        <div class="keys">${[['K', 'pausar'], ['J / L', '±10 s'], ['← / →', '±5 s'], ['↑ / ↓', 'volume'], ['M', 'mudo'], ['F', 'tela cheia'], ['N', 'próximo'], ['S', 'capturar quadro'], ['C', 'legendas'], ['< / >', 'velocidade']].map(([k, d]) => `<span><kbd>${esc(k)}</kbd>${d}</span>`).join('')}</div>
      </div></div>
    </div>
  </section>`;
}

// ---------- eventos das funções novas ----------
document.addEventListener('click', (e) => {
  const t = e.target;
  if (!t.closest?.('.pop, [data-more]')) $('.pop')?.remove();
  const el = t.closest?.('[data-more], [data-pop], [data-save], [data-mark], [data-mark-del], [data-queue], [data-close-modal], [data-pl-play], [data-pl-shuffle], [data-pl-rename], [data-pl-delete], [data-pl-remove], [data-pl-move], [data-unword], [data-unblock], [data-stats-reset], [data-sync-connect], [data-sync-now], [data-sync-off], [data-transcript], [data-ai]');
  if (!el) return;
  const vid = () => known.get(location.hash.match(/watch\/([\w-]{11})/)?.[1]) || null;

  if (el.hasAttribute('data-transcript')) return openTranscript();
  if (el.hasAttribute('data-ai')) return aiToggle();
  if (el.dataset.more) {
    e.preventDefault();
    return openMore(el, known.get(el.dataset.more) || { id: el.dataset.more });
  }
  if (el.dataset.pop) {
    const v = known.get($('.pop')?.dataset.for) || {};
    $('.pop')?.remove();
    if (el.dataset.pop === 'save') openSaveModal(v);
    if (el.dataset.pop === 'later') toast(toggleLater(v.id) ? 'Salvo em Assistir mais tarde' : 'Removido de Assistir mais tarde');
    if (el.dataset.pop === 'link') navigator.clipboard?.writeText(`https://www.youtube.com/watch?v=${v.id}`).then(() => toast('Link copiado'));
    if (el.dataset.pop === 'block') {
      lib.blockChannel(v.channelId, v.channel);
      $$('article[data-vid]').forEach((a) => {
        if (known.get(a.dataset.vid)?.channelId !== v.channelId) return;
        a.classList.add('vanish');
        setTimeout(() => a.remove(), 400);
      });
      toast(`Vídeos de ${v.channel} escondidos. Dá para desfazer em Ajustes.`);
    }
    return;
  }
  if (el.dataset.save) return openSaveModal(known.get(el.dataset.save) || { id: el.dataset.save });
  if (el.hasAttribute('data-close-modal')) {
    if (el.classList.contains('modal-back') && t !== el) return; // clique dentro da janela
    return closePopups();
  }
  if (el.hasAttribute('data-mark')) {
    const v = vid();
    if (!player || !v) return;
    const at = Math.round(player.now);
    const list = lib.addMark(v.id, at);
    renderMarks(v.id);
    toast(`Momento ${dur(at) || '0:00'} salvo. Escreva uma nota se quiser.`);
    $(`[data-mark-note="${list.findIndex((x) => x.t === at)}"]`)?.focus();
    return;
  }
  if (el.dataset.markDel) {
    const v = vid();
    if (!v) return;
    lib.removeMark(v.id, Number(el.dataset.markDel));
    renderMarks(v.id);
    return;
  }
  if (el.dataset.queue) {
    const q = queueMode();
    q[el.dataset.queue] = !q[el.dataset.queue];
    store.set('queueMode', q);
    toast(el.dataset.queue === 'loop' ? (q.loop ? 'Playlist vai repetir' : 'Playlist não repete') : (q.shuffle ? 'Ordem aleatória ligada' : 'Ordem normal'));
    const listId = new URLSearchParams(location.hash.split('?')[1] || '').get('list');
    const pl = lib.getPlaylist(listId);
    if (pl) $('#queue').outerHTML = queueHtml(pl, vid()?.id);
    return;
  }
  if (el.dataset.plPlay || el.dataset.plShuffle) {
    const p = lib.getPlaylist(el.dataset.plPlay || el.dataset.plShuffle);
    if (!p?.items.length) return;
    const shuffle = Boolean(el.dataset.plShuffle);
    store.set('queueMode', { ...queueMode(), shuffle });
    p.items.forEach((v) => known.set(v.id, { ...known.get(v.id), ...v }));
    const first = shuffle ? p.items[Math.floor(Math.random() * p.items.length)] : p.items[0];
    return go(`#/watch/${first.id}?list=${p.id}`);
  }
  if (el.dataset.plRename) {
    const h1 = $('#pl-name');
    const p = lib.getPlaylist(el.dataset.plRename);
    if (!h1 || !p) return;
    h1.outerHTML = `<form class="rename-form" data-form="rename" data-pid="${p.id}"><input name="name" value="${esc(p.name)}" maxlength="80" aria-label="Novo nome" required><button class="sub-btn rpl">Salvar</button></form>`;
    $('.rename-form input').select();
    return;
  }
  if (el.dataset.plDelete) {
    const p = lib.getPlaylist(el.dataset.plDelete);
    if (!p || !confirm(`Apagar a playlist “${p.name}”? Os vídeos continuam no YouTube; só a lista some.`)) return;
    lib.deletePlaylist(p.id);
    renderGuide();
    toast('Playlist apagada');
    return go('#/playlists');
  }
  if (el.dataset.plRemove) {
    const pid = $('#pl-items')?.dataset.pid;
    const row = el.closest('.pl-item');
    row?.classList.add('vanish');
    setTimeout(() => { lib.removeFromPlaylist(pid, el.dataset.plRemove); refreshPlItems(pid); }, 300);
    return;
  }
  if (el.dataset.plMove) {
    const pid = $('#pl-items')?.dataset.pid;
    const [i, d] = el.dataset.plMove.split(':').map(Number);
    lib.movePlaylistItem(pid, i, i + d);
    refreshPlItems(pid);
    $(`[data-pl-move="${i + d}:${d}"]`)?.focus();
    return;
  }
  if (el.dataset.unword) { lib.removeWord(el.dataset.unword); return settingsView(); }
  if (el.dataset.unblock) { lib.unblockChannel(el.dataset.unblock); return settingsView(); }
  if (el.hasAttribute('data-stats-reset')) {
    if (!confirm(sync.syncState().on ? 'Zerar as estatísticas deste aparelho? (As do outro aparelho continuam.)' : 'Zerar todas as estatísticas de tempo assistido?')) return;
    lib.resetStats();
    sync.syncNow().catch(() => {});
    return statsView();
  }
  if (el.hasAttribute('data-sync-connect')) {
    el.disabled = true;
    el.textContent = 'Conectando…';
    sync.connect($('#sync-token').value)
      .then(() => { toast('Estatísticas juntas: PC e celular'); statsView(); burst($('.sync-panel h3'), 18); })
      .catch((err) => { $('#sync-msg').innerHTML = failure(err); el.disabled = false; el.textContent = 'Conectar'; });
    return;
  }
  if (el.hasAttribute('data-sync-now')) {
    el.disabled = true;
    sync.syncNow().then(() => toast('Sincronizado')).catch((err) => toast(err.message)).finally(() => { if (location.hash === '#/stats') statsView(); });
    return;
  }
  if (el.hasAttribute('data-sync-off')) {
    if (!confirm('Parar de juntar as estatísticas neste aparelho? O que já foi guardado continua no GitHub.')) return;
    sync.disconnect();
    toast('Estatísticas só deste aparelho');
    return statsView();
  }
});

document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.dataset.set) {
    lib.setSetting(el.dataset.set, el.checked);
    toast(el.checked ? 'Ligado' : 'Desligado');
  }
  if (el.dataset.cat) {
    const cats = new Set(lib.settings().sponsorCats);
    el.checked ? cats.add(el.dataset.cat) : cats.delete(el.dataset.cat);
    lib.setSetting('sponsorCats', [...cats]);
  }
  if (el.dataset.saveLater) {
    const on = toggleLater(el.dataset.saveLater);
    if (on !== el.checked) toggleLater(el.dataset.saveLater);
    toast(el.checked ? 'Salvo em Assistir mais tarde' : 'Removido de Assistir mais tarde');
  }
  if (el.dataset.savePl && modalVideo) {
    const p = lib.getPlaylist(el.dataset.savePl);
    if (el.checked) lib.addToPlaylist(p.id, modalVideo); else lib.removeFromPlaylist(p.id, modalVideo.id);
    el.closest('.save-opt').querySelector('.meta').textContent = lib.getPlaylist(p.id).items.length;
    toast(el.checked ? `Salvo em ${p.name}` : `Removido de ${p.name}`);
    renderGuide();
  }
  if (el.dataset.markNote != null) {
    const v = known.get(location.hash.match(/watch\/([\w-]{11})/)?.[1]);
    if (v) { lib.updateMark(v.id, Number(el.dataset.markNote), el.value); player?.setMarks(lib.marks(v.id)); toast('Nota salva'); }
  }
});

document.addEventListener('submit', async (e) => {
  const f = e.target.closest('[data-form]');
  if (!f) return;
  e.preventDefault();
  const val = (n) => (f.elements[n]?.value || '').trim();
  const kind = f.dataset.form;
  if (kind === 'new-pl') {
    const p = lib.createPlaylist(val('name'));
    renderGuide();
    toast(`Playlist “${p.name}” criada`);
    return playlistsView();
  }
  if (kind === 'save-new' && modalVideo) {
    const p = lib.createPlaylist(val('name'), [modalVideo]);
    renderGuide();
    closePopups();
    return toast(`Salvo em ${p.name}`);
  }
  if (kind === 'rename') {
    lib.renamePlaylist(f.dataset.pid, val('name'));
    renderGuide();
    return playlistView(f.dataset.pid);
  }
  if (kind === 'word') {
    lib.addWord(val('w'));
    toast('Vídeos com essa palavra vão sumir do site');
    return settingsView();
  }
  if (kind === 'import-pl') {
    const btn = f.querySelector('button');
    btn.disabled = true;
    btn.innerHTML = '<span class="btn-spin dark"></span>Importando…';
    try {
      const r = await api('/api/ytplaylist?list=' + encodeURIComponent(val('list')));
      const p = lib.createPlaylist(r.title, r.items);
      renderGuide();
      toast(`Importada: ${p.name} (${p.items.length} vídeos)`);
      go(`#/playlist/${p.id}`);
    } catch (err) {
      toast(err.message);
      btn.disabled = false;
      btn.textContent = 'Importar';
    }
  }
});

document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePopups(); });

// Pré-carga: parar o mouse numa miniatura já começa a buscar o vídeo (abre muito mais rápido).
const prefetched = new Set();
let hoverTimer;
const warm = (id) => {
  if (prefetched.has(id) || !lib.settings().prefetch) return;
  prefetched.add(id);
  fetch('/api/prefetch?id=' + id).catch(() => {});
  new Image().src = `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`;
};
document.addEventListener('pointerover', (e) => {
  const a = e.target.closest?.('article[data-vid], .q-item, .pl-item');
  clearTimeout(hoverTimer);
  const id = a?.dataset.vid || a?.querySelector('a[href*="/watch/"]')?.getAttribute('href').match(/watch\/([\w-]{11})/)?.[1];
  if (id) hoverTimer = setTimeout(() => warm(id), 450); // só quando o mouse realmente para (menos pedidos)
}, { passive: true });
document.addEventListener('touchstart', (e) => {
  const id = e.target.closest?.('article[data-vid]')?.dataset.vid;
  if (id) warm(id);
}, { passive: true });

// ---------- conta ----------
const BROWSER_NAMES = { firefox: 'Firefox', chrome: 'Chrome', edge: 'Edge', brave: 'Brave', opera: 'Opera', vivaldi: 'Vivaldi', chromium: 'Chromium' };
let pickedBrowser = 'firefox';

function accountView() {
  document.title = 'Conta - MeuTube';
  const c = account.connected;
  app.innerHTML = `<section class="view account">
    <div class="acc-card ${c ? 'is-on' : ''}">
      <div class="acc-badge">
        ${logoMark()}
        <span class="acc-key">${icon(c ? 'check' : 'key', 18)}</span>
      </div>
      <h1>${c ? 'Conta do YouTube conectada' : 'Conecte sua conta do YouTube'}</h1>
      <p class="acc-lead">${c
        ? `${account.mode === 'google' ? 'Conectada com a <strong>sua conta Google</strong>' : account.mode === 'file' ? 'Conectada pelo <strong>arquivo de login</strong>' : `Conectada pelo <strong>${BROWSER_NAMES[account.browser] || account.browser}</strong>`}${account.profile ? ` (perfil ${esc(account.profile)})` : ''}. Suas recomendações, inscrições, histórico, “assistir mais tarde” e curtidos já aparecem aqui, sem anúncios.`
        : 'Traga suas recomendações, inscrições, histórico, “assistir mais tarde” e vídeos curtidos. De quebra, o YouTube para de pedir a verificação anti-robô.'}</p>
      ${c ? `
        <div class="acc-profile" id="acc-profile">${meInfo.photo ? `<img src="${esc(meInfo.photo)}" alt="">` : `<span class="acc-photo-ph">${icon('user', 30)}</span>`}
          <div><b>${esc(meInfo.name || 'Sua conta do YouTube')}</b>${meInfo.handle ? `<span class="meta sm">${esc(meInfo.handle)}</span>` : ''}</div></div>
        <div class="acc-links">
          <a class="pill rpl" href="#/">${icon('sparkles', 18)}Para você</a>
          <a class="pill rpl" href="#/subs">${icon('subs', 18)}Inscrições</a>
          <a class="pill rpl" href="#/liked">${icon('heart', 18)}Curtidos</a>
          <a class="pill rpl" href="#/history">${icon('history', 18)}Histórico</a>
        </div>
        <nav class="lib-links acc-menu" aria-label="Conta">
          ${libLink('#/library', 'film', 'Meus vídeos')}
          ${libLink('#/settings', 'sliders', 'Ajustes')}
          ${libLink('#/stats', 'chart', 'Suas estatísticas')}
          <button class="lib-link rpl" data-switch-account>${icon('repeat', 22)}<span><b>Trocar de conta</b></span>${icon('chevron', 18)}</button>
          <button class="lib-link rpl danger" data-disconnect>${icon('logout', 22)}<span><b>Sair</b><small>Desconecta a conta deste ${IN_APP ? 'celular' : 'computador'}</small></span>${icon('chevron', 18)}</button>
        </nav>`
      : accMethod() === 'google' ? googleMethod() : accMethod() === 'file' ? fileMethod() : `${methodSwitch()}
        <ol class="acc-steps">
          <li><span>1</span><div>Abra o <strong>youtube.com</strong> no navegador e entre na sua conta (se ainda não estiver).</div></li>
          <li><span>2</span><div><strong>Feche esse navegador por completo</strong> (Brave, Chrome e Edge travam o login enquanto estão abertos; o Firefox não precisa).</div></li>
          <li><span>3</span><div>Escolha o navegador abaixo e clique em <strong>Conectar</strong>.</div></li>
        </ol>
        <div class="browser-grid" role="radiogroup" aria-label="Navegador">
          ${(account.browsers?.length ? account.browsers : Object.keys(BROWSER_NAMES)).map((b) => `<button class="browser rpl ${b === pickedBrowser ? 'on' : ''}" role="radio" aria-checked="${b === pickedBrowser}" data-browser="${b}"><span class="b-dot b-${b}"></span>${BROWSER_NAMES[b] || b}${b === 'firefox' ? '<em>recomendado</em>' : ''}</button>`).join('')}
        </div>
        <details class="acc-adv"><summary>Usa mais de um perfil nesse navegador?</summary>
          <label for="acc-profile">Nome da pasta do perfil (deixe vazio para o perfil principal)</label>
          <input id="acc-profile" placeholder="ex.: Profile 1" autocomplete="off">
        </details>
        <button class="sub-btn connect rpl" data-connect>Conectar</button>
        <div id="acc-msg" aria-live="polite"></div>`}
      <p class="acc-note">${icon('shield', 18)}<span>${IN_APP
        ? 'O app nunca pede nem guarda sua senha. Ele guarda só os cookies do YouTube, dentro do app, neste celular (nada vai para servidor nenhum). Não compartilhe o arquivo <code>cookies.txt</code>'
        : 'O site nunca pede nem guarda sua senha. Ele usa o login que já existe no seu navegador e guarda só os cookies do YouTube, neste computador (arquivo <code>cookies.txt</code> na pasta do site). Não compartilhe esse arquivo'}: ele dá acesso à sua conta. Para cortar o acesso a qualquer momento, clique em Desconectar ou saia da conta no YouTube.</span></p>
    </div>
  </section>`;
  // Se um login com Google já estava em andamento (ex.: a página recarregou), retoma o acompanhamento.
  if (!c && accMethod() === 'google' && !IN_APP) pollGoogle();
}

// Três jeitos de conectar: entrar com Google numa janela isolada (principal), arquivo de login ou direto do Firefox.
// No app de celular: entrar com Google (página do Google dentro do app) ou arquivo de login; o Firefox só no PC.
const IN_APP = Boolean(window.meutubeApp);
const accMethod = () => {
  const m = store.get('accMethod2', 'google');
  return IN_APP && m === 'browser' ? 'google' : m;
};
const methodSwitch = () => {
  const cur = accMethod();
  const list = [['google', 'Entrar com Google'], ['file', 'Arquivo de login'], ...(IN_APP ? [] : [['browser', 'Firefox']])];
  return `<div class="seg acc-methods" role="tablist">${list.map(([v, l]) => `<button class="seg-btn rpl ${cur === v ? 'on' : ''}" role="tab" aria-selected="${cur === v}" data-method="${v}">${l}</button>`).join('')}</div>`;
};
// ---------- "Entrar com Google" ----------
const GOOGLE_G = `<svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>`;
let googleState = { status: 'idle' };
let googlePoll = null;

function googleMethod() {
  const s = googleState;
  const b = s.browser || account.loginBrowser || 'navegador';
  let body;
  if (s.status === 'waiting') {
    body = `<div class="g-live">
        <div class="g-window"><span class="g-dots"><i></i><i></i><i></i></span>${GOOGLE_G}<b>Janela do ${esc(b)} aberta</b></div>
        <ol class="acc-steps g-steps">
          <li><span>1</span><div>Na janela que abriu, <strong>entre na sua conta Google</strong> (é a página oficial do Google).</div></li>
          <li><span>2</span><div>Espere o <strong>YouTube aparecer com a sua foto</strong> no canto.</div></li>
          <li><span>3</span><div><strong>Feche a janela</strong> ou clique em “Já entrei”.</div></li>
        </ol>
        <div class="blocked-actions">
          <button class="sub-btn rpl" data-google-done>${icon('check', 16)}Já entrei</button>
          <button class="pill rpl" data-google-cancel>Cancelar</button>
        </div>
      </div>`;
  } else if (IN_APP && s.status !== 'saving') {
    body = `<button class="google-btn rpl" data-google-start>${GOOGLE_G}<span>Entrar com Google</span></button>
      <p class="acc-hint">Abre a <strong>página oficial do Google</strong> aqui no app. Você entra na sua conta como sempre; o app nunca vê sua senha e guarda só o login do YouTube, neste celular.</p>
      ${s.status === 'error' ? failure(new Error(s.error || 'Não deu certo.')) : ''}`;
  } else if (s.status === 'saving') {
    body = `<div class="g-live"><span class="g-saving"><span class="btn-spin"></span></span><b>Salvando seu login…</b><span class="meta sm">Isso leva só alguns segundos.</span></div>`;
  } else {
    body = `<button class="google-btn rpl" data-google-start>${GOOGLE_G}<span>Entrar com Google</span></button>
      <p class="acc-hint">Abre uma janela do <strong>${esc(b)}</strong> só para o login. Você entra na página oficial do Google, como sempre; o site nunca vê sua senha e funciona com o ${esc(b)} aberto.</p>
      ${s.status === 'error' ? failure(new Error(s.error || 'Não deu certo.')) : ''}`;
  }
  return `${methodSwitch()}<div id="g-box">${body}</div>`;
}

function renderGoogle() {
  if (location.hash !== '#/account' || account.connected) return;
  const box = $('#g-box');
  if (box && accMethod() === 'google') box.outerHTML = googleMethod().replace(methodSwitch(), '');
}

async function pollGoogle() {
  clearTimeout(googlePoll);
  try { googleState = await (await fetch('/api/account/google')).json(); } catch {}
  if (googleState.status === 'done') {
    googleState = { status: 'idle' };
    return connected('Conta Google conectada');
  }
  renderGoogle();
  if (['waiting', 'saving'].includes(googleState.status)) googlePoll = setTimeout(pollGoogle, 1000);
}

const fileMethod = () => (IN_APP ? `
  <ol class="acc-steps">
    <li><span>1</span><div>No PC, pegue o arquivo <strong>cookies.txt</strong> que fica na pasta do MeuTube (ou exporte um novo com a extensão <strong>Get cookies.txt LOCALLY</strong>, com o youtube.com aberto e a conta entrada).</div></li>
    <li><span>2</span><div>Mande o arquivo para o celular <strong>só para você mesma</strong>: Google Drive, cabo USB ou “mensagem para mim”.</div></li>
    <li><span>3</span><div>Toque abaixo e escolha o arquivo.</div></li>
  </ol>
  <label class="drop" id="drop" tabindex="0">
    <input type="file" id="cookie-file" accept=".txt,text/plain" hidden>
    <span class="drop-ic">${icon('download', 26)}</span>
    <strong>Escolher o arquivo de login</strong>
    <span class="meta sm">o cookies.txt</span>
  </label>
  <div id="acc-msg" aria-live="polite"></div>` : `${methodSwitch()}
  <p class="acc-hint">Para <strong>Brave, Chrome, Edge</strong> e outros. Funciona com o navegador aberto.</p>
  <ol class="acc-steps">
    <li><span>1</span><div>Instale a extensão <a href="https://chromewebstore.google.com/search/Get%20cookies.txt%20LOCALLY" target="_blank" rel="noopener noreferrer"><strong>Get cookies.txt LOCALLY</strong></a> (gratuita e de código aberto; no Brave ela vem da mesma loja do Chrome).</div></li>
    <li><span>2</span><div>Abra o <strong>youtube.com</strong>, entre na sua conta, clique no ícone da extensão e depois em <strong>Export</strong>.</div></li>
    <li><span>3</span><div>Arraste aqui o arquivo que foi baixado.</div></li>
  </ol>
  <label class="drop" id="drop" tabindex="0">
    <input type="file" id="cookie-file" accept=".txt,text/plain" hidden>
    <span class="drop-ic">${icon('download', 26)}</span>
    <strong>Arraste o arquivo aqui</strong>
    <span class="meta sm">ou clique para escolher o arquivo .txt</span>
  </label>
  <div id="acc-msg" aria-live="polite"></div>`);

async function connected(msg) {
  await loadAccount();
  store.set('chip', 'Para você');
  toast(msg);
  accountView();
  $('.acc-card')?.classList.add('celebrate');
  burst($('.acc-key'), 28);
}

async function uploadCookies(file) {
  const drop = $('#drop');
  const msg = $('#acc-msg');
  if (!file || !drop) return;
  if (file.size > 3e6) { msg.innerHTML = failure(new Error('Esse arquivo é grande demais para ser um arquivo de login.')); return; }
  drop.classList.add('busy');
  drop.querySelector('strong').textContent = 'Conectando…';
  msg.innerHTML = '';
  try {
    await send('/api/account/cookies', { text: await file.text() });
    await connected('Conta do YouTube conectada');
  } catch (e) {
    drop.classList.remove('busy');
    drop.querySelector('strong').textContent = IN_APP ? 'Escolher o arquivo de login' : 'Arraste o arquivo aqui';
    msg.innerHTML = failure(e);
  }
}

// Arrastar e soltar o arquivo de login (os eventos ficam no document porque a tela é redesenhada).
document.addEventListener('change', (e) => { if (e.target.id === 'cookie-file') uploadCookies(e.target.files[0]); });
document.addEventListener('dragover', (e) => {
  const d = e.target.closest?.('#drop');
  if (!d) return;
  e.preventDefault();
  d.classList.add('over');
});
document.addEventListener('dragleave', (e) => e.target.closest?.('#drop')?.classList.remove('over'));
document.addEventListener('drop', (e) => {
  const d = e.target.closest?.('#drop');
  if (!d) return;
  e.preventDefault();
  d.classList.remove('over');
  uploadCookies(e.dataTransfer.files[0]);
});
document.addEventListener('keydown', (e) => { if (e.target.id === 'drop' && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); $('#cookie-file').click(); } });

async function connectAccount(btn) {
  const msg = $('#acc-msg');
  btn.disabled = true;
  btn.classList.add('busy');
  btn.innerHTML = '<span class="btn-spin"></span>Conectando…';
  msg.innerHTML = '';
  try {
    await send('/api/account', { browser: pickedBrowser, profile: $('#acc-profile')?.value || '' });
    await connected('Conta do YouTube conectada');
  } catch (e) {
    msg.innerHTML = failure(e);
    btn.disabled = false;
    btn.classList.remove('busy');
    btn.textContent = 'Tentar de novo';
  }
}

// ---------- downloads ----------
const DL_LABELS = { 2160: '4K', 1440: '2K', 1080: 'Full HD', 720: 'HD', 480: 'Qualidade padrão', 360: 'Arquivo leve' };
const downloads = new Map();

function downloadMenu(info) {
  const heights = info.downloads?.length ? info.downloads : info.qualities.map((q) => q.height);
  return `<div class="dl-wrap">
    <button class="pill rpl" data-dl-toggle aria-expanded="false" aria-haspopup="menu">${icon('download', 20)}Baixar</button>
    <div class="dl-menu" role="menu" hidden>
      <div class="dl-sec">${icon('video', 18)}Vídeo · MP4</div>
      ${heights.map((h) => `<button class="dl-item" role="menuitem" data-dl="mp4" data-h="${h}"><span class="dl-q">${h}p${h >= 1080 ? `<b class="hd">${h >= 1440 ? '2K' : 'HD'}</b>` : ''}</span><span class="dl-hint">${DL_LABELS[h] || ''}</span></button>`).join('')}
      <div class="dl-sec">${icon('music', 18)}Áudio · MP3</div>
      <button class="dl-item" role="menuitem" data-dl="mp3"><span class="dl-q">MP3</span><span class="dl-hint">Melhor qualidade, com capa</span></button>
    </div>
  </div>`;
}

function closeDlMenus(except) {
  $$('.dl-menu').forEach((m) => {
    if (m === except) return;
    m.hidden = true;
    m.previousElementSibling?.setAttribute('aria-expanded', 'false');
  });
}

async function startDownload(id, kind, height) {
  const v = known.get(id) || { id, title: 'Vídeo' };
  try {
    const job = await send('/api/download', { id, kind, height });
    downloads.set(job.id, { ...job, title: v.title, thumb: thumbUrl(v) });
    renderDock();
    pollDownload(job.id);
    toast(kind === 'mp3' ? 'Baixando o MP3…' : `Baixando o vídeo em ${height}p…`);
  } catch (e) {
    toast(e.message);
  }
}

async function pollDownload(jobId) {
  const d = downloads.get(jobId);
  if (!d || ['done', 'error', 'canceled'].includes(d.status)) return;
  try {
    const r = await fetch('/api/download/' + jobId);
    if (r.ok) Object.assign(d, await r.json());
  } catch {}
  renderDock();
  if (d.status === 'done') {
    const a = document.createElement('a');
    a.href = `/api/download/${jobId}/file`;
    a.download = d.name || '';
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast('Download concluído');
    setTimeout(() => dismissDownload(jobId), 9000);
    return;
  }
  if (d.status === 'error') return;
  setTimeout(() => pollDownload(jobId), 700);
}

function dismissDownload(jobId) {
  const el = document.getElementById('dl-' + jobId);
  if (!el) { downloads.delete(jobId); return; }
  el.classList.add('leaving');
  setTimeout(() => { downloads.delete(jobId); renderDock(); }, 350);
}

const fmtSize = (b) => (b > 1e9 ? `${(b / 1e9).toFixed(1).replace('.', ',')} GB` : `${Math.max(0.1, b / 1e6).toFixed(1).replace('.', ',')} MB`);
function renderDock() {
  const dock = $('#dock');
  for (const [jobId, d] of downloads) {
    let el = document.getElementById('dl-' + jobId);
    if (!el) {
      dock.insertAdjacentHTML('beforeend', `<div class="dl-card" id="dl-${jobId}">
        <div class="dl-thumb"><img src="${esc(d.thumb)}" alt=""><span class="dl-kind">${d.kind === 'mp3' ? 'MP3' : `${d.height}p`}</span></div>
        <div class="dl-info"><strong>${esc(d.title)}</strong><span class="dl-status"></span><div class="dl-bar"><i></i></div></div>
        <button class="icon-btn dl-x" data-dl-cancel="${jobId}" aria-label="Cancelar ou fechar">${icon('x', 18)}</button>
      </div>`);
      el = document.getElementById('dl-' + jobId);
    }
    el.dataset.state = d.status;
    const pct = Math.round(d.percent || 0);
    el.querySelector('.dl-bar i').style.width = `${d.status === 'error' ? 100 : pct}%`;
    el.querySelector('.dl-status').innerHTML = {
      starting: 'Preparando…',
      downloading: dot(`${pct}%`, d.speed, d.eta ? `faltam ${d.eta}` : ''),
      processing: d.kind === 'mp3' ? 'Convertendo para MP3…' : 'Juntando vídeo e áudio…',
      done: `${icon('check', 14)} Pronto · ${fmtSize(d.size || 0)} · <a href="/api/download/${jobId}/file" download>salvar de novo</a>`,
      error: esc(d.error || 'Falhou'),
      canceled: 'Cancelado',
    }[d.status] || '';
  }
  $$('.dl-card', dock).forEach((el) => { if (!downloads.has(el.id.slice(3))) el.remove(); });
}

// ---------- animações ----------
// Confete saindo de um elemento (inscrever-se, conta conectada).
function burst(el, n = 18) {
  if (!el || reduced) return;
  const r = el.getBoundingClientRect();
  const colors = ['#2f8cff', '#38c6ff', '#8ef0ff', '#ffd166', '#5eead4'];
  for (let i = 0; i < n; i++) {
    const s = document.createElement('i');
    const a = (Math.PI * 2 * i) / n + Math.random() * 0.5;
    const d = 46 + Math.random() * 46;
    s.className = 'confetti';
    s.style.cssText = `left:${r.left + r.width / 2}px;top:${r.top + r.height / 2}px;background:${colors[i % colors.length]};--x:${Math.cos(a) * d}px;--y:${Math.sin(a) * d - 24}px;--r:${Math.random() * 540 - 270}deg`;
    document.body.appendChild(s);
    setTimeout(() => s.remove(), 900);
  }
}

// Indicador em degradê que desliza até o chip ativo.
function moveChipInd() {
  $$('.chips.has-ind').forEach((bar) => {
    const ind = bar.querySelector('.chip-ind');
    const on = bar.querySelector('.chip.on');
    if (!ind || !on) return;
    ind.style.width = `${on.offsetWidth}px`;
    ind.style.transform = `translateX(${on.offsetLeft}px)`;
    if (bar.scrollWidth > bar.clientWidth) on.scrollIntoView({ block: 'nearest', inline: 'center', behavior: reduced ? 'auto' : 'smooth' });
  });
}

// Revelação ao rolar: cada card entra quando aparece na tela, em cascata.
const io = 'IntersectionObserver' in window && !reduced ? new IntersectionObserver((entries) => {
  let n = 0;
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    e.target.style.setProperty('--d', `${Math.min(n++, 10) * 55}ms`);
    e.target.classList.add('in');
    io.unobserve(e.target);
  }
}, { rootMargin: '0px 0px -6% 0px', threshold: 0.06 }) : null;
function reveal() {
  if (!io) return;
  $$('.card:not(.sk):not([data-rv]), .row-card:not(.sk):not([data-rv]), .compact:not(.sk):not([data-rv])').forEach((el) => {
    el.dataset.rv = '1';
    el.classList.add('rv');
    io.observe(el);
  });
}

// Fotos dos canais: troca as iniciais pelas fotos reais assim que o servidor as encontra.
const avatarCache = new Map();
let hydrateTimer;
function hydrateAvatars() {
  clearTimeout(hydrateTimer);
  hydrateTimer = setTimeout(async () => {
    const spans = $$('span.avatar[data-cid]');
    if (!spans.length) return;
    const need = [...new Set(spans.map((s) => s.dataset.cid))].filter((id) => !avatarCache.has(id)).slice(0, 60);
    if (need.length) {
      need.forEach((id) => avatarCache.set(id, null));
      try {
        const r = await (await fetch('/api/avatars?ids=' + need.join(','))).json();
        need.forEach((id) => avatarCache.set(id, r[id] || ''));
      } catch {
        need.forEach((id) => avatarCache.delete(id));
      }
    }
    $$('span.avatar[data-cid]').forEach((s) => {
      const url = avatarCache.get(s.dataset.cid);
      if (!url) return;
      const img = new Image();
      img.className = `${s.className} av-in`;
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      img.onload = () => { if (s.isConnected) s.replaceWith(img); };
      img.src = url;
    });
    for (const v of known.values()) if (!v.avatar && avatarCache.get(v.channelId)) v.avatar = avatarCache.get(v.channelId);
  }, 80);
}
// DeArrow: troca títulos e miniaturas sensacionalistas pelos que a comunidade escreveu e escolheu (Ajustes).
// O título original continua ao parar o mouse em cima. A miniatura só troca depois de carregar (a base às vezes
// ainda está gerando a imagem; aí fica a do YouTube).
const brandCache = new Map(); // id -> { title, thumb } | null
const brandWait = new Map(); // id -> pedido em andamento (a lista pode ser redesenhada antes da resposta chegar)
async function loadBranding(ids) {
  ids = [...new Set(ids)];
  const need = ids.filter((id) => !brandCache.has(id) && !brandWait.has(id)).slice(0, 60);
  if (need.length) {
    const job = fetch('/api/branding?ids=' + need.join(',')).then((r) => r.json())
      .then((r) => { need.forEach((id) => brandCache.set(id, r[id] || null)); return true; })
      .catch(() => false)
      .finally(() => need.forEach((id) => brandWait.delete(id)));
    need.forEach((id) => brandWait.set(id, job));
  }
  return (await Promise.all([...new Set(ids.map((id) => brandWait.get(id)).filter(Boolean))])).every(Boolean);
}
let brandTimer;
function hydrateBranding() {
  if (!lib.settings().dearrow) return;
  clearTimeout(brandTimer);
  brandTimer = setTimeout(async () => {
    const cards = $$('article[data-vid]:not([data-br])');
    if (!cards.length) return;
    if (!(await loadBranding(cards.map((c) => c.dataset.vid)))) return; // DeArrow fora do ar: tenta na próxima tela
    const titles = lib.settings().dearrowTitles;
    for (const card of $$('article[data-vid]:not([data-br])')) {
      if (!brandCache.has(card.dataset.vid)) continue; // passou do limite deste pedido: vai no próximo
      card.dataset.br = '1';
      const b = brandCache.get(card.dataset.vid);
      const a = b?.title && titles && card.querySelector('a.title');
      if (a) { a.title = `Título original: ${a.textContent}`; a.textContent = b.title; }
      const img = b?.thumb && card.querySelector('.thumb img');
      if (img) {
        const pic = new Image();
        pic.onload = () => { if (img.isConnected && pic.naturalWidth > 1) img.src = pic.src; };
        pic.src = b.thumb;
      }
    }
    if ($('article[data-vid]:not([data-br])')) hydrateBranding();
  }, 120);
}
// Cada "Carregando…" de limite tenta a tela de novo sozinho, esperando um pouco mais a cada vez.
function armBlocked() {
  if (!document.querySelector('[data-blocked]')) retryCount.delete(location.hash); // carregou: zera a espera
  $$('[data-blocked]:not([data-armed])').forEach((el) => {
    el.dataset.armed = '1';
    const t = token;
    const key = location.hash;
    const n = retryCount.get(key) || 0;
    retryCount.set(key, n + 1);
    const secs = RETRY_STEPS[Math.min(n, RETRY_STEPS.length - 1)];
    setTimeout(() => { if (el.isConnected && t === token) { apiCache.clear(); route(); } }, secs * 1000);
  });
}
new MutationObserver(() => { reveal(); hydrateAvatars(); hydrateBranding(); armBlocked(); }).observe(document.body, { childList: true, subtree: true });

// Miniaturas inclinam em 3D e ganham um brilho que segue o mouse.
if (matchMedia('(pointer: fine)').matches && !reduced) {
  let tilted = null;
  document.addEventListener('pointermove', (e) => {
    const t = e.target.closest?.('.card .thumb-wrap, .row-card .thumb-wrap');
    if (tilted && tilted !== t) { tilted.style.transform = ''; tilted.classList.remove('tilt'); }
    tilted = t;
    if (!t) return;
    const r = t.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    t.classList.add('tilt');
    t.style.setProperty('--mx', `${x * 100}%`);
    t.style.setProperty('--my', `${y * 100}%`);
    t.style.transform = `perspective(900px) rotateX(${(0.5 - y) * 7}deg) rotateY(${(x - 0.5) * 9}deg) translateY(-6px)`;
  }, { passive: true });
  document.addEventListener('pointerdown', () => { if (document.querySelector('.thumb-wrap.tilt')) $$('.thumb-wrap.tilt').forEach((t) => { t.style.transform = ''; t.classList.remove('tilt'); }); });
}

// Topo ganha vidro ao rolar; botão de voltar ao topo aparece longe do início.
let scrollTick = false;
addEventListener('scroll', () => {
  if (scrollTick) return;
  scrollTick = true;
  requestAnimationFrame(() => {
    body.classList.toggle('scrolled', scrollY > 8);
    body.classList.toggle('far', scrollY > 900);
    scrollTick = false;
  });
}, { passive: true });
$('#to-top').addEventListener('click', () => window.scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' }));

// ---------- efeito de toque (ripple) ----------
document.addEventListener('pointerdown', (e) => {
  const el = e.target.closest('.rpl');
  if (!el || reduced) return;
  const r = el.getBoundingClientRect();
  const size = Math.max(r.width, r.height) * 2;
  const s = document.createElement('span');
  s.className = 'ripple';
  s.style.cssText = `width:${size}px;height:${size}px;left:${e.clientX - r.left - size / 2}px;top:${e.clientY - r.top - size / 2}px`;
  el.appendChild(s);
  const done = () => { s.classList.add('out'); setTimeout(() => s.remove(), 400); };
  el.addEventListener('pointerup', done, { once: true });
  el.addEventListener('pointerleave', done, { once: true });
});

// ---------- eventos ----------
document.addEventListener('click', (e) => {
  if (!e.target.closest('.dl-wrap')) closeDlMenus();
  const el = e.target.closest('[data-later], [data-sub], [data-chip], [data-filter], [data-seek], [data-clear], [data-share], [data-menu], [data-scrim], [data-dl-toggle], [data-dl], [data-dl-cancel], [data-src], [data-browser], [data-connect], [data-disconnect], [data-retry-now], [data-method], [data-google-start], [data-google-done], [data-google-cancel], [data-rate], [data-bg], [data-goto-comments], [data-switch-account], #desc, a[href^="#/"]');
  if (!el) return;

  if (el.hasAttribute('data-dl-toggle')) {
    const menu = el.nextElementSibling;
    closeDlMenus(menu);
    menu.hidden = !menu.hidden;
    el.setAttribute('aria-expanded', String(!menu.hidden));
    // Abre para a esquerda (alinhado pela direita do botão); se não couber, porque o Baixar caiu no começo da linha, abre para a direita.
    menu.classList.toggle('to-right', !menu.hidden && el.getBoundingClientRect().right - menu.offsetWidth < 8);
    if (!menu.hidden) menu.querySelector('button')?.focus({ preventScroll: true });
    return;
  }
  if (el.dataset.dl) {
    closeDlMenus();
    const id = location.hash.match(/watch\/([\w-]{11})/)?.[1];
    if (id) startDownload(id, el.dataset.dl, Number(el.dataset.h) || 1080);
    return;
  }
  if (el.dataset.dlCancel) {
    const d = downloads.get(el.dataset.dlCancel);
    if (d && !['done', 'error', 'canceled'].includes(d.status)) {
      d.status = 'canceled';
      send('/api/download/' + el.dataset.dlCancel, null, 'DELETE').catch(() => {});
      renderDock();
    }
    dismissDownload(el.dataset.dlCancel);
    return;
  }
  if (el.dataset.src) {
    const [key, v] = el.dataset.src.split(':');
    store.set('src:' + key, v);
    return route();
  }
  if (el.hasAttribute('data-retry-now')) return route();
  if (el.hasAttribute('data-google-start') && IN_APP) {
    // Celular: a janela de login é do próprio app; ela devolve o cookies.txt, que entra como o arquivo de login.
    window.meutubeNative.googleLogin()
      .then(async (text) => {
        googleState = { status: 'saving' };
        renderGoogle();
        await send('/api/account/cookies', { text });
        googleState = { status: 'idle' };
        await connected('Conta Google conectada');
      })
      .catch((err) => {
        googleState = /cancel/i.test(err.message) ? { status: 'idle' } : { status: 'error', error: err.message };
        renderGoogle();
      });
    return;
  }
  if (el.hasAttribute('data-google-start')) {
    googleState = { status: 'waiting', browser: account.loginBrowser };
    renderGoogle();
    send('/api/account/google').then((s) => { googleState = s; renderGoogle(); pollGoogle(); }).catch((err) => { googleState = { status: 'error', error: err.message }; renderGoogle(); });
    return;
  }
  if (el.hasAttribute('data-google-done')) {
    send('/api/account/google/done').then(pollGoogle).catch(() => {});
    googleState = { ...googleState, status: 'saving' };
    return renderGoogle();
  }
  if (el.hasAttribute('data-google-cancel')) {
    clearTimeout(googlePoll);
    send('/api/account/google', null, 'DELETE').catch(() => {});
    googleState = { status: 'idle' };
    return renderGoogle();
  }
  if (el.dataset.method) {
    store.set('accMethod2', el.dataset.method);
    return accountView();
  }
  if (el.dataset.browser) {
    pickedBrowser = el.dataset.browser;
    $$('[data-browser]').forEach((b) => { const on = b.dataset.browser === pickedBrowser; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); });
    return;
  }
  if (el.hasAttribute('data-connect')) return connectAccount(el);
  if (el.dataset.rate) {
    if (!account.connected) return toast('Conecte sua conta do YouTube (em Mim) para curtir.');
    const box = $('#w-votes');
    const id = location.hash.match(/watch\/([\w-]{11})/)?.[1];
    if (!box || !id) return;
    const before = { like: box.dataset.like, likes: box.dataset.likes, dislikes: box.dataset.dislikes };
    const next = before.like === el.dataset.rate ? 'INDIFFERENT' : el.dataset.rate;
    // Mostra na hora; se o YouTube recusar, volta como estava.
    const bump = (k, d) => { if (box.dataset[k] != null) box.dataset[k] = Math.max(0, Number(box.dataset[k]) + d); };
    if (before.like === 'LIKE') bump('likes', -1);
    if (before.like === 'DISLIKE') bump('dislikes', -1);
    if (next === 'LIKE') bump('likes', 1);
    if (next === 'DISLIKE') bump('dislikes', 1);
    box.dataset.like = next;
    renderVotes();
    if (next === 'LIKE') burst(el, 14);
    send('/api/rate', { id, status: next })
      .then(() => toast(next === 'LIKE' ? 'Adicionado aos vídeos com “Gostei”' : next === 'DISLIKE' ? 'Você não gostou deste vídeo' : 'Avaliação removida'))
      .catch((err) => { Object.assign(box.dataset, before); renderVotes(); toast(err.message); });
    return;
  }
  if (el.hasAttribute('data-bg')) {
    if (!player) return;
    const on = !player.audioOnly;
    player.setAudioOnly(on, false);
    el.setAttribute('aria-pressed', String(on));
    el.querySelector('.pl-long').textContent = on ? 'Voltar para o vídeo' : 'Ouvir em segundo plano';
    el.querySelector('.pl-short').textContent = on ? 'Ver vídeo' : 'Segundo plano';
    el.classList.toggle('on', on);
    toast(on ? (IN_APP ? 'Só o som: pode sair do app ou apagar a tela' : 'Só o som, economizando dados') : 'Vídeo de volta');
    return;
  }
  if (el.hasAttribute('data-goto-comments')) {
    $('#w-comments')?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
    return;
  }
  if (el.hasAttribute('data-switch-account')) {
    // Trocar de conta: sai desta e já abre a entrada de novo (no app, a página do Google).
    send('/api/account', null, 'DELETE').then(async () => {
      await loadAccount();
      accountView();
      if (IN_APP) $('[data-google-start]')?.click();
    }).catch((err) => toast(err.message));
    return;
  }
  if (el.hasAttribute('data-disconnect')) {
    send('/api/account', null, 'DELETE').then(async () => { await loadAccount(); toast('Conta desconectada'); accountView(); }).catch((err) => toast(err.message));
    return;
  }

  if (el.dataset.later) {
    e.preventDefault();
    const on = toggleLater(el.dataset.later);
    el.classList.toggle('on', on);
    el.classList.toggle('saved', on);
    el.setAttribute('aria-pressed', String(on));
    if (el.classList.contains('pill')) el.innerHTML = icon(on ? 'check' : 'clock', 20) + `<span>${on ? 'Salvo' : 'Mais tarde'}</span>`;
    else { el.innerHTML = icon(on ? 'check' : 'clock', 18); el.dataset.tip = on ? 'Salvo' : 'Assistir mais tarde'; }
    el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');
    toast(on ? 'Salvo em Assistir mais tarde' : 'Removido de Assistir mais tarde');
    if (location.hash === '#/later' && !on) el.closest('.row-card')?.remove();
    return;
  }
  if (el.dataset.sub && account.connected && !subs().some((x) => x.id === el.dataset.sub)) {
    // Conta conectada: a inscrição vai para a sua conta do YouTube.
    const c = { id: el.dataset.sub, name: el.dataset.name, avatar: el.dataset.avatar };
    const on = !accountChannels.some((x) => x.id === c.id);
    const before = accountChannels;
    accountChannels = on ? [...accountChannels, c] : accountChannels.filter((x) => x.id !== c.id);
    refreshSubButtons(c);
    if (on) burst($(`[data-sub="${c.id}"].sub-btn`));
    send('/api/subscribe', { channelId: c.id, on })
      .then(() => { toast(on ? `Inscrita em ${c.name}` : 'Inscrição cancelada'); renderGuide(); })
      .catch((err) => { accountChannels = before; refreshSubButtons(c); toast(err.message); });
    return;
  }
  if (el.dataset.sub) {
    const on = toggleSub(el.dataset.sub, el.dataset.name, el.dataset.avatar);
    toast(on ? `Inscrição em ${el.dataset.name} adicionada` : 'Inscrição cancelada');
    if (location.hash === '#/subs') return route();
    const c = { id: el.dataset.sub, name: el.dataset.name, avatar: el.dataset.avatar };
    $$(`[data-sub="${c.id}"].sub-btn`).forEach((b) => {
      const lg = b.classList.contains('lg') ? 'lg' : '';
      b.outerHTML = subButton(c, `${lg} ${on ? 'just' : ''}`);
    });
    if (on) burst($(`[data-sub="${c.id}"].sub-btn`));
    return;
  }
  if (el.dataset.chip) return loadChip(el.dataset.chip, token);
  if (el.dataset.filter) return renderResults(el.dataset.filter);
  if (el.dataset.seek) {
    if (player) { player.seek(Number(el.dataset.seek)); player.play(); window.scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' }); }
    return;
  }
  if (el.dataset.share) {
    const url = `https://www.youtube.com/watch?v=${el.dataset.share}`;
    navigator.clipboard?.writeText(url).then(() => toast('Link copiado'), () => toast(url));
    return;
  }
  if (el.hasAttribute('data-clear')) {
    store.set('history', []);
    store.set('progress', {});
    toast('Histórico limpo');
    return route();
  }
  if (el.hasAttribute('data-menu')) return toggleGuide();
  if (el.hasAttribute('data-scrim')) return body.classList.remove('drawer-open');
  if (el.id === 'desc') {
    if (e.target.closest('a, .ts')) return;
    const open = !el.classList.contains('open');
    if (!open && !e.target.closest('.d-less')) return;
    el.classList.toggle('open', open);
    el.setAttribute('aria-expanded', String(open));
    return;
  }
  if (el.tagName === 'A') {
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    const from = el.hasAttribute('data-watch') ? el.closest('article')?.querySelector('.thumb') : null;
    go(el.getAttribute('href'), from);
  }
});

$('#search').addEventListener('submit', (e) => {
  e.preventDefault();
  const term = $('#q').value.trim();
  if (term) { $('#q').blur(); go('#/search/' + encodeURIComponent(term)); }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { body.classList.remove('drawer-open'); closeDlMenus(); }
  if (e.key === '/' && !e.target.closest('input, textarea')) { e.preventDefault(); $('#q').focus(); $('#q').select(); }
});

addEventListener('resize', () => { layout(); moveChipInd(); });
addEventListener('popstate', () => { fromPop = true; route(); });
addEventListener('meutube-toast', (e) => toast(e.detail)); // avisos vindos do app de celular
$('[data-logo]').innerHTML = logo();
document.fonts?.ready.then(moveChipInd);
renderGuide();
sync.syncNow().catch(() => {}); // traz as estatísticas do outro aparelho e manda as deste
// A conta chega depois da primeira tela: as telas que dependem dela são desenhadas de novo (vídeo e Shorts não,
// para não recomeçar o que está tocando).
loadAccount().then(() => {
  if (account.connected && /^(#\/?(subs|library|liked|later|history)?)?$/.test(location.hash)) route();
  if (location.hash === '#/account') accountView();
});
route();
