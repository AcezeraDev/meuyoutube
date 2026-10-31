// Ponte entre a tela e o Android:
// - o player já informa o que está tocando pela Media Session do navegador; aqui isso vira a notificação com
//   controles (e o serviço que mantém o som tocando com o app fechado ou a tela apagada);
// - o pop-up (picture-in-picture) do Android é apresentado à tela como o pop-up de vídeo do navegador, que o
//   player já sabe usar (requestPictureInPicture, eventos enter/leavepictureinpicture).
import { registerPlugin } from '@capacitor/core';

const Media = registerPlugin('MeuTubeMedia');

export function installNative() {
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

  // ---------- pop-up ----------
  let pipEl = null;
  Object.defineProperty(Document.prototype, 'pictureInPictureEnabled', { configurable: true, get: () => true });
  Object.defineProperty(Document.prototype, 'pictureInPictureElement', { configurable: true, get: () => pipEl });
  Document.prototype.exitPictureInPicture = () => Media.exitPip().catch(() => {});
  HTMLVideoElement.prototype.requestPictureInPicture = function () {
    media.add(this);
    return Media.enterPip({ width: this.videoWidth || 16, height: this.videoHeight || 9 }).then(() => ({ width: innerWidth, height: innerHeight }));
  };
  Media.addListener('pip', ({ active }) => {
    document.body.classList.toggle('native-pip', active);
    if (active && !pipEl) {
      pipEl = activeVideo() || document.querySelector('.player video');
      pipEl?.dispatchEvent(new Event('enterpictureinpicture'));
    } else if (!active && pipEl) {
      const el = pipEl;
      pipEl = null;
      el.dispatchEvent(new Event('leavepictureinpicture'));
    }
  });
}
