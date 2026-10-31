// Ponte entre a tela e o Android:
// - o player já informa o que está tocando pela Media Session do navegador; aqui isso vira a notificação com
//   controles (e o serviço que mantém o som tocando com o app fechado ou a tela apagada);
// - o pop-up (picture-in-picture) do Android é apresentado à tela como o pop-up de vídeo do navegador, que o
//   player já sabe usar (requestPictureInPicture, eventos enter/leavepictureinpicture).
import { registerPlugin } from '@capacitor/core';
import { youtubeHash } from './links.js';

const Media = registerPlugin('MeuTubeMedia');

// Endereço do mini-servidor do app que entrega os vídeos ao player em pedaços (o YouTube recusa o arquivo inteiro).
let proxyP = null;
export const mediaProxyBase = () => (proxyP ||= Media.mediaProxy().then((r) => r.base).catch(() => { proxyP = null; return ''; }));

export function installNative() {
  // Links do YouTube abertos no celular (ou compartilhados com o MeuTube) abrem o vídeo/canal aqui.
  const openLink = ({ url }) => {
    const hash = youtubeHash(url);
    if (hash) location.hash = hash;
    else if (url) window.dispatchEvent(new CustomEvent('meutube-toast', { detail: 'Esse link não é de um vídeo do YouTube.' }));
  };
  Media.addListener('link', openLink);
  Media.takeLink().then(openLink).catch(() => {});

  // "Entrar com Google": a página de login abre no Android e volta com o texto do cookies.txt.
  window.meutubeNative = { googleLogin: () => Media.googleLogin().then((r) => r.cookies) };

  const ms = navigator.mediaSession;
  const handlers = {};
  const media = new Set(); // <video> e <audio> que já tocaram (o <audio> do player não fica na página)
  let meta = null;
  let state = 'none';

  // O vídeo que está na tela tocando (para o pop-up). No modo só áudio não há vídeo.
  const activeVideo = () => [...media].find((m) => m instanceof HTMLVideoElement && m.isConnected && m.src && !m.paused && m.videoWidth)
    || [...document.querySelectorAll('video')].find((v) => v.src && !v.paused && v.videoWidth);
  const anyPlaying = () => [...media].some((m) => !m.paused && !m.ended && m.src);

  let timer = 0;
  const push = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!meta) return Media.stop().catch(() => {});
      const v = activeVideo();
      Media.update({
        title: meta.title || 'MeuTube',
        artist: meta.artist || '',
        artwork: meta.artwork?.[0]?.src || '',
        playing: state === 'playing' || anyPlaying(),
        video: Boolean(v),
        width: v?.videoWidth || 16,
        height: v?.videoHeight || 9,
        canNext: Boolean(handlers.nexttrack),
      }).catch(() => {});
    }, 150);
  };

  if (ms) {
    const proto = Object.getPrototypeOf(ms);
    const desc = (k) => Object.getOwnPropertyDescriptor(proto, k);
    const metaDesc = desc('metadata'), stateDesc = desc('playbackState');
    Object.defineProperty(ms, 'metadata', {
      get: () => metaDesc?.get?.call(ms) ?? meta,
      set: (m) => { meta = m; try { metaDesc?.set?.call(ms, m); } catch {} push(); },
    });
    Object.defineProperty(ms, 'playbackState', {
      get: () => state,
      set: (s) => { state = s; try { stateDesc?.set?.call(ms, s); } catch {} push(); },
    });
    const setHandler = ms.setActionHandler.bind(ms);
    ms.setActionHandler = (action, fn) => {
      handlers[action] = fn || null;
      try { setHandler(action, fn); } catch {}
      push();
    };
  }

  // Acompanha play/pause de qualquer mídia (inclusive o <audio> solto do player).
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...a) { media.add(this); return play.apply(this, a); };
  for (const ev of ['play', 'pause', 'ended', 'loadedmetadata']) document.addEventListener(ev, push, true);
  addEventListener('pagehide', () => Media.stop().catch(() => {}));

  // Botões da notificação, da tela de bloqueio e do fone de ouvido.
  Media.addListener('action', ({ action }) => {
    const h = handlers[action === 'next' ? 'nexttrack' : action === 'back' ? 'seekbackward' : action === 'forward' ? 'seekforward' : action];
    if (h) h({ action });
    else if (action === 'pause') [...media].forEach((m) => m.pause());
  });

  // ---------- tela cheia ----------
  // O Capacitor cancela a tela cheia da página, então ela é feita aqui: o elemento ocupa a tela toda (CSS .app-fs),
  // o Android esconde as barras e gira o celular. Para o player é como a tela cheia normal do navegador.
  let fsEl = null;
  const fsChange = () => document.dispatchEvent(new Event('fullscreenchange'));
  Object.defineProperty(Document.prototype, 'fullscreenElement', { configurable: true, get: () => fsEl });
  Object.defineProperty(Document.prototype, 'fullscreenEnabled', { configurable: true, get: () => true });
  Element.prototype.requestFullscreen = function () {
    if (fsEl) fsEl.classList.remove('app-fs');
    fsEl = this;
    this.classList.add('app-fs');
    document.body.classList.add('app-fs-on');
    const v = this.querySelector('video');
    const landscape = !v || !v.videoHeight || v.videoWidth >= v.videoHeight;
    fsChange();
    return Media.setFullscreen({ on: true, landscape }).catch(() => {});
  };
  Document.prototype.exitFullscreen = function () {
    if (!fsEl) return Promise.resolve();
    fsEl.classList.remove('app-fs');
    fsEl = null;
    document.body.classList.remove('app-fs-on');
    fsChange();
    return Media.setFullscreen({ on: false }).catch(() => {});
  };
  // Botão voltar do Android na tela cheia: só sai dela.
  Media.addListener('action', ({ action }) => { if (action === 'exit-fullscreen') document.exitFullscreen(); });

  // ---------- pop-up ----------
  // O aviso "entrou/saiu do pop-up" vem do Android, mas nem sempre chega à página. Por isso o pop-up também é
  // percebido pelo tamanho da janela: a janelinha do pop-up é pequena (menos de 320 px de altura); voltou ao
  // tamanho normal, saiu. Sem isso a janelinha mostrava a página inteira miniaturizada e o botão parava de abrir.
  let pipEl = null;
  const setPip = (active) => {
    document.body.classList.toggle('native-pip', active);
    if (active && !pipEl) {
      pipEl = activeVideo() || document.querySelector('.player video');
      pipEl?.dispatchEvent(new Event('enterpictureinpicture'));
    } else if (!active && pipEl) {
      const el = pipEl;
      pipEl = null;
      el.dispatchEvent(new Event('leavepictureinpicture'));
    }
  };
  Object.defineProperty(Document.prototype, 'pictureInPictureEnabled', { configurable: true, get: () => true });
  Object.defineProperty(Document.prototype, 'pictureInPictureElement', { configurable: true, get: () => pipEl });
  Document.prototype.exitPictureInPicture = () => Media.exitPip().catch(() => {});
  HTMLVideoElement.prototype.requestPictureInPicture = function () {
    media.add(this);
    setPip(false); // se ficou algum estado velho de um pop-up anterior, começa do zero
    return Media.enterPip({ width: this.videoWidth || 16, height: this.videoHeight || 9 }).then(() => ({ width: innerWidth, height: innerHeight }));
  };
  Media.addListener('pip', ({ active }) => setPip(active));
  const bySize = () => {
    const tiny = innerHeight > 0 && innerHeight < 320 && innerWidth < 600;
    if (tiny && !pipEl) setPip(true);
    else if (!tiny && pipEl) setPip(false);
  };
  addEventListener('resize', bySize);
  document.addEventListener('visibilitychange', () => setTimeout(bySize, 300));
}
