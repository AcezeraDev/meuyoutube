// Extras de bases abertas, iguais no servidor do PC e no app de celular: títulos e miniaturas sem clickbait
// (DeArrow), capítulos marcados pela comunidade (SponsorBlock) e a leitura das legendas do YouTube.
// Só o código do vídeo sai daqui. Sem dependências: quem usa passa o fetch.
const SB = 'https://sponsor.ajay.app';
const DEARROW_THUMB = 'https://dearrow-thumb.ajay.app/api/v1/getThumbnail';

// DeArrow: o título e o quadro da miniatura mais votados pela comunidade. Vale o primeiro da lista (a base já
// ordena: travados primeiro, depois por votos) se não for o original e não tiver voto negativo.
// No título, ">" antes de uma palavra só avisa a extensão para não mexer nas maiúsculas: sai.
async function branding(fetch, id) {
  const r = await fetch(`${SB}/api/branding?videoID=${id}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('DeArrow indisponível');
  const j = await r.json();
  const good = (x) => x && !x.original && (x.locked || x.votes >= 0);
  const t = (j.titles || [])[0];
  const th = (j.thumbnails || [])[0];
  const out = {};
  if (good(t) && t.title) out.title = t.title.replace(/(^|\s)>(?=\S)/g, '$1').trim();
  if (good(th) && th.timestamp != null) out.thumb = `${DEARROW_THUMB}?videoID=${id}&time=${th.timestamp}`;
  return out.title || out.thumb ? out : null;
}

// Capítulos que a comunidade marcou no SponsorBlock (para vídeos sem capítulos do próprio canal).
async function communityChapters(fetch, id) {
  const r = await fetch(`${SB}/api/skipSegments?videoID=${id}&categories=${encodeURIComponent('["chapter"]')}&actionTypes=${encodeURIComponent('["chapter"]')}`);
  if (r.status === 404) return [];
  if (!r.ok) throw new Error('SponsorBlock indisponível');
  return (await r.json())
    .filter((s) => s.description)
    .map((s) => ({ start: s.segment[0], end: s.segment[1], title: s.description }))
    .sort((a, b) => a.start - b.start);
}

// Legendas do YouTube no formato json3 -> falas { s: início, e: fim, t: texto }, em segundos.
// Tira os caracteres invisíveis que o YouTube usa para alinhar, junta as linhas repetidas e, nas automáticas
// (em que cada fala fica na tela até a próxima acabar), corta o fim de cada uma no começo da seguinte.
function cuesFromJson3(j) {
  const cues = [];
  for (const ev of j?.events || []) {
    if (!ev.segs || ev.aAppend) continue;
    const t = ev.segs.map((s) => s.utf8 || '').join('').replace(/[​-‏⁠﻿]/g, '').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim();
    if (!t) continue;
    const s = (ev.tStartMs || 0) / 1000;
    const e = s + (ev.dDurationMs || 2000) / 1000;
    const last = cues[cues.length - 1];
    if (last && last.s === s && last.t === t) continue;
    cues.push({ s, e, t });
  }
  for (let i = 0; i < cues.length - 1; i++) if (cues[i].e > cues[i + 1].s) cues[i].e = Math.max(cues[i].s + 0.3, cues[i + 1].s);
  return cues;
}

module.exports = { branding, communityChapters, cuesFromJson3 };
