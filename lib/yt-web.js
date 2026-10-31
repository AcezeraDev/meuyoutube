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

module.exports = { YT, UA, parseCookies, hasLogin, makeInnertube, dig, dig1, txt, parseComments, parseChat, comments, liveChat, commentAction, sendChat, profile, videoState, rate, subscribe, shortsFrom, shortsFeed };
