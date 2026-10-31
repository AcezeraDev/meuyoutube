// Testa a "API" do app no Node, sem celular: node test-api.mjs [cookies.txt]
import fs from 'fs';
import crypto from 'crypto';
import { createApi } from './src/api.js';

const mem = new Map();
const cookieFile = process.argv[2];
if (cookieFile) mem.set('mt_cookies', fs.readFileSync(cookieFile, 'utf8'));
const api = createApi({
  fetch: (url, init) => fetch(url, init),
  sha1: async (t) => crypto.createHash('sha1').update(t).digest('hex'),
  storage: { get: (k) => mem.get(k), set: (k, v) => mem.set(k, v), del: (k) => mem.delete(k) },
});

const show = async (label, method, url, body) => {
  const t = Date.now();
  const r = await api.handle(method, url, body);
  const b = r.body || {};
  const summary = Array.isArray(b) ? `${b.length} itens` : b.error ? `ERRO: ${b.error}` : Object.keys(b).join(',');
  console.log(`\n[${r.status}] ${label} (${Date.now() - t} ms) ${summary}`);
  return b;
};

const s = await show('busca', 'GET', '/api/search?q=casimiro');
console.log(s.channels, s.videos?.slice(0, 2), 'more:', s.more);
const s2 = await show('busca pág. 2', 'GET', '/api/search?ch=0&page=1&q=casimiro');
console.log(s2.videos?.length, s2.videos?.[0]?.title);
const l = await show('busca ao vivo', 'GET', '/api/search?ch=0&live=1&q=noticias');
console.log(l.videos?.slice(0, 2));
const v = await show('vídeo', 'GET', '/api/video?id=dQw4w9WgXcQ');
console.log({ ...v, description: v.description?.slice(0, 60), qualities: v.qualities?.map((q) => q.height + ' ' + q.type), audios: v.audios?.map((a) => a.label), audio: v.audio?.slice(0, 60) });
if (v.audio) { const r = await fetch(v.audio, { headers: { range: 'bytes=0-1000' } }); console.log('áudio responde', r.status); }
const c = await show('canal', 'GET', '/api/channel?id=UC4aiJNDUviw_vMhdCq5Kq1Q');
console.log({ ...c, videos: c.videos?.length, first: c.videos?.[0] });
const c2 = await show('canal pág. 2', 'GET', '/api/channel?id=UC4aiJNDUviw_vMhdCq5Kq1Q&page=1');
console.log(c2.videos?.length, c2.more);
if (l.videos?.[0]) {
  const lv = await show('live', 'GET', '/api/video?id=' + l.videos[0].id);
  console.log(lv.live, lv.qualities?.[0]?.src?.slice(0, 80), lv.viewers);
  const ch = await show('chat', 'GET', '/api/chat?id=' + l.videos[0].id);
  console.log(ch.messages?.length, ch.disabled);
  const ln = await show('live-now', 'GET', '/api/live-now?ids=' + l.videos[0].channelId);
  console.log(ln.length);
}
const cm = await show('comentários', 'GET', '/api/comments?id=dQw4w9WgXcQ');
console.log(cm.items?.length, cm.header?.count);
const pl = await show('playlist', 'GET', '/api/ytplaylist?list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI');
console.log(pl.title, pl.items?.length);
await show('segments', 'GET', '/api/segments?id=dQw4w9WgXcQ');
console.log(await show('votes', 'GET', '/api/votes?id=dQw4w9WgXcQ'));
console.log(await show('conta', 'GET', '/api/account'));
if (cookieFile) {
  console.log(await show('perfil', 'GET', '/api/account/me'));
  const f = await show('feed inscrições', 'GET', '/api/feed?k=subs');
  console.log(f.items?.length, f.items?.[0]);
  const fr = await show('feed recomendados', 'GET', '/api/feed?k=rec');
  console.log(fr.items?.length);
  const fc = await show('canais da conta', 'GET', '/api/feed?k=channels');
  console.log(fc.length, fc[0]);
  const fl = await show('assistir mais tarde', 'GET', '/api/feed?k=later');
  console.log(fl.items?.length);
}
