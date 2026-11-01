// Partes iguais no servidor do PC e no app de celular: pedidos à API interna do youtube.com (a mesma que o site
// do YouTube usa) e a leitura das respostas de comentários, chat ao vivo e perfil. Sem dependências: só fetch.
const YT = 'https://www.youtube.com';
const YT_CLIENT = { clientName: 'WEB', clientVersion: '2.20261020.01.00', hl: 'pt', gl: 'BR', timeZone: 'America/Sao_Paulo' };
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36';

// Lê um cookies.txt (formato Netscape) e devolve só os cookies do YouTube.
function parseCookies(text) {
  const jar = {};
  for (const l of String(text || '').split(/\r?\n/)) {
    if (!/^(#HttpOnly_)?\.?([\w-]+\.)*youtube\.com\t/i.test(l)) continue;
    const p = l.replace(/^#HttpOnly_/, '').split('\t');
    if (p.length >= 7) jar[p[5]] = p[6];
  }
  return jar;
}
const hasLogin = (jar) => Boolean(jar && (jar.SAPISID || jar['__Secure-3PAPISID']));

// Assinatura que o youtube.com manda em todo pedido logado (hash do cookie SAPISID com a hora).
async function sapisidAuth(jar, sha1) {
  const ts = Math.floor(Date.now() / 1000);
  const sig = async (k) => `${ts}_${await sha1(`${ts} ${k} ${YT}`)}`;
  const main = jar.SAPISID || jar['__Secure-3PAPISID'];
  return `SAPISIDHASH ${await sig(main)} SAPISID1PHASH ${await sig(jar['__Secure-1PAPISID'] || main)} SAPISID3PHASH ${await sig(jar['__Secure-3PAPISID'] || main)}`;
}

// fetch: o fetch do ambiente (no celular, o nativo, que não esbarra em CORS). sha1(texto) -> hex.
// getJar(): cookies atuais. onLimit(): avisado quando o YouTube responde 429.
function makeInnertube({ fetch, sha1, getJar, onLimit }) {
  return async function innertube(endpoint, body, { auth = true } = {}) {
    const jar = auth ? getJar() : {};
    const headers = { 'Content-Type': 'application/json', 'User-Agent': UA, Origin: YT, 'X-Origin': YT, 'X-Youtube-Client-Name': '1', 'X-Youtube-Client-Version': YT_CLIENT.clientVersion };
    if (hasLogin(jar)) {
      headers.Cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
      headers.Authorization = await sapisidAuth(jar, sha1);
      headers['X-Goog-AuthUser'] = '0';
    }
    const r = await fetch(`${YT}/youtubei/v1/${endpoint}?prettyPrint=false`, {
      method: 'POST', headers, body: JSON.stringify({ context: { client: YT_CLIENT }, ...body }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.status === 429) { onLimit?.(); throw Object.assign(new Error('O YouTube está segurando os pedidos deste aparelho por alguns instantes.'), { code: 'bot' }); }
    if (!r.ok) throw new Error(r.status === 401 || r.status === 403 ? 'O YouTube recusou o login. Conecte a conta de novo.' : j.error?.message || 'O YouTube não respondeu.');
    return j;
  };
}

// Procura uma chave em qualquer profundidade (as respostas do YouTube mudam de formato com frequência).
function dig(o, key, out = []) {
  if (o && typeof o === 'object') {
    if (key in o) out.push(o[key]);
    for (const v of Object.values(o)) dig(v, key, out);
  }
  return out;
}
const dig1 = (o, key) => dig(o, key)[0];
const txt = (t) => (t ? t.simpleText ?? (t.runs || []).map((r) => r.text).join('') : '');
const https = (u) => (u && u.startsWith('//') ? 'https:' + u : u || '');
const bigAvatar = (u) => https(u || '').replace(/=s\d+-/, '=s88-');

// Comentários vêm em "viewModels" que só apontam para entidades em frameworkUpdates (texto, contagens, botões).
function parseComments(j, loggedIn) {
  const ent = {};
  for (const m of dig1(j, 'mutations') || []) if (m.entityKey && m.payload) ent[m.entityKey] = Object.values(m.payload)[0];
  const comment = (vm) => {
    const c = ent[vm.commentKey];
    if (!c) return null;
    const st = ent[vm.toolbarStateKey] || {};
    const sf = ent[vm.toolbarSurfaceKey] || {};
    const p = c.properties || {}, a = c.author || {}, tb = c.toolbar || {};
    return {
      id: p.commentId || vm.commentId,
      text: p.content?.content || '',
      time: p.publishedTime || '',
      author: a.displayName || '',
      avatar: bigAvatar(a.avatarThumbnailUrl),
      channelId: a.channelId || '',
      verified: Boolean(a.isVerified),
      creator: Boolean(a.isCreator),
      me: Boolean(a.isCurrentUser),
      pinned: vm.pinnedText || '',
      hearted: st.heartState === 'TOOLBAR_HEART_STATE_HEARTED',
      liked: st.likeState === 'TOOLBAR_LIKE_STATE_LIKED',
      likes: tb.likeCountNotliked || '',
      likesLiked: tb.likeCountLiked || '',
      replyCount: tb.replyCount || '',
      likeAction: dig1(sf.likeCommand, 'performCommentActionEndpoint')?.action || '',
      unlikeAction: dig1(sf.unlikeCommand, 'performCommentActionEndpoint')?.action || '',
      replyParams: dig1(sf.replyCommand, 'createReplyParams') || dig1(sf, 'createReplyParams') || '',
    };
  };
  const items = [];
  let next = '', header = null;
  for (const it of dig(j, 'continuationItems').flat()) {
    if (!it || typeof it !== 'object') continue;
    if (it.commentsHeaderRenderer) {
      const h = it.commentsHeaderRenderer;
      header = {
        count: txt(h.countText) || txt(h.commentsCount),
        createParams: dig1(h.createRenderer?.commentSimpleboxRenderer?.submitButton?.buttonRenderer?.serviceEndpoint?.createCommentEndpoint, 'createCommentParams') || '',
        sorts: (dig1(h, 'subMenuItems') || []).map((s) => ({ label: s.title, token: dig1(s, 'continuationCommand')?.token || '', on: Boolean(s.selected) })).filter((s) => s.token),
      };
    } else if (it.commentThreadRenderer) {
      const t = it.commentThreadRenderer;
      const c = comment(t.commentViewModel?.commentViewModel || {});
      if (c) items.push({ ...c, repliesToken: dig1(t.replies, 'continuationCommand')?.token || '' });
    } else if (it.commentViewModel) {
      const c = comment(it.commentViewModel);
      if (c) items.push(c);
    } else if (it.continuationItemRenderer) {
      next = dig1(it.continuationItemRenderer, 'continuationCommand')?.token || next;
    }
  }
  // Sem canal na conta o YouTube troca curtir/responder por "criar canal".
  const needsChannel = loggedIn && Boolean(dig1(j, 'channelCreationFormEndpoint') || dig1(j, 'channelCreationServiceEndpoint')) && !items.some((c) => c.likeAction);
  return { header, items, next, loggedIn, needsChannel };
}
// O comentário recém-criado volta na resposta; mostra na hora sem recarregar a lista.
const createdComment = (j, loggedIn) => parseComments({ ...j, continuationItems: dig(j, 'commentViewModel').filter((x) => x?.commentKey).map((vm) => ({ commentViewModel: vm })) }, loggedIn).items[0] || null;

async function comments(innertube, id, token, loggedIn) {
  if (!token) {
    const n = await innertube('next', { videoId: id });
    const sec = dig(n, 'itemSectionRenderer').find((s) => s.sectionIdentifier === 'comment-item-section');
    token = dig1(sec, 'continuationCommand')?.token;
    if (!token) return { disabled: true, items: [], next: '', loggedIn };
  }
  return parseComments(await innertube('next', { continuation: token }), loggedIn);
}

// Chat ao vivo: o primeiro pedido traz as últimas mensagens; os seguintes, só as novas (com o tempo de espera sugerido).
function parseChat(j, loggedIn) {
  const lcc = j.continuationContents?.liveChatContinuation || {};
  const runs = (m) => (m?.runs || []).map((r) => (r.emoji
    ? (r.emoji.isCustomEmoji ? { img: https(r.emoji.image?.thumbnails?.[0]?.url), alt: r.emoji.shortcuts?.[0] || '' } : { t: r.emoji.emojiId || '' })
    : { t: r.text || '' }));
  const messages = [];
  for (const a of lcc.actions || []) {
    const it = a.addChatItemAction?.item || {};
    const r = it.liveChatTextMessageRenderer || it.liveChatPaidMessageRenderer || it.liveChatMembershipItemRenderer;
    if (!r) continue;
    const badges = (r.authorBadges || []).map((b) => b.liveChatAuthorBadgeRenderer).filter(Boolean);
    messages.push({
      id: r.id,
      author: txt(r.authorName),
      avatar: https(r.authorPhoto?.thumbnails?.slice(-1)[0]?.url),
      runs: runs(r.message || r.headerSubtext),
      paid: txt(r.purchaseAmountText),
      owner: badges.some((b) => b.icon?.iconType === 'OWNER'),
      mod: badges.some((b) => b.icon?.iconType === 'MODERATOR'),
      member: badges.some((b) => b.customThumbnail),
      verified: badges.some((b) => b.icon?.iconType === 'VERIFIED'),
    });
  }
  const c = (lcc.continuations || [])[0] || {};
  const data = c.invalidationContinuationData || c.timedContinuationData || c.reloadContinuationData || {};
  const panel = lcc.actionPanel;
  const sendParams = dig1(panel, 'sendLiveChatMessageEndpoint')?.params || '';
  // O painel de escrever só vem na primeira leitura; nas atualizações seguintes ele simplesmente não vem.
  const blocked = panel && !sendParams ? txt(panel.messageRenderer?.text) || txt(dig1(panel, 'buttonRenderer')?.text) : '';
  return { messages, next: data.continuation || '', wait: Math.min(Math.max(Number(data.timeoutMs) || 5000, 2000), 15000), sendParams, blocked, loggedIn };
}
async function liveChat(innertube, id, token, loggedIn) {
  let viewers = 0;
  if (!token) {
    const n = await innertube('next', { videoId: id });
    token = dig1(dig1(n, 'liveChatRenderer'), 'continuation');
    viewers = Number(dig1(n, 'videoViewCountRenderer')?.originalViewCount) || 0;
    if (!token) return { disabled: true, messages: [], next: '' };
  }
  return { ...parseChat(await innertube('live_chat/get_live_chat', { continuation: token }), loggedIn), viewers };
}

// Ações com a conta: curtir/responder/comentar e mandar mensagem no chat. "kind": like | reply | create.
async function commentAction(innertube, kind, param, text, loggedIn) {
  if (kind === 'like') {
    const j = await innertube('comment/perform_comment_action', { actions: [param] });
    if (j.actionResults?.some((r) => r.status === 'STATUS_FAILED')) throw new Error('O YouTube não aceitou a curtida.');
    return { ok: true };
  }
  const j = kind === 'reply'
    ? await innertube('comment/create_comment_reply', { createReplyParams: param, commentText: text })
    : await innertube('comment/create_comment', { createCommentParams: param, commentText: text });
  return { ok: true, comment: createdComment(j, loggedIn) };
}
async function sendChat(innertube, params, text, uuid) {
  const j = await innertube('live_chat/send_message', { params, richMessage: { textSegments: [{ text }] }, clientMessageId: uuid });
  if (j.errorMessage || dig1(j, 'liveChatModeChangeMessageRenderer')) throw new Error(txt(dig1(j, 'text')) || 'O YouTube não aceitou a mensagem.');
  return { ok: true };
}

// Como a sua conta está neste vídeo: curtida (LIKE | DISLIKE | INDIFFERENT) e se você é inscrita no canal.
async function videoState(innertube, id) {
  const n = await innertube('next', { videoId: id });
  return {
    like: dig1(n, 'likeStatus') || 'INDIFFERENT',
    subscribed: Boolean(dig1(n, 'subscribed')),
    channelId: dig1(n, 'subscribeEndpoint')?.channelIds?.[0] || dig1(n, 'unsubscribeEndpoint')?.channelIds?.[0] || '',
  };
}
// Curtir, não gostar ou tirar a curtida, na sua conta do YouTube.
async function rate(innertube, id, status) {
  const endpoint = { LIKE: 'like/like', DISLIKE: 'like/dislike', INDIFFERENT: 'like/removelike' }[status];
  if (!endpoint) throw new Error('Ação inválida.');
  await innertube(endpoint, { target: { videoId: id } });
  return { ok: true, like: status };
}
// Inscrever-se ou cancelar a inscrição num canal, na sua conta do YouTube.
async function subscribe(innertube, channelId, on) {
  await innertube(on ? 'subscription/subscribe' : 'subscription/unsubscribe', { channelIds: [channelId] });
  return { ok: true, subscribed: Boolean(on) };
}

// Shorts: os da sua página inicial (com conta) e a busca do YouTube com o filtro "Shorts", variando o tema por página.
const SHORTS_TOPICS = ['shorts', 'shorts brasil', 'humor', 'games', 'música', 'futebol', 'receitas', 'curiosidades', 'animais', 'memes', 'viagem', 'ciência'];
function shortsFrom(j) {
  const out = [];
  const seen = new Set();
  const add = (s) => { if (s.id && /^[\w-]{11}$/.test(s.id) && !seen.has(s.id)) { seen.add(s.id); out.push(s); } };
  for (const s of dig(j, 'shortsLockupViewModel')) {
    const md = s.overlayMetadata || {};
    add({
      id: dig1(s.onTap, 'reelWatchEndpoint')?.videoId,
      title: md.primaryText?.content || String(s.accessibilityText || '').split(/, [\d.,]+ (mil |mi )?visualiza/)[0],
      viewsText: md.secondaryText?.content || '',
      thumb: https(dig1(s.thumbnail || {}, 'sources')?.[0]?.url),
    });
  }
  for (const r of dig(j, 'reelItemRenderer')) add({ id: r.videoId, title: txt(r.headline), viewsText: txt(r.viewCountText), thumb: https(r.thumbnail?.thumbnails?.[0]?.url) });
  // Sem miniatura na resposta: a capa em pé que o YouTube gera para todo Short.
  return out.map((x) => ({ ...x, thumb: x.thumb || `https://i.ytimg.com/vi/${x.id}/oardefault.jpg` }));
}
async function shortsFeed(innertube, loggedIn, page) {
  const jobs = [innertube('search', { query: SHORTS_TOPICS[page % SHORTS_TOPICS.length], params: 'EgIQCQ==' })];
  if (loggedIn && page === 0) jobs.unshift(innertube('browse', { browseId: 'FEwhat_to_watch' }));
  const results = await Promise.allSettled(jobs);
  const items = results.flatMap((r) => (r.status === 'fulfilled' ? shortsFrom(r.value) : []));
  const failed = results.find((r) => r.status === 'rejected');
  if (!items.length && failed) throw failed.reason;
  const ids = new Set();
  return { items: items.filter((s) => !ids.has(s.id) && ids.add(s.id)), more: page < 40 };
}

// Seu perfil (nome, @ e foto), lido do menu da conta do youtube.com.
async function profile(innertube) {
  const h = dig1(await innertube('account/account_menu', {}), 'activeAccountHeaderRenderer');
  if (!h) return null;
  return { name: txt(h.accountName), handle: txt(h.channelHandle), photo: https(h.accountPhoto?.thumbnails?.slice(-1)[0]?.url || '').replace(/=s\d+-/, '=s88-') };
}

const VIDEO_ID = /^[\w-]{11}$/;
const CHANNEL_ID = /^UC[\w-]{22}$/;
// ---------- leitura de números e datas em português ----------
// "4,03 mi de inscritos" -> 4030000; "1.234 visualizações" -> 1234; "12 mil" -> 12000.
function ptNum(s) {
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
function ptDate(s) {
  s = String(s || '').toLowerCase();
  const abs = /(\d{1,2}) de ([a-zç]{3})[a-zç]*\.? de (\d{4})/.exec(s);
  if (abs && MONTHS.includes(abs[2])) return ymd(new Date(+abs[3], MONTHS.indexOf(abs[2]), +abs[1]));
  const rel = /há (\d+) (segundo|minuto|hora|dia|semana|m[eê]s|meses|ano)/.exec(s);
  if (!rel) return '';
  const days = { segundo: 0, minuto: 0, hora: 0, dia: 1, semana: 7, mes: 30, mês: 30, meses: 30, ano: 365 }[rel[2]] * Number(rel[1]);
  return ymd(new Date(Date.now() - days * 864e5));
}

// "há 20 minutos" -> momento aproximado (ms) em que saiu; serve para mostrar "há 20 minutos" / "há 3 horas".
function ptAgo(s) {
  const rel = /há (\d+) (segundo|minuto|hora|dia|semana|m[eê]s|meses|ano)/.exec(String(s || '').toLowerCase());
  if (!rel) return 0;
  const ms = { segundo: 1e3, minuto: 6e4, hora: 36e5, dia: 864e5, semana: 6048e5, mes: 2592e6, mês: 2592e6, meses: 2592e6, ano: 31536e6 }[rel[2]];
  return Date.now() - Number(rel[1]) * ms;
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
// Selo "Só para membros": estilo MEMBERS_ONLY (lista antiga) ou o texto do selo (lockup novo).
const MEMBERS_RE = /MEMBERS_ONLY|(somente|s[oó]|exclusivo)( para)? membros|members[ -]only/i;
const isMembers = (...o) => MEMBERS_RE.test(JSON.stringify(o));

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
    members: isMembers(r.badges || []),
    date: ptDate(txt(r.publishedTimeText)),
    published: ptAgo(txt(r.publishedTimeText)),
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
    members: isMembers(md.metadata || {}, l.contentImage || {}),
    date: ptDate(parts.find((p) => /há \d/i.test(p))),
    published: ptAgo(parts.find((p) => /há \d/i.test(p))),
    description: '',
    thumb: bestThumb(dig1(l.contentImage, 'sources')),
  };
}

function videosFrom(json, channel = {}) {
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

function channelsFrom(json) {
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
function nextToken(json) {
  let best = { n: 0, token: '' };
  walk(json, (o) => {
    if (!Array.isArray(o) || o.length < 2) return false;
    const token = dig1(o[o.length - 1]?.continuationItemRenderer, 'continuationCommand')?.token;
    if (token && o.length > best.n) best = { n: o.length, token };
    return false;
  });
  return best.token;
}

module.exports = { YT, UA, parseCookies, hasLogin, makeInnertube, dig, dig1, txt, parseComments, parseChat, comments, liveChat, commentAction, sendChat, profile, videoState, rate, subscribe, shortsFrom, shortsFeed,
  ptNum, ptDate, ptAgo, clock, walk, allText, bestThumb, lastUrl, isVerified, videosFrom, channelsFrom, nextToken };
