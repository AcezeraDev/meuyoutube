// Roda no app antes da tela (app.js): os pedidos da tela para /api/... são respondidos aqui mesmo, no celular,
// falando direto com o YouTube. Nada passa por computador ou servidor.
import { createApi } from './api.js';
import { installNative } from './native.js';

const webFetch = window.fetch.bind(window);
const cap = window.Capacitor;
const native = Boolean(cap?.isNativePlatform?.());

// Pedido pela camada nativa do Android. O fetch que o Capacitor instala passa os cabeçalhos por um Request do
// navegador, que joga fora Cookie e Origin; chamando o plugin direto eles chegam ao YouTube (e sem CORS).
async function nativeFetch(input, init = {}) {
  if (!native) return webFetch(input, init); // aberto num navegador comum (só para testar a tela)
  const isReq = typeof Request !== 'undefined' && input instanceof Request;
  const url = isReq ? input.url : String(input);
  const method = String(init.method || (isReq ? input.method : 'GET')).toUpperCase();
  const headers = {};
  new Headers(init.headers || (isReq ? input.headers : undefined)).forEach((v, k) => { headers[k] = v; });
  let data = init.body ?? (isReq && !['GET', 'HEAD'].includes(method) ? await input.clone().text() : undefined);
  if (data != null && typeof data !== 'string') data = new TextDecoder().decode(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
  const r = await cap.nativePromise('CapacitorHttp', 'request', {
    url, method, headers, responseType: 'text',
    ...(data != null ? { data, dataType: 'text' } : {}),
  });
  const body = r.status === 204 || r.status === 304 ? null : typeof r.data === 'string' ? r.data : JSON.stringify(r.data ?? '');
  const res = new Response(body, { status: r.status, headers: r.headers || {} });
  Object.defineProperty(res, 'url', { value: r.url || url });
  return res;
}

const sha1 = async (text) => [...new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text)))]
  .map((b) => b.toString(16).padStart(2, '0')).join('');

const storage = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  del: (k) => { try { localStorage.removeItem(k); } catch {} },
};

// No celular a conta entra pelo arquivo cookies.txt (a janela "Entrar com Google" só existe no PC).
if (storage.get('accMethod2') == null) storage.set('accMethod2', JSON.stringify('file'));

const api = createApi({ fetch: nativeFetch, sha1, storage });
window.meutubeApi = api;
window.meutubeApp = true;
if (native) installNative();

window.fetch = async (input, init = {}) => {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url || '';
  let u;
  try { u = new URL(raw, location.href); } catch { return webFetch(input, init); }
  if (u.origin !== location.origin || !u.pathname.startsWith('/api/')) return webFetch(input, init);
  let body = {};
  try { body = init.body ? JSON.parse(init.body) : {}; } catch {}
  const r = await api.handle(init.method || 'GET', u.pathname + u.search, body);
  return new Response(r.body == null ? null : JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
};
