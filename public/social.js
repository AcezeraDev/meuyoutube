// Comentários (ler, curtir, responder, comentar) e chat das lives, pela conta do YouTube conectada.
// Os botões só aparecem quando o YouTube libera a ação para a conta (os "tokens" vêm junto com a lista).
import { icon } from './icons.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hue = (s) => [...(s || '?')].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
const face = (name, url, cls = '') => url
  ? `<img class="avatar ${cls}" src="${esc(url)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
  : `<span class="avatar ${cls}" style="--h:${hue(name)}" aria-hidden="true">${esc((name || '?').replace('@', '').charAt(0).toUpperCase() || '?')}</span>`;
// Links, tempos do vídeo (viram botões que pulam para o trecho) e @menções.
const rich = (text) => esc(text)
  .replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`)
  .replace(/(^|[\s(])((?:\d{1,2}:)?\d{1,2}:\d{2})(?=[\s).,!?]|$)/gm, (all, pre, ts) => `${pre}<button class="ts" data-seek="${ts.split(':').reduce((a, n) => a * 60 + Number(n), 0)}">${ts}</button>`)
  .replace(/(^|\s)(@[\w.\-À-ÿ]+)/g, '$1<span class="cm-at">$2</span>');

async function get(path) {
  const r = await fetch(path);
  const j = await r.json().catch(() => ({ error: 'O servidor respondeu algo inesperado.' }));
  if (!r.ok) throw Object.assign(new Error(j.error || 'Algo deu errado.'), { code: j.code || '' });
  return j;
}
async function post(path, data) {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const j = await r.json().catch(() => ({ error: 'O servidor respondeu algo inesperado.' }));
  if (!r.ok) throw new Error(j.error || 'Algo deu errado.');
  return j;
}

// ---------- comentários ----------
export function mountComments(root, videoId, { alive, toast }) {
  const byId = new Map();
  let state = { loggedIn: false, needsChannel: false };
  let next = '';
  let loadingMore = false;

  root.innerHTML = `<section class="comments" aria-label="Comentários">
    <div class="cm-head"><h3 class="cm-count">Comentários</h3><div class="chips small cm-sorts"></div></div>
    <div class="cm-compose-top"></div>
    <div class="cm-list">${'<div class="cm sk"><span class="avatar"></span><div class="cm-body"><i></i><i></i></div></div>'.repeat(4)}</div>
    <div class="cm-sentinel"></div>
  </section>`;
  const list = root.querySelector('.cm-list');
  const sentinel = root.querySelector('.cm-sentinel');

  const likeLabel = (c) => (c.liked ? c.likesLiked : c.likes) || '';
  const canAct = () => state.loggedIn && !state.needsChannel;
  const item = (c, reply = false) => {
    byId.set(c.id, c);
    return `<article class="cm ${reply ? 'is-reply' : ''}" data-cm="${esc(c.id)}">
      ${c.channelId ? `<a class="av-link" href="#/channel/${esc(c.channelId)}" tabindex="-1" aria-hidden="true">${face(c.author, c.avatar, reply ? 'sm' : '')}</a>` : face(c.author, c.avatar, reply ? 'sm' : '')}
      <div class="cm-body">
        ${c.pinned ? `<span class="cm-pin">${icon('bookmark', 13)}${esc(c.pinned)}</span>` : ''}
        <div class="cm-meta">
          ${c.channelId ? `<a class="cm-author ${c.creator ? 'creator' : ''}" href="#/channel/${esc(c.channelId)}">${esc(c.author)}</a>` : `<span class="cm-author">${esc(c.author)}</span>`}
          ${c.verified ? `<span class="vf" title="Verificado">${icon('verified', 13)}</span>` : ''}
          <span class="cm-time">${esc(c.time)}</span>
        </div>
        <div class="cm-text">${rich(c.text)}</div>
        <div class="cm-tools">
          <button class="cm-btn cm-like ${c.liked ? 'on' : ''}" data-cm-like aria-pressed="${c.liked}" aria-label="Gostei"${c.likeAction ? '' : ' disabled'}>${icon('like', 16)}<span>${esc(likeLabel(c))}</span></button>
          ${c.hearted ? `<span class="cm-heart" title="O criador do vídeo amou">${icon('heart', 14)}</span>` : ''}
          ${c.replyParams ? `<button class="cm-btn" data-cm-reply>${icon('reply', 16)}Responder</button>` : ''}
        </div>
        <div class="cm-reply-box"></div>
        ${c.repliesToken ? `<button class="cm-replies-btn" data-cm-replies="${esc(c.id)}">${icon('chevron', 16)}${esc(c.replyCount)} ${c.replyCount === '1' ? 'resposta' : 'respostas'}</button>` : ''}
        <div class="cm-replies"></div>
      </div>
    </article>`;
  };
  const composer = (placeholder, submitLabel, value = '') => `<form class="cm-form">
    <textarea rows="1" maxlength="10000" placeholder="${esc(placeholder)}" aria-label="${esc(placeholder)}">${esc(value)}</textarea>
    <div class="cm-form-tools"><button type="button" class="pill rpl" data-cm-cancel>Cancelar</button><button class="pill accent rpl" data-cm-send disabled>${submitLabel}</button></div>
  </form>`;
  const notice = () => (!state.loggedIn
    ? `<a class="cm-note" href="#/account">${icon('key', 16)}Conecte sua conta do YouTube para curtir e responder.</a>`
    : state.needsChannel
      ? `<a class="cm-note" href="https://www.youtube.com/create_channel" target="_blank" rel="noopener noreferrer">${icon('alert', 16)}Para curtir e responder, o YouTube pede um canal na sua conta. Toque para criar (é grátis).</a>`
      : '');

  async function load(token = '', { replace = false } = {}) {
    const data = await get(`/api/comments?id=${videoId}${token ? `&c=${encodeURIComponent(token)}` : ''}`);
    if (!alive()) return;
    if (data.disabled) {
      root.querySelector('.comments').innerHTML = `<p class="cm-off">${icon('chat', 18)}Os comentários estão desativados neste vídeo.</p>`;
      return;
    }
    state = { ...state, loggedIn: data.loggedIn, needsChannel: data.needsChannel };
    if (data.header) {
      root.querySelector('.cm-count').textContent = data.header.count || 'Comentários';
      root.querySelector('.cm-sorts').innerHTML = data.header.sorts.map((s) => `<button class="chip rpl ${s.on ? 'on' : ''}" data-cm-sort="${esc(s.token)}">${esc(s.label)}</button>`).join('');
      const top = root.querySelector('.cm-compose-top');
      top.innerHTML = data.header.createParams && canAct() ? composer('Adicione um comentário...', 'Comentar') : notice();
      top.dataset.params = data.header.createParams || '';
      top.querySelector('[data-cm-cancel]')?.setAttribute('hidden', '');
    }
    const html = data.items.map((c) => item(c)).join('');
    if (replace) list.innerHTML = html;
    else { list.querySelectorAll('.sk').forEach((s) => s.remove()); list.insertAdjacentHTML('beforeend', html); }
    if (!list.children.length) list.innerHTML = `<p class="cm-off">Ninguém comentou ainda.</p>`;
    next = data.next;
    sentinel.innerHTML = next ? '<span class="btn-spin"></span>' : '';
  }

  // Carrega quando a seção chega perto da tela (não gasta pedidos se você só assiste).
  const obs = new IntersectionObserver(async ([e]) => {
    if (!e.isIntersecting || loadingMore) return;
    if (!alive()) return obs.disconnect();
    loadingMore = true;
    try {
      if (!list.dataset.loaded) { list.dataset.loaded = '1'; await load(); } else if (next) await load(next);
      else obs.disconnect();
    } catch (err) {
      sentinel.innerHTML = `<p class="cm-off">${esc(err.message)} <button class="pill rpl" data-cm-retry>Tentar de novo</button></p>`;
      if (!list.dataset.loaded || list.querySelector('.sk')) list.innerHTML = '';
      delete list.dataset.loaded;
    } finally {
      loadingMore = false;
    }
    if (alive() && next && sentinel.isConnected) { obs.unobserve(sentinel); obs.observe(sentinel); }
  }, { rootMargin: '0px 0px 600px 0px' });
  obs.observe(sentinel);

  const grow = (ta) => { ta.style.height = 'auto'; ta.style.height = `${Math.min(ta.scrollHeight, 240)}px`; };
  root.addEventListener('input', (e) => {
    const ta = e.target.closest('.cm-form textarea');
    if (!ta) return;
    grow(ta);
    ta.form.querySelector('[data-cm-send]').disabled = !ta.value.trim();
  });
  root.addEventListener('focusin', (e) => {
    const f = e.target.closest('.cm-compose-top .cm-form');
    f?.querySelector('[data-cm-cancel]')?.removeAttribute('hidden');
  });
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.target.closest('.cm-form textarea')) { e.preventDefault(); e.target.form.requestSubmit(); }
  });

  root.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const ta = form.querySelector('textarea');
    const text = ta.value.trim();
    if (!text) return;
    const btn = form.querySelector('[data-cm-send]');
    const replyTo = form.closest('[data-cm]');
    btn.disabled = true;
    btn.innerHTML = '<span class="btn-spin"></span>';
    try {
      if (replyTo) {
        const parent = byId.get(replyTo.dataset.cm);
        const r = await post('/api/comments/reply', { params: parent.replyParams, text });
        // Resposta de uma resposta fica na mesma conversa (como no YouTube).
        const thread = replyTo.classList.contains('is-reply') ? replyTo.parentElement : replyTo.querySelector('.cm-replies');
        thread.hidden = false;
        const mine = r.comment || { id: `local-${Date.now()}`, text, author: 'Você', time: 'agora', likes: '', me: true };
        thread.insertAdjacentHTML(replyTo.classList.contains('is-reply') ? 'beforeend' : 'afterbegin', item(mine, true));
        form.remove();
        toast('Resposta publicada');
      } else {
        const params = root.querySelector('.cm-compose-top').dataset.params;
        const r = await post('/api/comments/create', { params, text });
        const mine = r.comment || { id: `local-${Date.now()}`, text, author: 'Você', time: 'agora', likes: '', me: true };
        list.insertAdjacentHTML('afterbegin', item(mine));
        ta.value = '';
        grow(ta);
        form.querySelector('[data-cm-cancel]').setAttribute('hidden', '');
        toast('Comentário publicado');
      }
    } catch (err) {
      toast(err.message);
    } finally {
      if (btn.isConnected) { btn.innerHTML = replyTo ? 'Responder' : 'Comentar'; btn.disabled = !ta.value.trim(); }
    }
  });

  root.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-cm-like], [data-cm-reply], [data-cm-cancel], [data-cm-replies], [data-cm-sort], [data-cm-retry]');
    if (!el) return;
    if (el.matches('[data-cm-retry]')) { sentinel.innerHTML = '<span class="btn-spin"></span>'; obs.unobserve(sentinel); obs.observe(sentinel); return; }
    if (el.matches('[data-cm-sort]')) {
      if (el.classList.contains('on')) return;
      root.querySelectorAll('[data-cm-sort]').forEach((b) => b.classList.toggle('on', b === el));
      list.style.opacity = '0.5';
      try { await load(el.dataset.cmSort, { replace: true }); } catch (err) { toast(err.message); } finally { list.style.opacity = ''; }
      return;
    }
    if (el.matches('[data-cm-cancel]')) {
      const form = el.closest('.cm-form');
      if (form.closest('.cm-compose-top')) { form.querySelector('textarea').value = ''; grow(form.querySelector('textarea')); el.setAttribute('hidden', ''); form.querySelector('[data-cm-send]').disabled = true; }
      else form.remove();
      return;
    }
    const art = el.closest('[data-cm]');
    const c = byId.get(art?.dataset.cm);
    if (el.matches('[data-cm-replies]')) {
      const box = art.querySelector('.cm-replies');
      if (el.classList.toggle('open')) {
        if (!box.dataset.loaded) {
          box.innerHTML = '<span class="btn-spin"></span>';
          await loadReplies(box, c.repliesToken).catch((err) => { box.innerHTML = ''; el.classList.remove('open'); toast(err.message); });
        }
        box.hidden = false;
      } else box.hidden = true;
      return;
    }
    if (!c) return;
    if (!canAct()) return toast(state.loggedIn ? 'Para isso o YouTube pede um canal na sua conta.' : 'Conecte sua conta do YouTube para curtir e responder.');
    if (el.matches('[data-cm-reply]')) {
      const box = art.querySelector(':scope > .cm-body > .cm-reply-box');
      if (box.querySelector('.cm-form')) return box.querySelector('textarea').focus();
      box.innerHTML = composer('Adicione uma resposta...', 'Responder', art.classList.contains('is-reply') && !c.me ? `${c.author} ` : '');
      const ta = box.querySelector('textarea');
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
      box.querySelector('[data-cm-send]').disabled = !ta.value.trim();
      return;
    }
    if (el.matches('[data-cm-like]')) {
      const action = c.liked ? c.unlikeAction : c.likeAction;
      if (!action) return;
      // Na hora (otimista); volta atrás se o YouTube recusar.
      const flip = () => { c.liked = !c.liked; el.classList.toggle('on', c.liked); el.setAttribute('aria-pressed', String(c.liked)); el.querySelector('span').textContent = likeLabel(c); };
      flip();
      el.classList.add('pop');
      setTimeout(() => el.classList.remove('pop'), 500);
      try { await post('/api/comments/like', { action }); } catch (err) { flip(); toast(err.message); }
    }
  });

  // Respostas vêm em páginas; o botão "Mostrar mais" no fim busca a próxima.
  const repliesHtml = (data) => data.items.map((c) => item(c, true)).join('')
    + (data.next ? `<button class="cm-replies-btn more" data-next-replies="${esc(data.next)}">${icon('chevron', 16)}Mostrar mais respostas</button>` : '');
  async function loadReplies(box, token) {
    const data = await get(`/api/comments?id=${videoId}&c=${encodeURIComponent(token)}`);
    if (!alive()) return;
    box.dataset.loaded = '1';
    box.innerHTML = repliesHtml(data);
  }
  root.addEventListener('click', async (e) => {
    const more = e.target.closest('[data-next-replies]');
    if (!more) return;
    more.innerHTML = '<span class="btn-spin"></span>';
    try {
      const data = await get(`/api/comments?id=${videoId}&c=${encodeURIComponent(more.dataset.nextReplies)}`);
      more.insertAdjacentHTML('afterend', repliesHtml(data));
      more.remove();
    } catch (err) { more.innerHTML = `${icon('chevron', 16)}Mostrar mais respostas`; toast(err.message); }
  });

  return { destroy: () => obs.disconnect() };
}

// ---------- chat ao vivo ----------
export function mountChat(root, videoId, { alive, toast, onViewers }) {
  let next = '';
  let sendParams = '';
  let timer = 0;
  let stick = true; // acompanhando o fim da conversa
  const MAX = 250;
  root.innerHTML = `<section class="chat" aria-label="Chat ao vivo">
    <div class="chat-head"><span class="live-dot" aria-hidden="true"></span><b>Chat ao vivo</b><span class="meta xs chat-viewers"></span>
      <button class="icon-btn rpl chat-fold" aria-expanded="true" aria-label="Recolher o chat" title="Recolher o chat">${icon('chevron', 18)}</button></div>
    <div class="chat-list" role="log" aria-live="off"><p class="chat-empty"><span class="btn-spin"></span>Entrando no chat...</p></div>
    <button class="chat-jump" hidden>${icon('chevron', 16)}Novas mensagens</button>
    <div class="chat-foot"></div>
  </section>`;
  const listEl = root.querySelector('.chat-list');
  const jump = root.querySelector('.chat-jump');
  const foot = root.querySelector('.chat-foot');

  const runs = (rs) => rs.map((r) => (r.img ? `<img class="chat-emoji" src="${esc(r.img)}" alt="${esc(r.alt)}" title="${esc(r.alt)}" loading="lazy">` : esc(r.t))).join('');
  const msg = (m) => `<div class="chat-msg ${m.paid ? 'paid' : ''}" data-mid="${esc(m.id)}">
    ${face(m.author, m.avatar, 'xs')}
    <p><span class="chat-author ${m.owner ? 'owner' : m.mod ? 'mod' : m.member ? 'member' : ''}">${esc(m.author)}${m.verified ? ` ${icon('verified', 12)}` : ''}</span>
    ${m.paid ? `<b class="chat-paid">${esc(m.paid)}</b>` : ''}<span class="chat-text">${runs(m.runs)}</span></p>
  </div>`;
  const nearEnd = () => listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 60;
  listEl.addEventListener('scroll', () => { stick = nearEnd(); if (stick) jump.hidden = true; }, { passive: true });
  jump.addEventListener('click', () => { listEl.scrollTop = listEl.scrollHeight; stick = true; jump.hidden = true; });
  root.querySelector('.chat-fold').addEventListener('click', (e) => {
    const open = root.querySelector('.chat').classList.toggle('folded') === false;
    e.currentTarget.setAttribute('aria-expanded', String(open));
    if (open) listEl.scrollTop = listEl.scrollHeight;
  });

  const seen = new Set();
  function add(messages) {
    const fresh = messages.filter((m) => m.id && !seen.has(m.id));
    if (!fresh.length) return;
    fresh.forEach((m) => seen.add(m.id));
    listEl.querySelector('.chat-empty')?.remove();
    listEl.insertAdjacentHTML('beforeend', fresh.map(msg).join(''));
    while (listEl.children.length > MAX) listEl.firstElementChild.remove();
    if (stick) listEl.scrollTop = listEl.scrollHeight;
    else jump.hidden = false;
  }
  function renderFoot(data) {
    sendParams = data.sendParams || '';
    if (sendParams) {
      if (foot.querySelector('form')) return;
      foot.innerHTML = `<form class="chat-send"><input maxlength="200" placeholder="Diga algo..." aria-label="Mensagem para o chat" autocomplete="off">
        <button class="icon-btn rpl" aria-label="Enviar" disabled>${icon('send', 18)}</button></form>
        <p class="chat-hint">As mensagens aparecem para todo mundo na live.</p>`;
      const form = foot.querySelector('form');
      const input = form.querySelector('input');
      const btn = form.querySelector('button');
      input.addEventListener('input', () => { btn.disabled = !input.value.trim(); });
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const text = input.value.trim();
        if (!text) return;
        btn.disabled = true;
        try {
          await post('/api/chat/send', { params: sendParams, text });
          input.value = '';
          stick = true;
          clearTimeout(timer);
          timer = setTimeout(poll, 800); // a mensagem volta na próxima leitura do chat
        } catch (err) { toast(err.message); btn.disabled = false; }
      });
    } else {
      foot.innerHTML = data.loggedIn
        ? (data.blocked ? `<p class="chat-hint">${esc(data.blocked)}</p>` : '')
        : `<a class="cm-note" href="#/account">${icon('key', 16)}Conecte sua conta para escrever no chat.</a>`;
    }
  }

  let fails = 0;
  async function poll() {
    if (!alive()) return;
    let wait = 6000;
    try {
      const data = await get(`/api/chat?id=${videoId}${next ? `&c=${encodeURIComponent(next)}` : ''}`);
      if (!alive()) return;
      fails = 0;
      if (data.disabled) { listEl.innerHTML = `<p class="chat-empty">O chat está desativado nesta live.</p>`; return; }
      if (data.viewers) onViewers?.(data.viewers);
      add(data.messages);
      if (!next && !data.messages.length) listEl.innerHTML = '<p class="chat-empty">Ainda sem mensagens. Diga oi!</p>';
      if (!next || data.sendParams || data.blocked) renderFoot(data); // as atualizações não trazem o painel de escrever
      if (!data.next) { listEl.insertAdjacentHTML('beforeend', '<p class="chat-empty">O chat terminou.</p>'); return; }
      next = data.next;
      wait = data.wait;
    } catch {
      fails = Math.min(fails + 1, 5);
      wait = 4000 * fails;
    }
    if (document.hidden) wait = Math.max(wait, 15000); // aba escondida: lê bem menos vezes
    timer = setTimeout(poll, wait);
  }
  poll();
  return { destroy: () => clearTimeout(timer) };
}
