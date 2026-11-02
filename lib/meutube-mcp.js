// Ferramentas do MeuTube para o Codex (servidor MCP por stdin/stdout, sem dependências).
// O server.js liga este arquivo junto com o Codex a cada pergunta e passa MT_URL (o próprio site) e MT_TOKEN
// (a pergunta em andamento). As ferramentas de leitura usam a mesma API do site (/api/...); as de ação
// (abrir vídeo, abrir página, mexer no player, salvar) vão para o navegador, que executa na hora.
const BASE = process.env.MT_URL || 'http://127.0.0.1:3000';
const TOKEN = process.env.MT_TOKEN || '';

const clock = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`;
};
async function get(p) {
  const r = await fetch(BASE + p, { signal: AbortSignal.timeout(120000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Erro ${r.status}`);
  return j;
}
async function act(action) {
  const r = await fetch(BASE + '/api/ai/act', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: TOKEN, action }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'O site não está aberto para receber a ação.');
  return j.result || 'Feito.';
}
// Andamento de uma ferramenta demorada ("Lendo comentários… 120 de 300"), mostrado no painel. Sem esperar resposta.
const progress = (text) => fetch(BASE + '/api/ai/progress', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: TOKEN, text }) }).catch(() => {});
const vid = (v) => ({ id: v.id, titulo: v.title, canal: v.channel, canal_id: v.channelId || undefined, duracao: v.live ? 'AO VIVO' : clock(v.duration), visualizacoes: v.views || undefined, publicado: v.date || undefined, so_membros: v.members || undefined });
const ID = { type: 'string', description: 'Código do vídeo (11 caracteres, ex.: dQw4w9WgXcQ)' };

const TOOLS = [
  { name: 'buscar_videos', description: 'Pesquisa vídeos (e canais) no YouTube pelo MeuTube.', schema: { query: { type: 'string', description: 'O que pesquisar' }, ao_vivo: { type: 'boolean', description: 'Só transmissões ao vivo agora' }, pagina: { type: 'integer', description: 'Página de resultados, a partir de 0' } }, required: ['query'],
    run: async (a) => { const r = await get(`/api/search?q=${encodeURIComponent(a.query)}&page=${a.pagina || 0}${a.ao_vivo ? '&live=1' : ''}`); return { canais: (r.channels || []).map((c) => ({ id: c.id, nome: c.name, inscritos: c.followers })), videos: (r.videos || []).map(vid), tem_mais: r.more }; } },
  { name: 'ver_video', description: 'Dados de um vídeo: título, canal, descrição, duração, números, capítulos e legendas disponíveis.', schema: { id: ID }, required: ['id'],
    run: async (a) => { const v = await get(`/api/video?id=${a.id}`); return { id: v.id, titulo: v.title, canal: v.channel, canal_id: v.channelId, ao_vivo: Boolean(v.live), duracao: clock(v.duration), visualizacoes: v.views, curtidas: v.likes, data: v.date, descricao: (v.description || '').slice(0, 4000), capitulos: (v.chapters || []).map((c) => `[${clock(c.start)}] ${c.title}`), legendas: (v.subtitles || []).map((s) => s.label) }; } },
  { name: 'ver_transcricao', description: 'Transcrição completa de um vídeo, com os tempos (para saber o que é falado e onde).', schema: { id: ID }, required: ['id'],
    run: async (a) => {
      const v = await get(`/api/video?id=${a.id}`);
      const subs = v.subtitles || [];
      const orig = subs.find((s) => s.auto && s.key.endsWith('-orig'));
      const key = (orig && subs.find((s) => !s.auto && s.lang === orig.lang))?.key || orig?.key || subs.find((s) => /^pt/.test(s.lang))?.key || subs[0]?.key;
      if (!key) return 'Este vídeo não tem legendas.';
      const cues = await get(`/api/subs?id=${a.id}&k=${encodeURIComponent(key)}`);
      const out = [];
      let b = null;
      for (const c of cues) { if (!b || c.s - b.s > 20) out.push((b = { s: c.s, t: [] })); b.t.push(c.t.replace(/\n/g, ' ')); }
      return out.map((x) => `[${clock(x.s)}] ${x.t.join(' ')}`).join('\n').slice(0, 120000);
    } },
  { name: 'ver_comentarios', description: 'Lê comentários de um vídeo, quantos forem precisos (ex.: 100, 300, 1000), dos principais ou dos mais recentes, e opcionalmente as respostas. Vem um por linha: [curtidas] autor: texto.',
    schema: { id: ID, quantidade: { type: 'integer', description: 'Quantos comentários ler (padrão 100, máximo 1000)' }, ordem: { type: 'string', enum: ['principais', 'recentes'] }, respostas: { type: 'boolean', description: 'Ler também as respostas (até 10 por comentário, nos 40 primeiros com resposta)' } }, required: ['id'],
    run: async (a) => {
      const want = Math.min(1000, Math.max(1, Math.round(a.quantidade || 100)));
      const page = (token) => get(`/api/comments?id=${a.id}${token ? `&c=${encodeURIComponent(token)}` : ''}`);
      let r = await page('');
      if (r.disabled) return 'Os comentários estão desativados neste vídeo.';
      const total = r.header?.count || '';
      if (a.ordem === 'recentes') {
        const s = r.header?.sorts?.find((x) => /recent|newest|novos/i.test(x.label));
        if (s) r = await page(s.token);
      }
      const line = (c, pre = '') => `${pre}[${c.likes || 0}] ${c.author}${c.creator ? ' (dono do canal)' : ''}${c.pinned ? ' (fixado)' : ''}${c.time ? ` · ${c.time}` : ''}: ${c.text.replace(/\s+/g, ' ').slice(0, 700)}`;
      const out = [];
      let n = 0, threads = 0, pages = 0;
      for (;;) {
        for (const c of r.items || []) {
          if (n >= want) break;
          out.push(line(c));
          n++;
          if (a.respostas && c.repliesToken && threads < 40) {
            threads++;
            try { for (const x of (await page(c.repliesToken)).items?.slice(0, 10) || []) out.push(line(x, '    ↳ ')); } catch {}
          }
        }
        progress(`Lendo comentários… ${n} de ${want}`);
        if (n >= want || !r.next || ++pages >= 80) break;
        try { r = await page(r.next); } catch (e) { out.push(`(parei em ${n}: ${e.message})`); break; }
      }
      return `${n} comentários lidos${total ? ` (o vídeo tem ${total})` : ''}, ${a.ordem === 'recentes' ? 'dos mais recentes' : 'dos principais'}:\n${out.join('\n')}`;
    } },
  { name: 'ver_chat_ao_vivo', description: 'Mensagens recentes do chat de uma live.', schema: { id: ID }, required: ['id'],
    run: async (a) => (await get(`/api/chat?id=${a.id}`)).messages?.slice(-120).map((m) => `${m.author}${m.paid ? ` [${m.paid}]` : ''}: ${(m.runs || []).map((r) => r.t ?? r.alt ?? '').join('')}`).join('\n') || 'Sem chat ao vivo.' },
  { name: 'ver_canal', description: 'Dados de um canal e seus vídeos mais recentes.', schema: { id: { type: 'string', description: 'Código do canal (começa com UC)' }, pagina: { type: 'integer' } }, required: ['id'],
    run: async (a) => { const c = await get(`/api/channel?id=${a.id}${a.pagina ? `&page=${a.pagina}` : ''}`); return { nome: c.name, handle: c.handle, inscritos: c.followers, descricao: c.description, videos: (c.videos || []).map(vid), tem_mais: c.more }; } },
  { name: 'ver_feed', description: 'Listas da conta do YouTube conectada: recomendados, inscrições, assistir mais tarde, histórico, curtidos ou canais inscritos.', schema: { tipo: { type: 'string', enum: ['rec', 'subs', 'later', 'history', 'liked', 'channels'] } }, required: ['tipo'],
    run: async (a) => { const r = await get(`/api/feed?k=${a.tipo}`); return Array.isArray(r) ? r.map((c) => ({ id: c.id, nome: c.name })) : (r.items || []).map(vid); } },
  { name: 'abrir_video', description: 'Abre um vídeo no MeuTube para a pessoa assistir (opcionalmente a partir de um tempo).', schema: { id: ID, inicio_segundos: { type: 'number', description: 'Começar neste segundo' } }, required: ['id'],
    run: (a) => act({ kind: 'open_video', id: a.id, start: a.inicio_segundos || 0 }) },
  { name: 'abrir_pagina', description: 'Navega no MeuTube: início, uma busca, um canal, inscrições, shorts, histórico, assistir mais tarde, curtidos, playlists, uma playlist, estatísticas ou ajustes.', schema: { pagina: { type: 'string', enum: ['inicio', 'busca', 'canal', 'inscricoes', 'shorts', 'historico', 'assistir_mais_tarde', 'curtidos', 'playlists', 'playlist', 'estatisticas', 'ajustes', 'meus_videos'] }, busca: { type: 'string', description: 'Termo (para pagina=busca)' }, canal_id: { type: 'string', description: 'Para pagina=canal' }, playlist: { type: 'string', description: 'Nome da playlist (para pagina=playlist)' } }, required: ['pagina'],
    run: (a) => act({ kind: 'open_page', page: a.pagina, query: a.busca, channelId: a.canal_id, playlist: a.playlist }) },
  { name: 'controlar_player', description: 'Mexe no vídeo que está tocando: tocar, pausar, pular para um tempo, velocidade, legendas, tela cheia, próximo vídeo.', schema: { acao: { type: 'string', enum: ['tocar', 'pausar', 'pular_para', 'avancar', 'voltar', 'velocidade', 'legendas_ligar', 'legendas_desligar', 'tela_cheia', 'proximo'] }, valor: { type: 'number', description: 'Segundos (pular_para/avancar/voltar) ou velocidade (ex.: 1.5)' } }, required: ['acao'],
    run: (a) => act({ kind: 'player', action: a.acao, value: a.valor }) },
  { name: 'salvar_video', description: 'Salva um vídeo em "Assistir mais tarde" ou numa playlist do MeuTube (cria a playlist se não existir).', schema: { id: ID, onde: { type: 'string', description: '"assistir_mais_tarde" ou o nome da playlist' } }, required: ['id', 'onde'],
    run: (a) => act({ kind: 'save', id: a.id, where: a.onde }) },
  { name: 'ver_meu_meutube', description: 'O que a pessoa guardou no MeuTube deste navegador: playlists (com os vídeos), assistir mais tarde, histórico recente e canais inscritos.', schema: {}, required: [],
    run: () => act({ kind: 'library' }) },
];

// ---------- protocolo MCP (JSON-RPC, uma mensagem por linha) ----------
const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
async function handle(m) {
  if (m.method === 'initialize') {
    return send({ id: m.id, result: { protocolVersion: m.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'meutube', version: '1.0.0' } } });
  }
  if (m.method === 'tools/list') {
    return send({ id: m.id, result: { tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: { type: 'object', properties: t.schema, required: t.required } })) } });
  }
  if (m.method === 'tools/call') {
    const tool = TOOLS.find((t) => t.name === m.params?.name);
    if (!tool) return send({ id: m.id, error: { code: -32602, message: 'Ferramenta desconhecida' } });
    try {
      const r = await tool.run(m.params.arguments || {});
      return send({ id: m.id, result: { content: [{ type: 'text', text: typeof r === 'string' ? r : JSON.stringify(r) }] } });
    } catch (e) {
      return send({ id: m.id, result: { content: [{ type: 'text', text: `Erro: ${e.message}` }], isError: true } });
    }
  }
  if (m.method === 'ping') return send({ id: m.id, result: {} });
  if (m.id != null) send({ id: m.id, error: { code: -32601, message: 'Método não suportado' } });
}
let buf = '';
process.stdin.setEncoding('utf8').on('data', (d) => {
  buf += d;
  const lines = buf.split('\n');
  buf = lines.pop();
  for (const l of lines) { if (l.trim()) { try { handle(JSON.parse(l)); } catch {} } }
});
