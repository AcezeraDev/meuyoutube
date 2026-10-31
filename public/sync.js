// Estatísticas iguais no PC e no celular. Cada aparelho guarda as suas num arquivo próprio ("stats-<aparelho>.json")
// de um gist secreto da sua conta do GitHub, e a tela de estatísticas soma todos. Como cada aparelho só escreve o
// próprio arquivo, um nunca apaga o que o outro guardou. O código de acesso (token) fica só neste aparelho.
const GH = 'https://api.github.com';
const DESC = 'MeuTube — estatísticas (sincronização entre aparelhos)';
const get = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const set = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const del = (k) => { try { localStorage.removeItem(k); } catch {} };
// Página para criar o código já com a única permissão necessária (gists).
export const TOKEN_URL = 'https://github.com/settings/tokens/new?scopes=gist&description=MeuTube%20-%20estat%C3%ADsticas';

function deviceId() {
  let id = get('deviceId', '');
  if (!id) {
    id = (crypto.randomUUID?.() || Math.random().toString(36).slice(2) + Date.now().toString(36)).replace(/-/g, '').slice(0, 16);
    set('deviceId', id);
  }
  return id;
}
export const deviceName = () => get('deviceName', window.meutubeApp ? 'Celular' : 'PC');
export const setDeviceName = (n) => set('deviceName', String(n || '').trim().slice(0, 30) || deviceName());
export const syncState = () => ({ on: Boolean(get('syncToken', '') && get('syncGist', '')), last: get('syncLast', 0), devices: get('syncDevices', []), error: get('syncError', '') });
// Estatísticas dos outros aparelhos (a última versão que veio do GitHub).
export const otherStats = () => Object.values(get('syncOthers', {}));

async function gh(path, opts = {}, token = get('syncToken', '')) {
  const r = await fetch(GH + path, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
  });
  if (r.status === 401) throw new Error('O GitHub não aceitou o código. Confira se copiou inteiro (ou crie um novo).');
  if (r.status === 404 && /gists/.test(path) && opts.method !== 'PATCH') throw new Error('O código não tem permissão de “gist”. Crie outro marcando “gist”.');
  if (!r.ok) throw new Error(`O GitHub não respondeu agora (${r.status}). Tente de novo em instantes.`);
  return r.status === 204 ? null : r.json();
}

// Conecta: confere o código, acha o gist do MeuTube (ou cria um, secreto) e já sincroniza.
export async function connect(token) {
  token = String(token || '').trim();
  if (!/^(gh[pousr]_|github_pat_)\w{20,}$/.test(token)) throw new Error('Isso não parece um código do GitHub (começa com “ghp_”).');
  const gists = await gh('/gists?per_page=100', {}, token);
  let gist = gists.find((g) => g.description === DESC)?.id;
  if (!gist) {
    const g = await gh('/gists', { method: 'POST', body: JSON.stringify({ description: DESC, public: false, files: { 'LEIA-ME.md': { content: 'Estatísticas do MeuTube, uma por aparelho. Criado e atualizado pelo próprio MeuTube.\n' } } }) }, token);
    gist = g.id;
  }
  set('syncToken', token);
  set('syncGist', gist);
  await syncNow();
}

export function disconnect() {
  for (const k of ['syncToken', 'syncGist', 'syncOthers', 'syncDevices', 'syncLast', 'syncError']) del(k);
}

// Lê os arquivos dos outros aparelhos e grava o deste. Devolve true se algo dos outros mudou.
let running = null;
export function syncNow() {
  if (!syncState().on) return Promise.resolve(false);
  return (running ||= (async () => {
    try {
      const me = deviceId();
      const g = await gh('/gists/' + get('syncGist', ''));
      const others = {};
      const devices = [];
      for (const [name, f] of Object.entries(g.files || {})) {
        const m = /^stats-(\w+)\.json$/.exec(name);
        if (!m || m[1] === me) continue;
        let content = f.content;
        if (f.truncated && f.raw_url) content = await (await fetch(f.raw_url)).text();
        try {
          const data = JSON.parse(content);
          others[m[1]] = data.stats || {};
          devices.push({ name: data.device || 'Outro aparelho', updated: data.updated || 0 });
        } catch {}
      }
      const changed = JSON.stringify(others) !== JSON.stringify(get('syncOthers', {}));
      set('syncOthers', others);
      set('syncDevices', devices);
      const mine = { device: deviceName(), updated: Date.now(), stats: get('stats', { days: {}, channels: {}, videos: {} }) };
      await gh('/gists/' + get('syncGist', ''), { method: 'PATCH', body: JSON.stringify({ files: { [`stats-${me}.json`]: { content: JSON.stringify(mine) } } }) });
      set('syncLast', Date.now());
      del('syncError');
      return changed;
    } catch (e) {
      set('syncError', e.message);
      throw e;
    } finally {
      running = null;
    }
  })());
}

// Depois de assistir: envia em até 1 minuto (junta vários pedaços de tempo num envio só).
let timer = 0;
export function scheduleSync() {
  if (!syncState().on) return;
  clearTimeout(timer);
  timer = setTimeout(() => syncNow().catch(() => {}), 60e3);
}
