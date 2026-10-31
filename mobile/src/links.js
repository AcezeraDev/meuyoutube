// Link do YouTube (ou texto compartilhado com um link dentro) -> tela do MeuTube.
// Vídeos, Shorts e lives viram #/watch/ID; canais, #/channel/UC... ou uma busca pelo @; buscas, #/search/...
export function youtubeHash(text) {
  const found = String(text || '').match(/vnd\.youtube:[\w-]{11}|https?:\/\/[^\s<>"]+/);
  if (!found) return null;
  let u;
  try { u = new URL(found[0].replace(/^vnd\.youtube:/, 'https://youtu.be/')); } catch { return null; }
  const host = u.hostname.replace(/^(www|m|music)\./, '');
  if (host !== 'youtube.com' && host !== 'youtu.be') return null;

  const id = host === 'youtu.be'
    ? u.pathname.slice(1, 12)
    : u.searchParams.get('v') || (u.pathname.match(/^\/(shorts|live|embed|v)\/([\w-]{11})/) || [])[2];
  if (id && /^[\w-]{11}$/.test(id)) return `#/watch/${id}`;

  const channel = u.pathname.match(/^\/channel\/(UC[\w-]{22})/);
  if (channel) return `#/channel/${channel[1]}`;
  const handle = u.pathname.match(/^\/(@[^/?#]+)/);
  if (handle) return `#/search/${encodeURIComponent(decodeURIComponent(handle[1]))}`;
  const q = u.searchParams.get('search_query');
  if (q) return `#/search/${encodeURIComponent(q)}`;
  return '#/';
}
