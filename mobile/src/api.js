// O "servidor" do app de celular: responde as mesmas rotas /api/... do server.js, mas falando direto com o
// YouTube a partir do aparelho. Não depende de navegador nem de Node: quem usa passa fetch, sha1 e um lugar
// para guardar dados (no celular, o fetch nativo do Capacitor e o localStorage; nos testes, o Node).
//
// Divisão do trabalho:
// - links de vídeo: youtubei.js com o cliente VISIONOS (links diretos do googlevideo, sem decifrar nada; lives pelo ANDROID_VR);
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

// Leitura das respostas do YouTube (números e datas em português, listas de vídeos e canais): fica no
// lib/yt-web.js, junto com o servidor do PC.
const { ptNum, ptDate, ptAgo, clock, walk, allText, bestThumb, lastUrl, isVerified, videosFrom, channelsFrom, nextToken } = ytw;
export { ptNum, ptDate, videosFrom, channelsFrom, nextToken };

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
      published: ptAgo(txt(primary.dateText)),
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
      // VISIONOS: links diretos que valem para o vídeo inteiro. O ANDROID_VR (sem o "PO token") só libera o primeiro
      // minuto de cada arquivo, então fica para as lives (HLS) e como reserva.
      const links = async () => {
        const y = await yt();
        const vision = await y.getBasicInfo(id, { client: 'VISIONOS' }).catch(() => null);
        if (vision?.streaming_data?.adaptive_formats?.some((f) => f.url) && !vision.basic_info?.is_live) return vision;
        return y.getBasicInfo(id, { client: 'ANDROID_VR' });
      };
      const [basic, n] = await Promise.all([links(), innertube('next', { videoId: id }).catch(() => null)]);
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
        published: m.published || 0,
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
    if (p === '/api/shorts') {
      const pg = page(40);
      return ok(await cached(`sh:${pg}:${loggedIn() ? 1 : 0}`, 10 * MIN, () => ytw.shortsFeed(innertube, loggedIn(), pg)));
    }
    if (p === '/api/vstate') {
      if (!VIDEO_ID.test(q('id'))) return fail(400, 'Vídeo inválido.');
      if (!loggedIn()) return ok({ like: 'INDIFFERENT', subscribed: false, loggedIn: false });
      return ok({ ...(await ytw.videoState(innertube, q('id'))), loggedIn: true });
    }
    if ((p === '/api/rate' || p === '/api/subscribe') && method === 'POST') {
      if (!loggedIn()) return fail(401, 'Conecte sua conta do YouTube para isso.');
      if (p === '/api/rate') {
        if (!VIDEO_ID.test(b.id || '')) return fail(400, 'Vídeo inválido.');
        return ok(await ytw.rate(innertube, b.id, String(b.status || '')));
      }
      if (!CHANNEL_ID.test(b.channelId || '')) return fail(400, 'Canal inválido.');
      const r = await ytw.subscribe(innertube, b.channelId, Boolean(b.on));
      clearFeeds(); // inscrições e canais mudaram
      return ok(r);
    }
    if (p === '/api/live-now') return ok(await liveNow(ids(u, CHANNEL_ID, 12)));
    if (p === '/api/avatars') return ok({});
    // Pré-carga: começa a buscar o vídeo quando você toca no card (quando o vídeo abre, ele já está pronto).
    if (p === '/api/prefetch') {
      if (VIDEO_ID.test(q('id'))) video(q('id')).catch(() => {});
      return { status: 204, body: null };
    }
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
  // Aquece a conexão com o YouTube (o primeiro vídeo abre mais rápido).
  const warm = () => yt().catch(() => {});
  return { handle, video, search, channelPage, feed, loggedIn, warm };
}
