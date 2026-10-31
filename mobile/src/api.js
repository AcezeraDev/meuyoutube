// O "servidor" do app de celular: responde as mesmas rotas /api/... do server.js, mas falando direto com o
// YouTube a partir do aparelho. Não depende de navegador nem de Node: quem usa passa fetch, sha1 e um lugar
// para guardar dados (no celular, o fetch nativo do Capacitor e o localStorage; nos testes, o Node).
//
// Divisão do trabalho:
// - links de vídeo: youtubei.js com o cliente ANDROID_VR (links diretos do googlevideo, sem decifrar nada);
// - todo o resto (busca, canais, feeds, comentários, chat, perfil): a API interna do youtube.com pelo lib/yt-web.js,
//   a mesma do servidor do PC, com o login por cookies.
import { Innertube } from 'youtubei.js';
import ytw from '../../lib/yt-web.js';

const { parseCookies, hasLogin, makeInnertube, dig, dig1, txt } = ytw;
const VIDEO_ID = /^[\w-]{11}$/;
const CHANNEL_ID = /^UC[\w-]{22}$/;
const MIN = 60e3;
const YT_LINE = /^(#HttpOnly_)?\.?([\w-]+\.)*youtube\.com\t/i;
const https = (u) => (u && u.startsWith('//') ? 'https:' + u : u || '');
const norm = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

// ---------- leitura de números e datas em português ----------
// "4,03 mi de inscritos" -> 4030000; "1.234 visualizações" -> 1234; "12 mil" -> 12000.
export function ptNum(s) {
  const m = /(\d[\d.,]*)\s*(mil|mi|bi|k|m|b)?\b/i.exec(String(s || '').replace(/ /g, ' '));
  if (!m) return 0;
  const mult = { mil: 1e3, k: 1e3, mi: 1e6, m: 1e6, bi: 1e9, b: 1e9 }[(m[2] || '').toLowerCase()] || 1;
  const n = mult > 1 ? parseFloat(m[1].replace(/\./g, '').replace(',', '.')) : Number(m[1].replace(/[.,]/g, ''));
  return Math.round(n * mult) || 0;
}
// "1:02:03" -> 3723
const clock = (s) => (/^\d+(:\d{2}){1,2}$/.test(String(s || '').trim()) ? String(s).trim().split(':').reduce((a, b) => a * 60 + Number(b), 0) : 0);
const ymd = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
// "há 3 dias" / "31 de out. de 2026" / "Estreou em 2 de jan. de 2020" -> "AAAAMMDD" (o formato que a tela usa).
export function ptDate(s) {
  s = String(s || '').toLowerCase();
  const abs = /(\d{1,2}) de ([a-zç]{3})[a-zç]*\.? de (\d{4})/.exec(s);
  if (abs && MONTHS.includes(abs[2])) return ymd(new Date(+abs[3], MONTHS.indexOf(abs[2]), +abs[1]));
  const rel = /há (\d+) (segundo|minuto|hora|dia|semana|m[eê]s|meses|ano)/.exec(s);
  if (!rel) return '';
  const days = { segundo: 0, minuto: 0, hora: 0, dia: 1, semana: 7, mes: 30, mês: 30, meses: 30, ano: 365 }[rel[2]] * Number(rel[1]);
  return ymd(new Date(Date.now() - days * 864e5));
}

// ---------- leitura genérica das listas do YouTube ----------
// As respostas mudam de formato com frequência (videoRenderer, lockupViewModel...). Em vez de seguir um caminho fixo,
// procura em qualquer profundidade tudo que tenha cara de vídeo ou de canal.
const VIDEO_KEYS = ['videoRenderer', 'compactVideoRenderer', 'gridVideoRenderer', 'playlistVideoRenderer', 'videoWithContextRenderer', 'playlistPanelVideoRenderer'];
const CHANNEL_KEYS = ['channelRenderer', 'gridChannelRenderer'];
function walk(o, visit, seen = new Set()) {
  if (!o || typeof o !== 'object' || seen.has(o)) return;
  seen.add(o);
  if (visit(o)) return;
  for (const v of Object.values(o)) walk(v, visit, seen);
}
const allText = (o) => {
  const out = [];
  walk(o, (x) => {
    if (typeof x.content === 'string') out.push(x.content);
    if (typeof x.simpleText === 'string') out.push(x.simpleText);
    if (Array.isArray(x.runs)) out.push(x.runs.map((r) => r.text || '').join(''));
    if (typeof x.text === 'string') out.push(x.text);
  });
  return out.filter(Boolean);
};
const bestThumb = (list) => https(((list || []).filter((t) => t.url && (t.width || 0) >= 320).sort((a, b) => a.width - b.width)[0] || (list || []).slice(-1)[0])?.url);
const lastUrl = (list) => https((list || []).slice(-1)[0]?.url);
const isVerified = (o) => /VERIFIED|CHECK_CIRCLE/.test(JSON.stringify(o || ''));
const channelOf = (o) => {
  const ids = dig(o, 'browseEndpoint').filter((b) => CHANNEL_ID.test(b?.browseId || ''));
  return ids[0] || {};
};
const LIVE_RE = /^(ao vivo|live|aovivo)$/i;

function fromRenderer(r) {
  const owner = r.ownerText || r.longBylineText || r.shortBylineText;
  const ch = channelOf(owner || r);
  const overlays = JSON.stringify(r.thumbnailOverlays || '');
  const badgeTexts = allText(r.badges || []);
  const live = /"style":"LIVE"|LIVE_NOW/.test(overlays + JSON.stringify(r.badges || '')) || badgeTexts.some((t) => LIVE_RE.test(t.trim()));
  const timeTxt = txt(r.lengthText) || txt(dig1(r.thumbnailOverlays, 'thumbnailOverlayTimeStatusRenderer')?.text);
  const viewsTxt = txt(r.viewCountText) || txt(r.shortViewCountText);
  return {
    id: r.videoId,
    title: txt(r.title) || txt(r.headline),
    channel: txt(owner).split(' e ')[0] || '',
    channelId: ch.browseId || r.channelId || '',
    verified: isVerified(r.ownerBadges),
    avatar: lastUrl(dig1(r.channelThumbnailSupportedRenderers || r.channelThumbnail || {}, 'thumbnails')),
    duration: live ? 0 : clock(timeTxt) || Number(r.lengthSeconds) || 0,
    views: ptNum(viewsTxt),
    live,
    date: ptDate(txt(r.publishedTimeText)),
    description: (txt(r.descriptionSnippet) || txt(dig1(r.detailedMetadataSnippets, 'snippetText'))).slice(0, 200),
    thumb: bestThumb(r.thumbnail?.thumbnails),
  };
}

function fromLockup(l) {
  if (!VIDEO_ID.test(l.contentId || '') || (l.contentType && !/VIDEO/.test(l.contentType))) return null;
  const md = l.metadata?.lockupMetadataViewModel || {};
  const parts = dig(md.metadata, 'metadataParts').flat().map((p) => p?.text?.content || '').filter(Boolean);
  const overlayText = allText(l.contentImage).map((t) => t.trim());
  const live = overlayText.some((t) => LIVE_RE.test(t)) || /LIVE/.test(JSON.stringify(dig(l.contentImage, 'badgeStyle')));
  const ch = channelOf(md);
  return {
    id: l.contentId,
    title: md.title?.content || '',
    channel: parts.find((p) => !/visualiza|assistindo|há \d|inscrit/i.test(p)) || '',
    channelId: ch.browseId || '',
    verified: isVerified(md.metadata),
    avatar: lastUrl(dig1(md.image, 'sources')),
    duration: live ? 0 : clock(overlayText.find((t) => clock(t))),
    views: ptNum(parts.find((p) => /visualiza|assistindo/i.test(p))),
    live,
    date: ptDate(parts.find((p) => /há \d/i.test(p))),
    description: '',
    thumb: bestThumb(dig1(l.contentImage, 'sources')),
  };
}

export function videosFrom(json, channel = {}) {
  const out = [];
  const seen = new Set();
  walk(json, (o) => {
    let v = null;
    const key = VIDEO_KEYS.find((k) => o[k]);
    if (key) v = o[key].videoId ? fromRenderer(o[key]) : null;
    else if (o.lockupViewModel) v = fromLockup(o.lockupViewModel);
    else return CHANNEL_KEYS.some((k) => o[k]); // canais e anúncios: não entra
    if (v && VIDEO_ID.test(v.id) && v.title && !seen.has(v.id)) {
      seen.add(v.id);
      out.push({
        ...v,
        channel: v.channel || channel.name || '',
        channelId: v.channelId || channel.id || '',
        avatar: v.avatar || channel.avatar || '',
        verified: v.verified || Boolean(channel.verified),
      });
    }
    return true;
  });
  return out;
}

export function channelsFrom(json) {
  const out = [];
  walk(json, (o) => {
    const key = CHANNEL_KEYS.find((k) => o[k]);
    if (!key) return false;
    const c = o[key];
    if (!CHANNEL_ID.test(c.channelId || '')) return true;
    // Na busca o YouTube trocou os campos: "subscriberCountText" traz o @ e "videoCountText" os inscritos.
    const texts = [txt(c.subscriberCountText), txt(c.videoCountText)];
    out.push({
      id: c.channelId,
      name: txt(c.title),
      handle: texts.find((t) => t.startsWith('@')) || (c.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl || '').replace(/^\//, '').replace(/^(?!@).*/, ''),
      followers: ptNum(texts.find((t) => /inscrit/i.test(t))),
      description: txt(c.descriptionSnippet).slice(0, 220),
      verified: isVerified(c.ownerBadges),
      avatar: lastUrl(c.thumbnail?.thumbnails),
    });
    return true;
  });
  return out;
}

// Ficha de continuação (próxima página): o último item da maior lista da resposta. (Há outras fichas soltas,
// como as do filtro "Mais recentes/Populares" do canal, que não são a página seguinte.)
export function nextToken(json) {
  let best = { n: 0, token: '' };
  walk(json, (o) => {
    if (!Array.isArray(o) || o.length < 2) return false;
    const token = dig1(o[o.length - 1]?.continuationItemRenderer, 'continuationCommand')?.token;
    if (token && o.length > best.n) best = { n: o.length, token };
    return false;
  });
  return best.token;
}

// ---------- a "API" ----------
// fetch(url, init): fetch que pode mandar Cookie/User-Agent (no celular, o nativo). sha1(texto) -> hex.
// storage: { get(k), set(k, v), del(k) } com textos.
export function createApi({ fetch, sha1, storage, uuid = () => crypto.randomUUID() }) {
  // ----- login (cookies.txt guardado no aparelho) -----
  let jarMemo = { text: null, jar: {} };
  const jar = () => {
    const text = storage.get('mt_cookies') || '';
    if (text !== jarMemo.text) jarMemo = { text, jar: parseCookies(text) };
    return jarMemo.jar;
  };
  const loggedIn = () => hasLogin(jar());
  const innertube = makeInnertube({ fetch, sha1, getJar: jar });

  // youtubei.js só para os links de vídeo, e sempre sem conta (o cliente ANDROID_VR não aceita login).
  let ytP = null;
  const yt = () => (ytP ||= Innertube.create({ lang: 'pt', location: 'BR', retrieve_player: false, fetch }).catch((e) => { ytP = null; throw e; }));

  // ----- cache em memória -----
  const cache = new Map();
  function cached(key, ttl, fn, fresh = false) {
    const hit = cache.get(key);
    if (!fresh && hit && Date.now() - hit.t < ttl) return hit.p;
    const p = fn();
    cache.set(key, { t: Date.now(), p });
    p.catch(() => { if (cache.get(key)?.p === p) cache.delete(key); });
    if (cache.size > 800) cache.delete(cache.keys().next().value);
    return p;
  }
  const clearFeeds = () => { for (const k of cache.keys()) if (/^(f|pg:f|me):/.test(k)) cache.delete(k); };

  // Listas em páginas: a página N só existe depois de ler a N-1 (cada uma traz a ficha da seguinte).
  async function paged(key, page, ttl, first, parse, fresh = false) {
    const get = (p) => cached(`pg:${key}:${p}`, ttl, async () => {
      if (p === 0) return parse(await first());
      const prev = await get(p - 1);
      if (!prev.next) return { ...parse({}), next: '' };
      return parse(await innertube(prev.endpoint, { continuation: prev.next }));
    }, fresh && p === 0);
    return get(page);
  }

  // ----- busca -----
  const SP = { video: 'EgIQAQ==', live: 'EgJAAQ==', channel: 'EgIQAg==' };
  async function search(q, withChannels, page, live) {
    const parse = (j) => ({ videos: videosFrom(j), next: nextToken(j), endpoint: 'search' });
    const vidReq = paged(`s:${live ? 1 : 0}:${q.toLowerCase()}`, page, 15 * MIN, () => innertube('search', { query: q, params: live ? SP.live : SP.video }), parse);
    const chanReq = !withChannels || page > 0 ? Promise.resolve([]) : cached('sc:' + q.toLowerCase(), 15 * MIN, async () => channelsFrom(await innertube('search', { query: q, params: SP.channel }))).catch(() => []);
    const [r, chans] = await Promise.all([vidReq, chanReq]);
    const nq = norm(q);
    const channels = chans.filter((c) => {
      const n = norm(c.name), h = norm(c.handle);
      return nq.length > 1 && n && (n.includes(nq) || nq.includes(n) || h.includes(nq));
    }).slice(0, 2);
    return { channels, videos: r.videos, more: Boolean(r.next) && page < 20 };
  }

  // ----- canal -----
  const TAB = { videos: 'EgZ2aWRlb3PyBgQKAjoA', streams: 'EgdzdHJlYW1z8gYECgJ6AA==' };
  // Abre uma aba do canal; se o código fixo da aba deixar de valer, procura a aba pelo endereço.
  async function channelTab(id, tab) {
    let j = await innertube('browse', { browseId: id, params: TAB[tab] });
    if (!videosFrom(j).length) {
      const t = dig(j, 'tabRenderer').find((x) => new RegExp(`/${tab}$`).test(x?.endpoint?.commandMetadata?.webCommandMetadata?.url || ''));
      const params = t?.endpoint?.browseEndpoint?.params;
      if (params && params !== TAB[tab]) j = await innertube('browse', { browseId: id, params });
    }
    return j;
  }
  function channelInfo(id, j) {
    const md = dig1(j, 'channelMetadataRenderer') || {};
    const header = dig1(j, 'pageHeaderViewModel') || dig1(j, 'c4TabbedHeaderRenderer') || {};
    const texts = allText(header);
    const handle = decodeURIComponent((/\/(@[^/?]+)/.exec(md.vanityChannelUrl || '') || [])[1] || texts.find((t) => /^@\S+$/.test(t.trim())) || '');
    return {
      id,
      name: md.title || txt(header.title) || '',
      avatar: lastUrl(md.avatar?.thumbnails) || lastUrl(dig1(dig1(header, 'avatar'), 'sources')),
      banner: lastUrl(dig1(dig1(header, 'banner') || {}, 'sources') || header.banner?.thumbnails),
      handle,
      followers: ptNum(texts.find((t) => /inscrit/i.test(t))),
      verified: isVerified(header.title || header.badges),
      description: (md.description || '').slice(0, 300),
    };
  }
  async function channelPage(id, page) {
    const parse = (j) => {
      const info = j.metadata || j.header ? channelInfo(id, j) : null;
      return { info, videos: videosFrom(j), next: nextToken(j), endpoint: 'browse' };
    };
    const first = await paged('c:' + id, 0, 30 * MIN, () => channelTab(id, 'videos'), parse);
    const r = page ? await paged('c:' + id, page, 30 * MIN, null, parse) : first;
    const info = first.info || { id, name: '', avatar: '', verified: false };
    const videos = r.videos.map((v) => ({ ...v, channel: v.channel || info.name, channelId: id, avatar: v.avatar || info.avatar, verified: v.verified || info.verified }));
    return page ? { videos, more: Boolean(r.next) } : { ...info, videos, more: Boolean(r.next) };
  }

  // ----- feeds da conta -----
  const FEEDS = { rec: 'FEwhat_to_watch', subs: 'FEsubscriptions', later: 'VLWL', history: 'FEhistory', liked: 'VLLL', channels: 'FEchannels' };
  async function feed(kind, page, fresh) {
    if (kind === 'channels') return cached('f:channels', 5 * MIN, async () => channelsFrom(await innertube('browse', { browseId: FEEDS.channels })), fresh);
    const parse = (j) => ({ videos: videosFrom(j), next: nextToken(j), endpoint: 'browse' });
    const r = await paged('f:' + kind, page, 5 * MIN, () => innertube('browse', { browseId: FEEDS[kind] }), parse, fresh);
    return { items: r.videos, more: Boolean(r.next) && page < 30 };
  }

  // Playlist do YouTube pelo link (até ~500 vídeos).
  function ytPlaylist(list) {
    return cached('pl:' + list, 30 * MIN, async () => {
      let j = await innertube('browse', { browseId: 'VL' + list });
      const title = dig1(j, 'playlistMetadataRenderer')?.title || txt(dig1(j, 'playlistHeaderRenderer')?.title) || 'Playlist importada';
      const owner = dig1(j, 'playlistHeaderRenderer')?.ownerText || dig1(dig1(j, 'pageHeaderViewModel') || {}, 'avatarStackViewModel')?.text;
      const items = videosFrom(j);
      for (let i = 0; i < 5 && items.length < 500; i++) {
        const tok = nextToken(j);
        if (!tok) break;
        j = await innertube('browse', { continuation: tok });
        const ids = new Set(items.map((v) => v.id));
        items.push(...videosFrom(j).filter((v) => !ids.has(v.id)));
      }
      if (!items.length) throw new Error('Não consegui abrir essa playlist (ela pode ser privada).');
      return { title, channel: txt(owner) || owner?.content || '', items };
    });
  }

  // Lives acontecendo agora nos canais pedidos (aba "Ao vivo" de cada um, guardada por 5 min).
  async function liveNow(ids) {
    const out = [];
    for (const id of ids) {
      try {
        out.push(...(await cached('live:' + id, 5 * MIN, async () => {
          const j = await channelTab(id, 'streams');
          const info = channelInfo(id, j);
          return videosFrom(j, info).slice(0, 3).filter((v) => v.live);
        })));
      } catch {}
    }
    return out;
  }

  // ----- vídeo -----
  const langName = (() => { try { return new Intl.DisplayNames(['pt-BR'], { type: 'language' }); } catch { return null; } })();
  function pickFormats(sd) {
    const formats = (sd?.adaptive_formats || []).filter((f) => f.url);
    // Vídeo sem áudio, um por resolução, até 2K. Até 1080p H.264 (toca em tudo); 1440p só existe em VP9/AV1.
    const MAX_HEIGHT = 1440;
    const codec = (f) => /codecs="([^"]+)"/.exec(f.mime_type || '')?.[1] || '';
    const rank = (f) => (/^avc1/.test(codec(f)) ? 3 : /^vp0?9/.test(codec(f)) ? 2 : /^av01/.test(codec(f)) ? 1 : 0);
    const byHeight = new Map();
    for (const f of formats) {
      if (!/^video\//.test(f.mime_type || '') || !f.height || f.height > MAX_HEIGHT) continue;
      if (!rank(f) || (f.height <= 1080 && rank(f) !== 3)) continue;
      const prev = byHeight.get(f.height);
      if (!prev || rank(f) > rank(prev) || (rank(f) === rank(prev) && (f.bitrate || 0) > (prev.bitrate || 0))) byHeight.set(f.height, f);
    }
    // Uma faixa de áudio por idioma. Preferência: português > original > o resto.
    const byLang = new Map();
    const langOf = (f) => (f.audio_track?.id || '').split('.')[0] || f.language || 'und';
    for (const f of formats) {
      if (!/^audio\/mp4/.test(f.mime_type || '')) continue;
      const prev = byLang.get(langOf(f));
      if (!prev || Boolean(prev.is_drc) > Boolean(f.is_drc) || (!f.is_drc && (f.bitrate || 0) > (prev.bitrate || 0))) byLang.set(langOf(f), f);
    }
    const isOriginal = (f) => Boolean(f.is_original) || /original/i.test(f.audio_track?.display_name || '');
    const score = (f) => (/^pt/i.test(langOf(f)) ? 4 : 0) + (isOriginal(f) ? 2 : 0) + (f.audio_track?.audio_is_default ? 1 : 0);
    const audios = [...byLang.values()].sort((a, b) => score(b) - score(a)).map((f) => {
      const lang = langOf(f) === 'und' ? '' : langOf(f);
      let label = 'Padrão';
      try { if (lang) label = langName?.of(lang) || lang; } catch {}
      label = label.charAt(0).toUpperCase() + label.slice(1);
      return { lang, label: isOriginal(f) && byLang.size > 1 ? `${label} (original)` : label, src: f.url };
    });
    let qualities = [];
    let audio = null;
    if (byHeight.size && audios.length) {
      qualities = [...byHeight.values()].sort((a, b) => b.height - a.height).map((f) => ({ height: f.height, src: f.url, type: f.mime_type }));
      audio = audios[0].src;
    } else {
      const muxed = (sd?.formats || []).filter((f) => f.url).sort((a, b) => (b.height || 0) - (a.height || 0))[0];
      if (muxed) qualities = [{ height: muxed.height || 360, src: muxed.url }];
    }
    const maxHeight = Math.max(0, ...formats.filter((f) => /^video\//.test(f.mime_type || '')).map((f) => f.height || 0));
    return { qualities, audio, audios: audio ? audios : [], maxHeight };
  }

  // Dados da página do vídeo (data, curtidas, canal, capítulos) lidos do "next" do youtube.com.
  function watchMeta(n) {
    const primary = dig1(n, 'videoPrimaryInfoRenderer') || {};
    const owner = dig1(dig1(n, 'videoSecondaryInfoRenderer') || {}, 'videoOwnerRenderer') || {};
    const likeVm = dig1(n, 'likeButtonViewModel');
    const likeA11y = dig(likeVm, 'accessibilityText').find((t) => /\d/.test(t)) || '';
    const likes = Number((/(\d[\d.]*)\s+(outras\s+)?pessoas/.exec(likeA11y) || [])[1]?.replace(/\./g, '')) || ptNum(dig(likeVm, 'title').find((t) => /\d/.test(t)));
    const chapters = [];
    for (const c of dig(n, 'chapterRenderer')) {
      const start = (c.timeRangeStartMillis || 0) / 1000;
      if (!chapters.some((x) => x.start === start)) chapters.push({ start, title: txt(c.title) });
    }
    return {
      title: txt(primary.title),
      date: ptDate(txt(primary.dateText)),
      likes,
      viewers: Number(dig1(n, 'videoViewCountRenderer')?.originalViewCount) || ptNum(txt(dig1(n, 'videoViewCountRenderer')?.viewCount)),
      channel: txt(owner.title),
      handle: (owner.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl || '').replace(/^\//, '').replace(/^(?!@).*/, ''),
      verified: isVerified(owner.badges),
      avatar: ytw.dig1(owner.thumbnail, 'thumbnails')?.slice(-1)[0]?.url?.replace(/=s\d+-/, '=s88-') || '',
      followers: ptNum(txt(owner.subscriberCountText)),
      description: dig1(n, 'attributedDescription')?.content || '',
      chapters: chapters.sort((a, b) => a.start - b.start),
    };
  }

  function video(id, fresh = false) {
    // Os links do googlevideo valem umas 6 horas; guarda por 1 hora.
    return cached('v:' + id, 60 * MIN, async () => {
      const [basic, n] = await Promise.all([
        yt().then((y) => y.getBasicInfo(id, { client: 'ANDROID_VR' })),
        innertube('next', { videoId: id }).catch(() => null),
      ]);
      const bi = basic.basic_info || {};
      const sd = basic.streaming_data;
      const ps = basic.playability_status || {};
      if (!sd) throw new Error(ps.reason || 'Este vídeo não está disponível.');
      const m = n ? watchMeta(n) : {};
      const common = {
        id,
        title: bi.title || m.title || '',
        channel: bi.author || m.channel || '',
        channelId: bi.channel_id || '',
        handle: m.handle || '',
        verified: Boolean(m.verified),
        description: bi.short_description || m.description || '',
        views: Number(bi.view_count) || 0,
        likes: m.likes || 0,
        date: m.date || '',
        avatar: m.avatar || '',
        followers: m.followers || 0,
      };
      if (bi.is_live) {
        if (!sd.hls_manifest_url) throw new Error('Não encontrei o sinal desta live. Tente de novo em instantes.');
        const started = bi.start_timestamp ? new Date(bi.start_timestamp).getTime() / 1000 : 0;
        return {
          ...common, live: true, viewers: m.viewers || 0, startedAt: Math.round(started) || 0, duration: 0, chapters: [],
          qualities: [{ height: 720, src: sd.hls_manifest_url, hls: true }], audio: null, audios: [], downloads: [],
        };
      }
      const f = pickFormats(sd);
      if (!f.qualities.length) throw new Error('O YouTube não entregou os arquivos deste vídeo. Tente de novo em instantes.');
      return {
        ...common,
        duration: Math.round(Number(bi.duration) || 0),
        chapters: m.chapters || [],
        qualities: f.qualities,
        audio: f.audio,
        audios: f.audios,
        downloads: [1440, 1080, 720, 480, 360].filter((h) => h <= f.maxHeight),
      };
    }, fresh);
  }

  // ----- extras que o YouTube não tem (o celular chama direto) -----
  const SB_CATS = ['sponsor', 'selfpromo', 'interaction', 'intro', 'outro', 'music_offtopic'];
  const segments = (id) => cached('sb:' + id, 60 * MIN, async () => {
    const r = await fetch(`https://sponsor.ajay.app/api/skipSegments?videoID=${id}&categories=${encodeURIComponent(JSON.stringify(SB_CATS))}`);
    if (r.status === 404) return [];
    if (!r.ok) throw new Error('SponsorBlock indisponível');
    return (await r.json()).map((s) => ({ start: s.segment[0], end: s.segment[1], category: s.category }));
  });
  const votes = (id) => cached('rd:' + id, 60 * MIN, async () => {
    const r = await fetch(`https://returnyoutubedislikeapi.com/votes?videoId=${id}`);
    if (!r.ok) throw new Error('Contagem indisponível');
    const j = await r.json();
    return { likes: j.likes || 0, dislikes: j.dislikes || 0, rating: j.rating || 0 };
  });
  const profile = () => cached('me:' + (jar().SAPISID || '').slice(0, 12), 30 * MIN, async () => (loggedIn() ? ytw.profile(innertube) : null));

  // ----- rotas (mesmo formato do server.js) -----
  const ok = (body, status = 200) => ({ status, body });
  const fail = (status, error, code = '') => ({ status, body: { error, code } });
  const ids = (u, re, max) => [...new Set((u.searchParams.get('ids') || '').split(',').filter((x) => re.test(x)))].slice(0, max);

  async function route(method, u, b) {
    const p = u.pathname;
    const q = (k) => u.searchParams.get(k) || '';
    const page = (max) => Math.min(max, Math.max(0, Number(q('page')) || 0));

    if (p === '/api/search') {
      const text = q('q').trim().slice(0, 200);
      if (!text) return fail(400, 'Digite algo para buscar.');
      return ok(await search(text, q('ch') !== '0', page(30), q('live') === '1'));
    }
    if (p === '/api/video') {
      if (!VIDEO_ID.test(q('id'))) return fail(400, 'Vídeo inválido.');
      return ok(await video(q('id'), u.searchParams.has('fresh')));
    }
    if (p === '/api/channel') {
      if (!CHANNEL_ID.test(q('id'))) return fail(400, 'Canal inválido.');
      return ok(await channelPage(q('id'), page(50)));
    }
    if (p === '/api/feed') {
      if (!FEEDS[q('k')]) return fail(400, 'Feed inválido.');
      if (!loggedIn()) return fail(401, 'Conecte sua conta do YouTube para ver isto.');
      return ok(await feed(q('k'), page(30), u.searchParams.has('fresh')));
    }
    if (p === '/api/ytplaylist') {
      const raw = q('list').trim();
      const m = /[?&]list=([\w-]{10,64})/.exec(raw) || /^([\w-]{10,64})$/.exec(raw);
      if (!m) return fail(400, 'Cole o link de uma playlist do YouTube (com “list=” no endereço).');
      return ok(await ytPlaylist(m[1]));
    }
    if (p === '/api/live-now') return ok(await liveNow(ids(u, CHANNEL_ID, 12)));
    if (p === '/api/avatars') return ok({});
    if (p === '/api/prefetch') return { status: 204, body: null };
    if (p === '/api/segments') { try { return ok(await segments(q('id'))); } catch { return ok([]); } }
    if (p === '/api/votes') { try { return ok(await votes(q('id'))); } catch { return ok(null); } }

    // Comentários e chat ao vivo (mesmo código do servidor do PC).
    if (p === '/api/comments') {
      if (!VIDEO_ID.test(q('id'))) return fail(400, 'Vídeo inválido.');
      return ok(await ytw.comments(innertube, q('id'), q('c').slice(0, 4000), loggedIn()));
    }
    const cAct = /^\/api\/comments\/(like|reply|create)$/.exec(p);
    if (cAct && method === 'POST') {
      if (!loggedIn()) return fail(401, 'Conecte sua conta do YouTube (pelo arquivo de login) para isso.');
      const text = String(b.text || '').trim().slice(0, 10000);
      const param = String(b.params || b.action || '').slice(0, 4000);
      if (!param) return fail(400, 'O YouTube não liberou essa ação para a sua conta.');
      if (cAct[1] !== 'like' && !text) return fail(400, 'Escreva alguma coisa.');
      return ok(await ytw.commentAction(innertube, cAct[1], param, text, true));
    }
    if (p === '/api/chat') {
      if (!VIDEO_ID.test(q('id'))) return fail(400, 'Vídeo inválido.');
      return ok(await ytw.liveChat(innertube, q('id'), q('c').slice(0, 4000), loggedIn()));
    }
    if (p === '/api/chat/send' && method === 'POST') {
      if (!loggedIn()) return fail(401, 'Conecte sua conta do YouTube para mandar mensagens.');
      const text = String(b.text || '').trim().slice(0, 200);
      if (!text || !b.params) return fail(400, 'Escreva uma mensagem.');
      return ok(await ytw.sendChat(innertube, String(b.params).slice(0, 4000), text, uuid()));
    }

    // Conta: no celular só pelo arquivo cookies.txt (fica guardado só neste aparelho).
    if (p === '/api/account') {
      if (method === 'DELETE') { storage.del('mt_cookies'); clearFeeds(); return ok({ connected: false }); }
      return ok({ connected: loggedIn(), mode: loggedIn() ? 'file' : '', browser: '', profile: '', browsers: [], loginBrowser: '' });
    }
    if (p === '/api/account/cookies' && method === 'POST') {
      const lines = String(b.text || '').split(/\r?\n/).filter((l) => YT_LINE.test(l));
      if (!lines.length || !hasLogin(parseCookies(lines.join('\n')))) {
        return fail(400, 'Esse arquivo não tem o login do YouTube. Exporte com a página do youtube.com aberta e já entrando na sua conta.');
      }
      const before = storage.get('mt_cookies');
      storage.set('mt_cookies', '# Netscape HTTP Cookie File\n' + lines.join('\n') + '\n');
      clearFeeds();
      // Testa: o menu da conta só responde com nome para quem está logado.
      const me = await profile().catch(() => null);
      if (!me?.name) {
        if (before) storage.set('mt_cookies', before); else storage.del('mt_cookies');
        clearFeeds();
        return fail(400, 'O YouTube não aceitou esse login. Exporte um arquivo novo com a página do YouTube aberta.');
      }
      return ok({ connected: true, mode: 'file' });
    }
    if (p === '/api/account/me') { try { return ok((await profile()) || {}); } catch { return ok({}); } }
    if (p.startsWith('/api/account/google')) return ok({ status: 'error', error: 'No celular, conecte pelo “Arquivo de login” (cookies.txt).' });
    if (p.startsWith('/api/download')) return fail(501, 'Downloads no app chegam em breve.');
    return fail(404, 'Rota desconhecida.');
  }

  // Ponto de entrada: (método, endereço, corpo já lido como objeto) -> { status, body }.
  async function handle(method, url, body = {}) {
    const u = new URL(url, 'http://app.local');
    try {
      return await route(method.toUpperCase(), u, body || {});
    } catch (e) {
      return fail(e.code === 'bot' ? 429 : 500, e.message || 'Algo deu errado.', e.code || '');
    }
  }
  return { handle, video, search, channelPage, feed, loggedIn };
}
