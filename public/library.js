// Biblioteca local do MeuTube: playlists, momentos marcados, estatísticas, filtros e ajustes.
// Tudo fica só neste navegador (localStorage).
import { otherStats } from './sync.js';

const get = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const set = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const uid = () => Math.random().toString(36).slice(2, 10);
const slim = (v) => ({ id: v.id, title: v.title, channel: v.channel, channelId: v.channelId, avatar: v.avatar, verified: v.verified, duration: v.duration, views: v.views, thumb: v.thumb, members: v.members || undefined });

// ---------- playlists ----------
export const playlists = () => get('playlists', []);
const savePl = (list) => set('playlists', list);
export const getPlaylist = (id) => playlists().find((p) => p.id === id);
export function createPlaylist(name, items = []) {
  const p = { id: uid(), name: name.trim().slice(0, 80) || 'Nova playlist', items: items.map(slim), created: Date.now(), updated: Date.now() };
  savePl([p, ...playlists()]);
  return p;
}
function updatePl(id, fn) {
  const list = playlists();
  const p = list.find((x) => x.id === id);
  if (!p) return null;
  fn(p);
  p.updated = Date.now();
  savePl(list);
  return p;
}
export const inPlaylist = (id, vid) => !!getPlaylist(id)?.items.some((v) => v.id === vid);
export const addToPlaylist = (id, v) => updatePl(id, (p) => { if (!p.items.some((x) => x.id === v.id)) p.items.push(slim(v)); });
export const removeFromPlaylist = (id, vid) => updatePl(id, (p) => { p.items = p.items.filter((x) => x.id !== vid); });
export const renamePlaylist = (id, name) => updatePl(id, (p) => { p.name = name.trim().slice(0, 80) || p.name; });
export const deletePlaylist = (id) => savePl(playlists().filter((p) => p.id !== id));
export const movePlaylistItem = (id, from, to) => updatePl(id, (p) => { const [it] = p.items.splice(from, 1); p.items.splice(to, 0, it); });

// ---------- momentos marcados (marcadores com nota dentro do vídeo) ----------
export const marks = (vid) => get('marks', {})[vid] || [];
function saveMarks(vid, list) {
  const all = get('marks', {});
  if (list.length) all[vid] = list; else delete all[vid];
  set('marks', all);
}
export function addMark(vid, t, note = '') {
  const list = [...marks(vid), { t: Math.round(t), note }].sort((a, b) => a.t - b.t);
  saveMarks(vid, list);
  return list;
}
export const updateMark = (vid, i, note) => { const l = marks(vid); if (l[i]) { l[i].note = note.slice(0, 200); saveMarks(vid, l); } };
export const removeMark = (vid, i) => { const l = marks(vid); l.splice(i, 1); saveMarks(vid, l); return l; };

// ---------- ajustes ----------
const DEFAULTS = { sponsor: true, sponsorCats: ['sponsor', 'selfpromo', 'interaction'], dislikes: true, prefetch: true };
export const settings = () => ({ ...DEFAULTS, ...get('settings', {}) });
export const setSetting = (k, v) => set('settings', { ...get('settings', {}), [k]: v });

// ---------- filtros: canais e palavras bloqueados ----------
export const blocked = () => ({ channels: [], words: [], ...get('blocked', {}) });
export function isBlocked(v) {
  const b = blocked();
  if (v.channelId && b.channels.some((c) => c.id === v.channelId)) return true;
  const title = (v.title || '').toLowerCase();
  return b.words.some((w) => w && title.includes(w.toLowerCase()));
}
export const blockChannel = (id, name) => { const b = blocked(); if (!b.channels.some((c) => c.id === id)) b.channels.push({ id, name }); set('blocked', b); };
export const unblockChannel = (id) => { const b = blocked(); b.channels = b.channels.filter((c) => c.id !== id); set('blocked', b); };
export const addWord = (w) => { const b = blocked(); w = w.trim().slice(0, 60); if (w && !b.words.includes(w)) b.words.push(w); set('blocked', b); };
export const removeWord = (w) => { const b = blocked(); b.words = b.words.filter((x) => x !== w); set('blocked', b); };

// ---------- velocidade lembrada por canal ----------
export const channelSpeed = (cid) => (cid && get('speeds', {})[cid]) || 1;
export const setChannelSpeed = (cid, rate) => {
  if (!cid) return;
  const all = get('speeds', {});
  if (rate === 1) delete all[cid]; else all[cid] = rate;
  set('speeds', all);
};

// ---------- estatísticas de tempo assistido ----------
const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export function addWatch(seconds, v) {
  if (!(seconds > 0)) return;
  const s = get('stats', { days: {}, channels: {}, videos: {} });
  const k = dayKey();
  s.days[k] = (s.days[k] || 0) + seconds;
  if (v.channelId) {
    const c = s.channels[v.channelId] || { name: v.channel, avatar: v.avatar || '', secs: 0 };
    c.secs += seconds;
    c.name = v.channel || c.name;
    if (v.avatar) c.avatar = v.avatar;
    s.channels[v.channelId] = c;
  }
  s.videos[v.id] = 1;
  set('stats', s);
}
// Soma as estatísticas deste aparelho com as dos outros (PC e celular, sincronizadas pelo GitHub).
function allStats() {
  const s = { days: {}, channels: {}, videos: {} };
  for (const one of [get('stats', {}), ...otherStats()]) {
    for (const [d, secs] of Object.entries(one.days || {})) s.days[d] = (s.days[d] || 0) + secs;
    for (const [id, c] of Object.entries(one.channels || {})) {
      const cur = s.channels[id] || { name: c.name, avatar: c.avatar || '', secs: 0 };
      cur.secs += c.secs || 0;
      if (!cur.avatar && c.avatar) cur.avatar = c.avatar;
      s.channels[id] = cur;
    }
    Object.assign(s.videos, one.videos || {});
  }
  return s;
}
export function statsSummary() {
  const s = allStats();
  const last7 = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    last7.push({ date: d, secs: s.days[dayKey(d)] || 0 });
  }
  const total = Object.values(s.days).reduce((a, b) => a + b, 0);
  const top = Object.entries(s.channels).map(([id, c]) => ({ id, ...c })).sort((a, b) => b.secs - a.secs).slice(0, 6);
  return { last7, today: last7[6].secs, week: last7.reduce((a, d) => a + d.secs, 0), total, top, videos: Object.keys(s.videos).length };
}
export const resetStats = () => set('stats', { days: {}, channels: {}, videos: {} });
