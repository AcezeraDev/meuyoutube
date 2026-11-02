// Player próprio: o YouTube entrega vídeo e áudio separados, então tocamos os dois em sincronia.
// Extras que o YouTube não tem: modo só áudio, repetir trecho A-B, timer para dormir, capturar quadro,
// pular patrocínios (SponsorBlock), marcas dos seus momentos, velocidade até 3x lembrada por canal,
// legendas desenhadas pelo próprio player e capítulos (do canal ou marcados pela comunidade).
import { icon } from './icons.js';

const time = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`;
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const SLEEP = [0, 5, 15, 30, 45, 60, -1]; // minutos; -1 = no fim do vídeo
const DRIFT = 0.3;
// Lives chegam em HLS; Chrome/Brave/Edge não tocam HLS sozinhos, então o hls.js é carregado só ao abrir uma live.
const HLS_JS = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.20/dist/hls.mjs';
// Miniplayer: no Chrome/Brave/Edge do PC o player inteiro vai para uma janelinha flutuante (com os nossos controles,
// e continua tocando enquanto você navega pelo site). Nos outros, o pop-up simples de vídeo do navegador.
const DOC_PIP = 'documentPictureInPicture' in window;
const PIP_OK = DOC_PIP || Boolean(document.pictureInPictureEnabled);
export const SEG_NAMES = { sponsor: 'Patrocínio', selfpromo: 'Autopromoção', interaction: 'Pedido de inscrição', intro: 'Abertura', outro: 'Encerramento', music_offtopic: 'Trecho sem música' };
// Última fala (ou capítulo) que começou até o tempo t, numa lista em ordem (busca binária: legendas têm milhares).
export function lastAt(list, t, key = 's') {
  let lo = 0, hi = list.length - 1, i = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (list[mid][key] <= t) { i = mid; lo = mid + 1; } else hi = mid - 1; }
  return i;
}

export class Player {
  constructor(root, info, { start = 0, rate = 1, onEnded, onNext, onProgress, onTick, onToast, onRate, onSkipToggle, onPipBack, onPipClosed } = {}) {
    this.root = root;
    this.info = info;
    this.opts = { onEnded, onNext, onProgress, onTick, onToast, onRate, onSkipToggle, onPipBack, onPipClosed };
    // Só oferece qualidades que este navegador consegue tocar (o 2K vem em VP9/AV1). Padrão: a maior até 2K.
    const probe = document.createElement('video');
    const playable = info.qualities.filter((q) => !q.type || probe.canPlayType(q.type));
    if (playable.length) info.qualities = playable;
    // Padrão: a maior até 2K no PC; no app de celular, 1080p (abre mais rápido; dá para mudar na engrenagem).
    const pref = load('quality2k', window.meutubeApp ? 1080 : 1440);
    this.quality = info.qualities.find((q) => q.height <= pref) || info.qualities[info.qualities.length - 1];
    this.lastSave = 0;
    this.retried = false;
    this.segments = [];
    this.skipSegments = true;
    this.marks = [];
    this.loopA = null;
    this.loopB = null;
    this.loopAll = false;
    this.sleep = 0;
    this.watchAcc = 0;
    this.chapters = info.chapters || [];
    this.subs = info.subtitles || [];
    this.subKey = null;
    this.cueList = [];
    this.cueCache = new Map();
    this.live = Boolean(info.live);
    root.classList.toggle('live', this.live);

    root.insertAdjacentHTML('beforeend', `
      <video playsinline preload="auto"></video>
      <div class="p-audio-art" aria-hidden="true">
        <img src="https://i.ytimg.com/vi/${info.id}/hqdefault.jpg" alt="">
        <div class="eq"><i></i><i></i><i></i><i></i><i></i></div>
        <span>Modo só áudio · economizando dados</span>
      </div>
      <div class="p-shade"></div>
      <div class="p-cc" hidden><span></span></div>
      <button class="p-big" data-a="toggle" aria-label="Reproduzir">${icon('play', 34)}</button>
      <div class="p-spin" aria-hidden="true"></div>
      <div class="p-bezel" aria-hidden="true"></div>
      <div class="p-chip" aria-live="polite"></div>
      <div class="p-bar">
        <div class="p-progress" role="slider" tabindex="0" aria-label="Posição do vídeo" aria-valuemin="0">
          <div class="p-buf"></div><div class="p-marks"></div><div class="p-played"></div><div class="p-knob"></div><div class="p-tip">${info.storyboard ? '<div class="p-thumb"></div>' : ''}<b class="p-tip-ch"></b><span></span></div>
        </div>
        <div class="p-row">
          <button data-a="toggle" aria-label="Reproduzir">${icon('play', 22)}</button>
          ${onNext ? `<button data-a="next" aria-label="Próximo vídeo">${icon('next', 20)}</button>` : ''}
          <div class="p-vol">
            <button data-a="mute" aria-label="Silenciar">${icon('volume', 21)}</button>
            <input type="range" min="0" max="1" step="0.02" aria-label="Volume">
          </div>
          ${this.live
            ? '<button class="p-live" data-a="golive" title="Ir para o momento atual da live"><i></i>AO VIVO</button>'
            : `<span class="p-time">0:00 / ${time(info.duration)}</span>`}
          <button class="p-chapter" data-a="chapters" hidden title="Capítulos"><span></span>${icon('chevron', 16)}</button>
          <span class="grow"></span>
          <span class="p-badges"></span>
          ${this.subs.length ? `<button class="p-cc-btn" data-a="cc" aria-label="Legendas (C)" title="Legendas (C)" aria-pressed="false">${icon('cc', 22)}</button>` : ''}
          <div class="p-menu-wrap">
            <button class="p-gear" data-a="menu" aria-label="Configurações" aria-expanded="false">${icon('gear', 22)}</button>
            <div class="p-menu" role="menu" hidden></div>
          </div>
          ${PIP_OK ? `<button data-a="pip" aria-label="Miniplayer (tecla I)" title="Miniplayer (I)">${icon('pip', 20)}</button>` : ''}
          <button data-a="fs" aria-label="Tela cheia">${icon('maximize', 20)}</button>
        </div>
      </div>`);

    const $ = (s) => root.querySelector(s);
    this.v = $('video');
    this.bar = $('.p-progress');
    this.played = $('.p-played');
    this.buf = $('.p-buf');
    this.knob = $('.p-knob');
    this.tip = $('.p-tip');
    this.tipText = $('.p-tip span');
    this.tipCh = $('.p-tip-ch');
    this.ccEl = $('.p-cc');
    this.chapterEl = $('.p-chapter');
    this.thumb = $('.p-thumb');
    this.timeEl = $('.p-time');
    this.volInput = $('.p-vol input');
    this.menu = $('.p-menu');
    this.bezelEl = $('.p-bezel');
    this.chipEl = $('.p-chip');
    this.marksEl = $('.p-marks');
    this.badgesEl = $('.p-badges');

    this.a = info.audio ? new Audio() : null;
    this.audioSrc = info.audio;
    const vol = load('volume', { v: 1, m: false });
    if (this.a) {
      this.a.preload = 'auto';
      this.a.src = this.audioSrc;
      this.v.muted = true;
      // App de celular: o áudio fica dentro da página (no PC ele fica solto, porque o player inteiro pode ir para a
      // janelinha do miniplayer, e mudar de página faria o som parar).
      if (window.meutubeApp) { this.a.hidden = true; document.body.append(this.a); }
    }
    this.out.volume = vol.v;
    this.out.muted = vol.m;
    // Se o modo só áudio ficou ligado da última vez, nem carrega a imagem.
    this.audioOnly = Boolean(this.a && load('audioOnly', false));
    root.classList.toggle('audio-only', this.audioOnly);
    if (!this.audioOnly) this.setSrc(this.quality.src);
    (this.audioOnly ? this.a : this.v).addEventListener('loadedmetadata', () => {
      if (start > 0) this.seek(start);
      if (rate !== 1) this.setRate(rate, false);
    }, { once: true });

    this.bind();
    this.renderVolume();
    this.renderBadges();
    this.mediaSession();
    // Legendas ligadas da última vez: volta no mesmo idioma (ou na primeira da lista, se este vídeo não tiver).
    const cc = load('captions', {});
    if (cc.on && this.subs.length) this.setSubs((this.subs.find((s) => s.lang === cc.lang) || this.subs[0]).key, false);
    this.play();
  }

  // Põe a fonte no <video>: arquivo comum direto; live (HLS) pelo hls.js, que escolhe a qualidade sozinho.
  async setSrc(src) {
    if (!this.quality.hls) { this.v.src = src; return; }
    // Celular (app Android, iPhone): o próprio player do aparelho toca HLS, sem baixar o hls.js. No PC é sempre o
    // hls.js, mesmo com o Chrome novo tocando HLS sozinho: o player dele abre a live borrada e só mostra uma qualidade.
    if ((window.meutubeApp || !window.MediaSource) && this.v.canPlayType('application/vnd.apple.mpegurl')) { this.v.src = src; return; }
    const Hls = window.MediaSource ? (await import(HLS_JS).catch(() => ({}))).default : null;
    if (this.destroyed) return;
    if (!Hls?.isSupported()) { this.v.src = src; return; } // Safari e celulares tocam HLS sozinhos
    this.hls?.destroy();
    // Qualidade automática mais firme: começa supondo uma internet boa (o padrão do hls.js supõe 0,5 Mbps e abre a
    // live em baixa), sobe de qualidade mais rápido e guarda um pouco mais de folga, para um pedaço que atrasa não
    // derrubar a imagem na hora.
    const hls = (this.hls = new Hls({
      liveSyncDurationCount: 4, backBufferLength: 90, maxBufferLength: 30,
      abrEwmaDefaultEstimate: 8e6, abrBandWidthFactor: 0.9, abrBandWidthUpFactor: 0.8, capLevelToPlayerSize: false,
    }));
    let netFails = 0;
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      // Se você fixou uma qualidade numa live, as próximas abrem nela (a mais próxima, sem passar).
      const fixed = load('liveQuality', 0);
      if (fixed) {
        const i = hls.levels.reduce((best, l, n) => (l.height <= fixed && (best < 0 || l.height > hls.levels[best].height) ? n : best), -1);
        if (i >= 0) hls.currentLevel = i;
      }
      if (!this.userPaused) this.v.play().catch(() => {});
      this.renderBadges();
    });
    hls.on(Hls.Events.LEVEL_SWITCHED, () => this.renderBadges());
    hls.on(Hls.Events.FRAG_LOADED, () => { netFails = 0; });
    hls.on(Hls.Events.ERROR, (e, d) => {
      if (!d.fatal) return;
      if (d.type === Hls.ErrorTypes.MEDIA_ERROR) return hls.recoverMediaError();
      // Rede: tenta continuar; se insistir, pede links novos ao servidor (a lista da live pode ter vencido).
      if (++netFails <= 3) return setTimeout(() => hls.startLoad(), 1500 * netFails);
      this.recover();
    });
    hls.loadSource(src);
    hls.attachMedia(this.v);
  }
  // ---------- miniplayer (pop-up) ----------
  get inPip() { return Boolean(this.pipWin) || document.pictureInPictureElement === this.v; }
  async togglePip() {
    // No app de celular, se dá para tocar no botão é porque o pop-up está fechado: sempre abre.
    if (this.inPip && !window.meutubeApp) {
      // Dentro do pop-up, o botão traz o vídeo de volta para a página dele.
      if (this.pipWin && this.opts.onPipBack) return this.opts.onPipBack();
      return this.exitPip();
    }
    try {
      if (this.audioOnly) this.setAudioOnly(false, false);
      if (DOC_PIP) {
        try { return await this.openDocPip(); } catch {} // sem janelinha completa: cai no pop-up simples do vídeo
      }
      if (this.v.readyState < 1) await new Promise((r) => this.v.addEventListener('loadedmetadata', r, { once: true }));
      await this.v.requestPictureInPicture();
    } catch (e) {
      // No app de celular o motivo vem do Android (ex.: pop-up desligado nas configurações).
      this.chip(window.meutubeApp && e?.message ? e.message : 'Não consegui abrir o miniplayer');
    }
  }
  async openDocPip() {
    const ratio = this.v.videoWidth && this.v.videoHeight ? this.v.videoHeight / this.v.videoWidth : 9 / 16;
    const win = await window.documentPictureInPicture.requestWindow({ width: 480, height: Math.round(480 * ratio) });
    // Leva os estilos do site para a janelinha (as fontes externas vão como link).
    for (const sheet of document.styleSheets) {
      try {
        const style = win.document.createElement('style');
        style.textContent = [...sheet.cssRules].map((r) => r.cssText).join('\n');
        win.document.head.append(style);
      } catch {
        if (sheet.href) win.document.head.append(Object.assign(win.document.createElement('link'), { rel: 'stylesheet', href: sheet.href }));
      }
    }
    win.document.title = this.info.title;
    win.document.body.className = 'pip-doc';
    // No lugar do player fica um aviso; clicar nele traz o vídeo de volta.
    this.slot = document.createElement('button');
    this.slot.className = 'pip-slot';
    this.slot.innerHTML = `${icon('pip', 40)}<b>Tocando no miniplayer</b><span>Clique para trazer o vídeo de volta</span>`;
    this.slot.addEventListener('click', () => this.exitPip());
    this.root.replaceWith(this.slot);
    win.document.body.append(this.root);
    this.root.classList.add('in-pip');
    this.pipWin = win;
    win.document.addEventListener('keydown', this.onKey);
    win.addEventListener('pagehide', () => this.pipClosed(), { once: true });
    if (this.playing && this.v.paused) this.v.play().catch(() => {});
  }
  // A janelinha fechou (pelo X ou pelo "voltar"): o player volta para o lugar dele, se ele ainda existir.
  pipClosed() {
    const win = this.pipWin;
    if (!win) return;
    this.pipWin = null;
    win.document.removeEventListener('keydown', this.onKey);
    this.root.classList.remove('in-pip');
    if (this.slot?.isConnected) {
      this.slot.replaceWith(this.root);
      if (this.playing && this.v.paused) this.v.play().catch(() => {});
    } else {
      this.opts.onPipClosed?.(); // você já estava em outra página: fechar o pop-up para o vídeo
    }
    this.slot = null;
  }
  exitPip() {
    if (this.pipWin) this.pipWin.close();
    else if (document.pictureInPictureElement === this.v) document.exitPictureInPicture().catch(() => {});
  }
  // Volta da janelinha para uma página nova do mesmo vídeo (você navegou e voltou para ele).
  dock(el) {
    if (this.slot) this.slot.replaceWith(el);
    this.slot = el;
    this.exitPip();
  }

  // Pula para o momento atual da transmissão.
  goLive() {
    const edge = this.hls?.liveSyncPosition ?? (this.v.seekable.length ? this.v.seekable.end(this.v.seekable.length - 1) - 3 : null);
    if (edge != null) this.v.currentTime = edge;
    if (!this.playing) this.play();
  }

  // Elemento que toca o som (áudio separado ou o próprio vídeo, no plano B).
  get out() { return this.a || this.v; }
  // Com áudio separado, "tocando" é o som (a imagem pode estar pausada pelo navegador ou no modo só áudio).
  // Se o som deu erro, quem diz se está tocando é a imagem (senão o botão de "tocar" fica na tela com o vídeo andando).
  get playing() { return this.a && !this.a.error ? !this.a.paused : !this.v.paused; }
  // Tempo atual: segue o som quando a imagem não está andando.
  get now() { return this.a && (this.audioOnly || (this.v.paused && !this.a.paused)) ? this.a.currentTime : this.v.currentTime; }
  get duration() { return this.v.duration || this.a?.duration || this.info.duration || 0; }

  play() {
    this.userPaused = false;
    this.endedFired = false;
    this.root.classList.add('loading');
    if (this.a) {
      if (!this.audioOnly) this.a.currentTime = this.v.currentTime;
      this.a.play().then(() => this.root.classList.remove('loading')).catch(() => {});
    }
    if (this.audioOnly) return;
    this.v.play().catch(() => {
      this.root.classList.remove('loading');
      this.renderState();
    });
  }
  pause() {
    this.userPaused = true;
    this.v.pause();
    this.a?.pause();
  }
  toggle() {
    const pausing = this.playing && !this.v.ended;
    pausing ? this.pause() : this.play();
    this.bezel(pausing ? 'pause' : 'play');
  }

  // Ícone que aparece no centro e some (como no YouTube).
  bezel(name, text = '') {
    const b = this.bezelEl;
    b.innerHTML = `<span>${icon(name, 30)}${text ? `<b>${text}</b>` : ''}</span>`;
    b.classList.remove('show');
    void b.offsetWidth;
    b.classList.add('show');
  }
  // Aviso curto dentro do player (ex.: "Patrocínio pulado").
  chip(text) {
    this.chipEl.textContent = text;
    this.chipEl.classList.remove('show');
    void this.chipEl.offsetWidth;
    this.chipEl.classList.add('show');
  }

  setAudio(src) {
    if (!this.a || src === this.audioSrc) return;
    const t = this.now;
    const playing = this.playing;
    this.audioSrc = src;
    this.a.src = src;
    this.a.addEventListener('loadedmetadata', () => {
      this.a.currentTime = t;
      this.a.playbackRate = this.v.playbackRate;
      if (playing) this.a.play().catch(() => {});
    }, { once: true });
  }
  // Miniatura da prévia: acha a folha do storyboard que cobre o tempo t e recorta o quadro dela.
  paintThumb(t) {
    const sb = this.info.storyboard;
    let start = 0, k = 0;
    while (k < sb.sheets.length - 1 && t >= start + sb.sheets[k].dur) start += sb.sheets[k++].dur;
    const i = Math.min(sb.cols * sb.rows - 1, Math.floor((t - start) * sb.fps));
    const scale = this.thumb.offsetWidth / sb.w;
    const s = this.thumb.style;
    s.backgroundImage = `url("${sb.sheets[k].url}")`;
    s.backgroundSize = `${sb.cols * sb.w * scale}px auto`;
    s.backgroundPosition = `-${(i % sb.cols) * sb.w * scale}px -${Math.floor(i / sb.cols) * sb.h * scale}px`;
    s.aspectRatio = `${sb.w} / ${sb.h}`;
  }
  seek(t) {
    t = Math.min(Math.max(0, t), this.duration - 0.2);
    if (!this.audioOnly) this.v.currentTime = t;
    if (this.a) this.a.currentTime = t;
    this.lastT = t;
    this.renderTime();
  }
  setRate(r, remember = true) {
    this.v.playbackRate = r;
    if (this.a) this.a.playbackRate = r;
    if (remember) this.opts.onRate?.(r);
    this.renderBadges();
  }

  // ---------- modo só áudio: descarta a imagem (economiza dados) e toca só o som ----------
  setAudioOnly(on, notify = true) {
    if (!this.a || on === !!this.audioOnly) return;
    const t = this.now;
    const playing = this.playing;
    this.audioOnly = on;
    save('audioOnly', on);
    this.root.classList.toggle('audio-only', on);
    if (on) {
      this.v.pause();
      this.v.removeAttribute('src');
      this.v.load();
      this.a.currentTime = t;
      if (playing) this.a.play().catch(() => {});
    } else {
      this.v.src = this.quality.src;
      this.v.addEventListener('loadedmetadata', () => {
        this.v.playbackRate = this.a.playbackRate;
        this.v.currentTime = this.a.currentTime;
        if (this.playing) this.v.play().catch(() => {});
      }, { once: true });
    }
    if (notify) this.chip(on ? 'Modo só áudio ligado' : 'Vídeo de volta');
    this.renderBadges();
  }

  // ---------- capturar quadro: salva a imagem atual do vídeo em PNG ----------
  screenshot() {
    if (this.audioOnly || !this.v.videoWidth) return this.chip('Ligue o vídeo para capturar');
    const c = document.createElement('canvas');
    c.width = this.v.videoWidth;
    c.height = this.v.videoHeight;
    c.getContext('2d').drawImage(this.v, 0, 0);
    c.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${this.info.title.replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 80)} - ${time(this.now).replace(/:/g, '-')}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      this.bezel('camera');
      this.opts.onToast?.('Quadro salvo em PNG');
    }, 'image/png');
  }

  // ---------- repetir trecho A-B ----------
  setLoop(kind) {
    const t = this.now;
    if (kind === 'a') { this.loopA = t; if (this.loopB != null && this.loopB <= t) this.loopB = null; this.chip(`Início do trecho: ${time(t)}`); }
    if (kind === 'b') {
      if (this.loopA == null) this.loopA = 0;
      if (t <= this.loopA + 0.5) return this.chip('O fim precisa vir depois do início');
      this.loopB = t;
      this.chip(`Repetindo ${time(this.loopA)} – ${time(t)}`);
      this.seek(this.loopA);
    }
    if (kind === 'all') { this.loopAll = !this.loopAll; this.loopA = this.loopB = null; this.chip(this.loopAll ? 'Repetindo o vídeo' : 'Repetição desligada'); }
    if (kind === 'off') { this.loopA = this.loopB = null; this.loopAll = false; this.chip('Repetição desligada'); }
    this.renderMarks();
    this.renderBadges();
  }

  // ---------- timer para dormir ----------
  setSleep(min) {
    clearInterval(this.sleepTimer);
    this.sleep = min;
    this.sleepAt = min > 0 ? Date.now() + min * 60000 : 0;
    if (min > 0) {
      this.sleepTimer = setInterval(() => {
        if (Date.now() >= this.sleepAt) {
          clearInterval(this.sleepTimer);
          this.sleep = 0;
          this.fadeOutAndPause();
        }
        this.renderBadges();
      }, 1000);
    }
    this.chip(min > 0 ? `Pausa em ${min} min` : min === -1 ? 'Pausa no fim do vídeo' : 'Timer desligado');
    this.renderBadges();
  }
  // Abaixa o volume aos poucos antes de pausar (mais gostoso para dormir).
  fadeOutAndPause() {
    const o = this.out;
    const start = o.volume;
    let i = 0;
    const step = setInterval(() => {
      i++;
      o.volume = Math.max(0, start * (1 - i / 20));
      if (i >= 20) {
        clearInterval(step);
        this.pause();
        o.volume = start;
        this.opts.onToast?.('Boa noite! O timer pausou o vídeo.');
        this.renderBadges();
      }
    }, 150);
  }

  // ---------- trechos do SponsorBlock e marcas dos seus momentos ----------
  setSegments(list, enabled) {
    this.segments = list || [];
    this.skipSegments = enabled;
    this.renderMarks();
  }
  setMarks(list) {
    this.marks = list || [];
    this.renderMarks();
  }
  renderMarks() {
    const d = this.duration;
    if (!d) { this.v.addEventListener('loadedmetadata', () => this.renderMarks(), { once: true }); return; }
    const pct = (t) => `${(Math.min(t, d) / d) * 100}%`;
    this.marksEl.innerHTML = [
      ...this.chapters.filter((c) => c.start > 0.5).map((c) => `<i class="chg" style="left:${pct(c.start)}"></i>`),
      ...this.segments.map((s) => `<i class="seg seg-${s.category}" style="left:${pct(s.start)};width:calc(${pct(s.end)} - ${pct(s.start)})" title="${SEG_NAMES[s.category] || s.category}"></i>`),
      ...this.marks.map((m) => `<i class="mk" style="left:${pct(m.t)}" title="${(m.note || time(m.t)).replace(/"/g, '&quot;')}"></i>`),
      this.loopA != null && this.loopB != null ? `<i class="ab" style="left:${pct(this.loopA)};width:calc(${pct(this.loopB)} - ${pct(this.loopA)})"></i>` : '',
    ].join('');
  }

  // ---------- capítulos: os do canal ou, sem eles, os marcados pela comunidade (SponsorBlock) ----------
  setChapters(list, community = false) {
    this.chapters = list || [];
    this.chaptersCommunity = community;
    this.curChapter = undefined;
    this.renderMarks();
    this.renderChapter();
  }
  chapterAt(t) {
    const c = this.chapters[lastAt(this.chapters, t + 0.01, 'start')];
    return c && !(c.end && t > c.end) ? c : null; // os da comunidade podem ter buracos entre um e outro
  }
  renderChapter() {
    const c = this.chapters.length ? this.chapterAt(this.now) : null;
    if (c === this.curChapter) return;
    this.curChapter = c;
    this.chapterEl.hidden = !c;
    this.chapterEl.querySelector('span').textContent = c?.title || '';
  }

  // ---------- legendas: falas pedidas ao servidor e desenhadas por cima do vídeo ----------
  cues(key) {
    if (!this.cueCache.has(key)) {
      const job = fetch(`/api/subs?id=${this.info.id}&k=${encodeURIComponent(key)}`).then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !Array.isArray(j)) throw new Error(j.error || 'Legenda indisponível agora');
        return j;
      });
      job.catch(() => this.cueCache.delete(key));
      this.cueCache.set(key, job);
    }
    return this.cueCache.get(key);
  }
  async setSubs(key, remember = true) {
    const track = this.subs.find((s) => s.key === key) || null;
    this.subKey = track?.key || null;
    this.cueList = [];
    this.renderCue(true);
    if (remember) save('captions', { on: Boolean(track), lang: track?.lang || load('captions', {}).lang });
    this.root.querySelector('.p-cc-btn')?.setAttribute('aria-pressed', String(Boolean(track)));
    if (!track) return;
    try {
      const list = await this.cues(track.key);
      if (this.subKey === track.key) { this.cueList = list; this.renderCue(true); }
    } catch (e) {
      if (this.subKey !== track.key) return;
      this.subKey = null;
      this.root.querySelector('.p-cc-btn')?.setAttribute('aria-pressed', 'false');
      this.chip(e.message);
    }
  }
  toggleSubs() {
    if (this.subKey) { this.setSubs(null); return this.chip('Legendas desligadas'); }
    const s = this.subs.find((x) => x.lang === load('captions', {}).lang) || this.subs[0];
    this.setSubs(s.key);
    this.chip(`Legendas: ${s.label}`);
  }
  renderCue(force = false) {
    const t = this.now;
    const c = this.cueList[lastAt(this.cueList, t)];
    const cue = c && t < c.e ? c : null;
    if (cue === this.curCue && !force) return;
    this.curCue = cue;
    this.ccEl.hidden = !cue;
    this.ccEl.firstElementChild.textContent = cue?.t || '';
  }

  // Selos ao lado da engrenagem: mostram o que está ligado.
  renderBadges() {
    const b = [];
    const r = this.v.playbackRate;
    if (r !== 1) b.push(`${String(r).replace('.', ',')}x`);
    if (this.audioOnly) b.push(icon('headphones', 14));
    if (this.loopAll || this.loopB != null) b.push(icon('repeat', 14));
    if (this.sleep > 0) b.push(`${icon('moon', 14)} ${Math.max(1, Math.ceil((this.sleepAt - Date.now()) / 60000))}m`);
    if (this.sleep === -1) b.push(icon('moon', 14));
    this.badgesEl.innerHTML = b.map((x) => `<span>${x}</span>`).join('');
  }

  // Executado a cada atualização de tempo (da imagem ou, no modo só áudio, do som).
  tick() {
    const t = this.now;
    this.renderTime();
    this.syncAudio(false);
    if (this.subKey) this.renderCue();
    if (this.chapters.length) this.renderChapter();
    // Repetir trecho A-B
    if (this.loopB != null && t >= this.loopB) { this.seek(this.loopA); return; }
    // Pular patrocínios: só quando a reprodução entra no trecho (se você voltar de propósito, ele deixa).
    if (this.skipSegments && this.playing) {
      const prev = this.lastT ?? t;
      const seg = this.segments.find((s) => prev <= s.start + 0.25 && t >= s.start && t < s.end - 0.3);
      if (seg) {
        this.seek(seg.end);
        this.chip(`${SEG_NAMES[seg.category] || 'Trecho'} pulado`);
      }
    }
    // Tempo assistido de verdade (para as estatísticas): conta só enquanto toca, em passos pequenos.
    if (this.playing && this.lastT != null && t > this.lastT && t - this.lastT < 2) {
      this.watchAcc += (t - this.lastT) / (this.v.playbackRate || 1);
      if (this.watchAcc >= 10) { this.opts.onTick?.(Math.round(this.watchAcc)); this.watchAcc = 0; }
    }
    this.lastT = t;
    const now = Date.now();
    if (now - this.lastSave > 4000) { this.lastSave = now; this.opts.onProgress?.(t, this.duration); }
  }

  bind() {
    const { v, a } = this;
    const on = (el, ev, fn) => el.addEventListener(ev, fn);

    // Em segundo plano o navegador pausa vídeos sem som "para economizar energia". Só a pausa pedida por você
    // para o áudio; qualquer outra mantém o som tocando e a imagem alcança quando a aba volta ao foco.
    const browserPause = () => !this.userPaused && !v.ended;
    on(v, 'play', () => { this.syncAudio(true); this.renderState(); this.wake(); });
    on(v, 'pause', () => { if (a && !browserPause()) a.pause(); this.renderState(); this.wake(); });
    on(v, 'waiting', () => { this.root.classList.add('loading'); if (!browserPause()) a?.pause(); });
    on(v, 'playing', () => { this.root.classList.remove('loading'); this.syncAudio(true); });
    on(v, 'canplay', () => this.root.classList.remove('loading'));
    on(v, 'seeking', () => { if (a && !this.audioOnly) a.currentTime = v.currentTime; });
    on(v, 'progress', () => this.renderBuffer());
    on(v, 'timeupdate', () => { if (!this.audioOnly) this.tick(); });
    const ended = () => {
      if (this.endedFired) return;
      if (this.loopAll) { this.seek(0); this.play(); return; }
      this.endedFired = true;
      a?.pause();
      if (this.watchAcc > 1) { this.opts.onTick?.(Math.round(this.watchAcc)); this.watchAcc = 0; }
      this.opts.onProgress?.(this.duration, this.duration);
      this.renderState();
      if (this.sleep === -1) { this.sleep = 0; this.renderBadges(); this.opts.onToast?.('Boa noite! Parei no fim do vídeo.'); return; }
      this.opts.onEnded?.();
    };
    on(v, 'ended', ended);
    on(v, 'seeking', () => { this.endedFired = false; });
    for (const el of [v, a].filter(Boolean)) for (const ev of ['loadedmetadata', 'playing', 'pause', 'seeked', 'ratechange']) on(el, ev, () => this.positionState());
    on(v, 'error', () => { if (!this.audioOnly) this.recover(); });
    on(v, 'enterpictureinpicture', () => this.root.classList.add('in-pip'));
    on(v, 'leavepictureinpicture', () => this.root.classList.remove('in-pip'));
    if (a) {
      // O vídeo manda; se o áudio engasgar, ele se recupera sozinho (pausar o vídeo aqui criava um ciclo de pausa/play).
      on(a, 'ended', () => { if (v.paused || this.audioOnly) ended(); });
      on(a, 'play', () => this.renderState());
      on(a, 'pause', () => this.renderState());
      on(a, 'playing', () => this.root.classList.remove('loading'));
      // Com a imagem parada (segundo plano ou modo só áudio), o tempo segue o som.
      on(a, 'timeupdate', () => { if (this.audioOnly || (v.paused && !a.paused)) this.tick(); });
      on(a, 'error', () => this.recover());
      if (window.meutubeApp) {
        // Diagnóstico no celular: se o som não acompanhar a imagem, mostra o motivo na tela.
        on(a, 'error', () => this.chip(`Som com erro ${a.error?.code || ''}: ${a.error?.message || 'sem detalhes'}`.slice(0, 120)));
        on(v, 'playing', () => setTimeout(() => {
          if (this.destroyed || v.paused || this.audioOnly || !a.paused) return;
          this.chip(`O som não começou (estado ${a.readyState}, rede ${a.networkState})`);
          a.play().catch((e) => this.chip(`O som não começou: ${e.name}`));
        }, 4000));
      }
    }
    this.onVisible = () => {
      if (this.audioOnly || document.hidden || !a || a.paused || this.userPaused || !v.paused) return;
      v.currentTime = a.currentTime;
      v.play().catch(() => {});
    };
    document.addEventListener('visibilitychange', this.onVisible);
    addEventListener('focus', this.onVisible);
    this.root.addEventListener('pointerenter', this.onVisible);

    // Controles
    on(this.root, 'click', (e) => {
      const b = e.target.closest('[data-a]');
      if (b) {
        e.stopPropagation();
        const act = b.dataset.a;
        const val = b.dataset.v;
        if (act === 'toggle') this.toggle();
        if (act === 'next') this.opts.onNext?.();
        if (act === 'golive') this.goLive();
        if (act === 'pip') this.togglePip();
        if (act === 'mute') { this.out.muted = !this.out.muted; this.renderVolume(); }
        if (act === 'fs') this.fullscreen();
        if (act === 'menu') this.toggleMenu();
        if (act === 'panel') this.renderMenu(val, val === 'main' ? -1 : 1);
        if (act === 'speed') { this.setRate(Number(val)); this.renderMenu('main', -1); }
        if (act === 'quality') { this.setQuality(Number(val)); this.renderMenu('main', -1); }
        if (act === 'audio') { this.setAudio(val); this.renderMenu('main', -1); }
        if (act === 'loop') { this.setLoop(val); this.renderMenu('main', -1); }
        if (act === 'sleep') { this.setSleep(Number(val)); this.renderMenu('main', -1); }
        if (act === 'audio-only') { this.setAudioOnly(!this.audioOnly); this.renderMenu('main', 0); }
        if (act === 'cc') this.toggleSubs();
        if (act === 'sub') { this.setSubs(val || null); this.renderMenu('main', -1); }
        if (act === 'chapters') { this.toggleMenu(true); this.renderMenu('chapters', 0); }
        if (act === 'chapter') { this.seek(Number(val)); this.toggleMenu(false); }
        if (act === 'skip') { this.skipSegments = !this.skipSegments; this.opts.onSkipToggle?.(this.skipSegments); this.renderMenu('main', 0); }
        if (act === 'shot') { this.toggleMenu(false); this.screenshot(); }
        return;
      }
      if (e.target.closest('.p-bar, .p-menu')) return;
      if (!this.menu.hidden) return this.toggleMenu(false);
      // No toque (celular), tocar no vídeo só mostra ou esconde os controles, como no app do YouTube;
      // pausar fica no botão. Com o mouse, clicar no vídeo pausa/toca.
      if (this.lastPointer === 'touch') {
        if (this.root.classList.contains('idle')) return this.wake();
        clearTimeout(this.idleTimer);
        if (this.playing) this.root.classList.add('idle');
        return;
      }
      this.toggle();
    });
    // Duplo clique (mouse): tela cheia. Duplo toque (celular): volta ou avança 10 s nas laterais.
    on(this.root, 'dblclick', (e) => {
      if (e.target.closest('.p-bar, .p-menu')) return;
      if (this.lastPointer !== 'touch') return this.fullscreen();
      const r = this.root.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width;
      if (x < 0.35) { this.seek(this.now - 10); this.bezel('back', '10 s'); }
      else if (x > 0.65) { this.seek(this.now + 10); this.bezel('fwd', '10 s'); }
    });
    on(this.root, 'pointerdown', (e) => { this.lastPointer = e.pointerType; });
    on(this.root, 'pointermove', (e) => { if (e.pointerType === 'mouse') this.wake(); });
    // Só o mouse saindo esconde os controles. No celular o Android avisa "saiu" ao fim de todo toque, antes de
    // decidir onde o toque caiu: escondendo ali, o toque caía no vídeo e nenhum botão do player funcionava.
    on(this.root, 'pointerleave', (e) => { if (e.pointerType === 'mouse' && this.playing) this.root.classList.add('idle'); });
    on(this.volInput, 'input', () => { this.out.volume = Number(this.volInput.value); this.out.muted = this.out.volume === 0; this.renderVolume(); });

    // Barra de progresso: arrastar, clicar e prévia do tempo (mostra o nome do trecho ou do seu momento).
    const at = (e) => {
      const r = this.bar.getBoundingClientRect();
      return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    };
    on(this.bar, 'pointermove', (e) => {
      const p = at(e);
      const t = p * this.duration;
      const seg = this.segments.find((s) => t >= s.start && t <= s.end);
      const mk = this.marks.find((m) => Math.abs(m.t - t) < this.duration / 120);
      this.tipText.textContent = `${time(t)}${mk?.note ? ` · ${mk.note}` : seg ? ` · ${SEG_NAMES[seg.category] || ''}` : ''}`;
      this.tipCh.textContent = this.chapters.length ? this.chapterAt(t)?.title || '' : '';
      if (this.thumb) this.paintThumb(t);
      // Com a miniatura, a prévia não passa da borda do player (igual ao YouTube).
      const half = this.thumb ? this.tip.offsetWidth / 2 / this.bar.offsetWidth : 0;
      this.tip.style.left = `${Math.min(1 - half, Math.max(half, p)) * 100}%`;
      if (this.dragging) this.paint(p);
    });
    on(this.bar, 'pointerdown', (e) => {
      this.dragging = true;
      this.bar.setPointerCapture(e.pointerId);
      this.bar.classList.add('drag');
      this.paint(at(e));
    });
    const end = (e) => {
      if (!this.dragging) return;
      this.dragging = false;
      this.bar.classList.remove('drag');
      this.seek(at(e) * this.duration);
    };
    on(this.bar, 'pointerup', end);
    on(this.bar, 'pointercancel', () => { this.dragging = false; this.bar.classList.remove('drag'); });
    on(this.bar, 'keydown', (e) => {
      if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); this.seek(this.now - 5); }
      if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); this.seek(this.now + 5); }
    });

    this.onKey = (e) => {
      if (e.target.closest('input, textarea, [contenteditable]') || e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      const stepRate = (dir) => {
        const i = SPEEDS.indexOf(this.v.playbackRate);
        const r = SPEEDS[Math.min(SPEEDS.length - 1, Math.max(0, (i < 0 ? 3 : i) + dir))];
        this.setRate(r);
        this.bezel('gauge', `${String(r).replace('.', ',')}x`);
      };
      const act = {
        ' ': () => this.toggle(), k: () => this.toggle(),
        j: () => { this.seek(this.now - 10); this.bezel('back', '10 s'); },
        l: () => { this.seek(this.now + 10); this.bezel('fwd', '10 s'); },
        arrowleft: () => { this.seek(this.now - 5); this.bezel('back', '5 s'); },
        arrowright: () => { this.seek(this.now + 5); this.bezel('fwd', '5 s'); },
        arrowup: () => { this.nudgeVolume(0.05); this.bezel('volume', `${Math.round(this.out.volume * 100)}%`); },
        arrowdown: () => { this.nudgeVolume(-0.05); this.bezel(this.out.volume ? 'volume' : 'mute', `${Math.round(this.out.volume * 100)}%`); },
        m: () => { this.out.muted = !this.out.muted; this.renderVolume(); this.bezel(this.out.muted ? 'mute' : 'volume'); },
        f: () => this.fullscreen(),
        n: () => this.opts.onNext?.(),
        s: () => this.screenshot(),
        c: () => { if (this.subs.length) this.toggleSubs(); },
        i: () => { if (PIP_OK) this.togglePip(); },
        '>': () => stepRate(1), '<': () => stepRate(-1),
      }[k];
      if (!act) return;
      if (k === ' ' && e.target.closest('button, a')) return;
      e.preventDefault();
      act();
      this.wake();
    };
    document.addEventListener('keydown', this.onKey);
    // Fecha o menu ao clicar fora do player ou apertar Esc.
    this.onDocClick = (e) => {
      if (!this.menu.hidden && e.target.isConnected && !this.root.contains(e.target)) this.toggleMenu(false);
    };
    this.onEsc = (e) => {
      if (e.key === 'Escape' && !this.menu.hidden) { e.stopPropagation(); this.toggleMenu(false); this.root.querySelector('[data-a="menu"]').focus(); }
    };
    document.addEventListener('click', this.onDocClick);
    this.root.addEventListener('keydown', this.onEsc);
    this.onFs = () => {
      const fs = document.fullscreenElement === this.root;
      this.root.querySelector('[data-a="fs"]').innerHTML = icon(fs ? 'minimize' : 'maximize', 20);
    };
    document.addEventListener('fullscreenchange', this.onFs);
  }

  // Mantém o áudio colado no vídeo; corrige quando a diferença passa de 0,3 s.
  syncAudio(forcePlay) {
    const { v, a } = this;
    if (!a || this.audioOnly || v.paused || (document.hidden && !this.inPip)) return;
    // Corrige no máximo a cada 1,5 s: cada correção faz o áudio recarregar um instante.
    const now = performance.now();
    if (Math.abs(a.currentTime - v.currentTime) > DRIFT && now - (this.lastFix || 0) > 1500) {
      this.lastFix = now;
      a.currentTime = v.currentTime;
    }
    if (forcePlay && a.paused) a.play().catch(() => {});
  }

  async recover() {
    if (this.retried || this.destroyed) return;
    this.retried = true;
    const t = this.now;
    const playing = this.playing;
    // No PC os endereços (/media/...) continuam os mesmos; no app eles são links do YouTube e mudam ao renovar.
    let fresh = null;
    try { fresh = await (await fetch(`/api/video?id=${this.info.id}&fresh=1`)).json(); } catch {}
    if (fresh?.qualities?.length) {
      const q = fresh.qualities.find((x) => x.height === this.quality.height) || fresh.qualities[0];
      const lang = this.info.audios?.find((x) => x.src === this.audioSrc)?.lang;
      this.info.qualities = fresh.qualities;
      this.info.audios = fresh.audios || [];
      this.quality = q;
      if (fresh.audio) this.audioSrc = (fresh.audios || []).find((x) => x.lang === lang)?.src || fresh.audio;
    }
    // Live: recomeça do momento atual (e pode tentar de novo daqui a 30 s, se o sinal cair outra vez).
    if (this.quality.hls) { setTimeout(() => { this.retried = false; }, 30000); return this.setSrc(this.quality.src); }
    const bust = (src) => (src.startsWith('/') ? `${src}?r=${Date.now()}` : src);
    if (!this.audioOnly) this.v.src = bust(this.quality.src);
    if (this.a) this.a.src = bust(this.audioSrc);
    (this.audioOnly ? this.a : this.v).addEventListener('loadedmetadata', () => { this.seek(t); if (playing) this.play(); }, { once: true });
  }

  setQuality(h) {
    if (this.hls) {
      save('liveQuality', h === -1 ? 0 : h);
      this.hls.currentLevel = h === -1 ? -1 : this.hls.levels.findIndex((l) => l.height === h);
      return;
    }
    const q = this.info.qualities.find((x) => x.height === h);
    if (!q || q === this.quality) return;
    save('quality2k', h);
    this.quality = q;
    if (this.audioOnly) return; // aplica quando o vídeo voltar
    const t = this.now;
    const playing = this.playing;
    const rate = this.v.playbackRate;
    this.v.src = q.src;
    this.v.addEventListener('loadedmetadata', () => {
      this.v.playbackRate = rate;
      this.seek(t);
      if (playing) this.play();
    }, { once: true });
  }

  nudgeVolume(d) {
    this.out.volume = Math.min(1, Math.max(0, this.out.volume + d));
    this.out.muted = false;
    this.renderVolume();
  }

  fullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else this.root.requestFullscreen?.().catch(() => {});
  }

  toggleMenu(force) {
    const open = force ?? this.menu.hidden;
    if (open) this.renderMenu('main', 0);
    this.menu.hidden = !open;
    this.root.classList.toggle('menu-open', open);
    this.root.querySelector('[data-a="menu"]').setAttribute('aria-expanded', String(open));
  }

  wake() {
    this.root.classList.remove('idle');
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.playing && this.menu.hidden && !this.dragging) this.root.classList.add('idle');
    }, this.lastPointer === 'touch' ? 4000 : 2600); // no dedo, um pouco mais de tempo para achar o botão
  }

  paint(p) {
    this.played.style.width = `${p * 100}%`;
    this.knob.style.left = `${p * 100}%`;
  }

  renderTime() {
    if (this.dragging) return;
    const d = this.duration;
    const t = this.now;
    if (this.live) {
      // Ponto vermelho = no momento atual; cinza = assistindo atrasado (clique volta para o atual).
      const edge = this.v.seekable.length ? this.v.seekable.end(this.v.seekable.length - 1) : t;
      this.root.querySelector('.p-live').classList.toggle('behind', edge - t > 20);
      return;
    }
    this.paint(d ? t / d : 0);
    this.timeEl.textContent = `${time(t)} / ${time(d)}`;
    this.bar.setAttribute('aria-valuemax', String(Math.round(d)));
    this.bar.setAttribute('aria-valuenow', String(Math.round(t)));
    this.bar.setAttribute('aria-valuetext', `${time(t)} de ${time(d)}`);
  }

  renderBuffer() {
    const { v } = this;
    const d = v.duration;
    if (!d) return;
    for (let i = 0; i < v.buffered.length; i++) {
      if (v.buffered.start(i) <= v.currentTime + 0.5 && v.buffered.end(i) >= v.currentTime) {
        this.buf.style.width = `${(v.buffered.end(i) / d) * 100}%`;
        return;
      }
    }
  }

  renderState() {
    const playing = this.playing && !this.v.ended;
    this.root.classList.toggle('playing', playing);
    this.root.querySelectorAll('.p-row [data-a="toggle"]').forEach((b) => {
      b.innerHTML = icon(playing ? 'pause' : 'play', 22);
      b.setAttribute('aria-label', playing ? 'Pausar' : 'Reproduzir');
    });
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
  }

  renderVolume() {
    const o = this.out;
    const muted = o.muted || o.volume === 0;
    this.volInput.value = String(muted ? 0 : o.volume);
    this.volInput.style.setProperty('--v', `${(muted ? 0 : o.volume) * 100}%`);
    const b = this.root.querySelector('[data-a="mute"]');
    b.innerHTML = icon(muted ? 'mute' : 'volume', 21);
    b.setAttribute('aria-label', muted ? 'Ativar som' : 'Silenciar');
    save('volume', { v: o.volume || 1, m: muted });
  }

  // Menu de configurações no estilo do YouTube: lista principal e submenus que deslizam.
  renderMenu(panel = 'main', dir = 0) {
    const speedLabel = (s) => (s === 1 ? 'Normal' : `${String(s).replace('.', ',')}x`);
    const qLabel = (h) => `${h}p${h >= 2160 ? '<b class="hd">4K</b>' : h >= 1440 ? '<b class="hd">2K</b>' : h >= 1080 ? '<b class="hd">HD</b>' : ''}`;
    const audios = this.info.audios || [];
    const curAudio = audios.find((x) => x.src === this.audioSrc);
    const row = (id, ic, label, value) => `<button class="pm-row" role="menuitem" data-a="panel" data-v="${id}">
      <span class="pm-ic">${icon(ic, 22)}</span><span class="pm-label">${label}</span><span class="pm-val">${value}</span>${icon('chevron', 18)}</button>`;
    const sw = (act, ic, label, on, hint = '') => `<button class="pm-row pm-switch" role="menuitemcheckbox" aria-checked="${on}" data-a="${act}">
      <span class="pm-ic">${icon(ic, 22)}</span><span class="pm-label">${label}${hint ? `<small>${hint}</small>` : ''}</span><span class="pm-toggle ${on ? 'on' : ''}"></span></button>`;
    const action = (act, ic, label, hint) => `<button class="pm-row" role="menuitem" data-a="${act}">
      <span class="pm-ic">${icon(ic, 22)}</span><span class="pm-label">${label}</span><span class="pm-val">${hint}</span></button>`;
    const item = (act, v, label, on) => `<button class="pm-item ${on ? 'on' : ''}" role="menuitemradio" aria-checked="${on}" data-a="${act}" data-v="${v}">
      <span class="pm-check">${on ? icon('check', 20) : ''}</span><span>${label}</span></button>`;
    const head = (title) => `<button class="pm-head" data-a="panel" data-v="main">${icon('chevronLeft', 22)}<span>${title}</span></button>`;
    const loopLabel = this.loopAll ? 'Vídeo inteiro' : this.loopB != null ? `${time(this.loopA)}–${time(this.loopB)}` : 'Desligado';
    const sleepLabel = this.sleep > 0 ? `${Math.max(1, Math.ceil((this.sleepAt - Date.now()) / 60000))} min` : this.sleep === -1 ? 'Fim do vídeo' : 'Desligado';

    // Live: as qualidades vêm da própria lista HLS, com "Automática" (ajusta à internet) por padrão.
    const hls = this.hls;
    const hlsHeights = hls ? [...new Set(hls.levels.map((l) => l.height).filter(Boolean))].sort((a, b) => b - a) : [];
    const hlsNow = hls?.levels[hls.currentLevel]?.height;
    const qValue = this.audioOnly ? 'Só áudio' : hls ? (hls.autoLevelEnabled ? `Automática${hlsNow ? ` (${hlsNow}p)` : ''}` : qLabel(hlsNow || 0)) : qLabel(this.quality.height);

    let html;
    if (panel === 'speed') html = head('Velocidade (lembrada por canal)') + SPEEDS.map((s) => item('speed', s, speedLabel(s), s === this.v.playbackRate)).join('');
    else if (panel === 'quality' && hls) html = head('Qualidade') + item('quality', -1, 'Automática', hls.autoLevelEnabled) + hlsHeights.map((h) => item('quality', h, qLabel(h), !hls.autoLevelEnabled && h === hlsNow)).join('');
    else if (panel === 'quality') html = head('Qualidade') + this.info.qualities.map((q) => item('quality', q.height, qLabel(q.height), q === this.quality)).join('');
    else if (panel === 'audio') html = head('Faixa de áudio') + audios.map((x) => item('audio', x.src, x.label, x === curAudio)).join('');
    else if (panel === 'loop') {
      html = head('Repetir')
        + item('loop', 'a', `Marcar início aqui (${time(this.now)})`, this.loopA != null && this.loopB == null)
        + item('loop', 'b', `Marcar fim aqui e repetir (${time(this.now)})`, this.loopB != null)
        + item('loop', 'all', 'Repetir o vídeo inteiro', this.loopAll)
        + item('loop', 'off', 'Desligar repetição', !this.loopAll && this.loopB == null && this.loopA == null);
    } else if (panel === 'subs') {
      html = head('Legendas (tecla C)') + item('sub', '', 'Desligadas', !this.subKey) + this.subs.map((s) => item('sub', s.key, esc(s.label), s.key === this.subKey)).join('');
    } else if (panel === 'chapters') {
      const cur = this.chapterAt(this.now);
      html = head(this.chaptersCommunity ? 'Capítulos (marcados pela comunidade)' : 'Capítulos')
        + this.chapters.map((c) => item('chapter', c.start, `<span class="pm-ts">${time(c.start)}</span>${esc(c.title)}`, c === cur)).join('');
    } else if (panel === 'sleep') {
      html = head('Timer para dormir') + SLEEP.map((m) => item('sleep', m, m === 0 ? 'Desligado' : m === -1 ? 'No fim deste vídeo' : `${m} minutos`, this.sleep === m)).join('');
    } else {
      html = row('speed', 'gauge', 'Velocidade', speedLabel(this.v.playbackRate))
        + row('quality', 'quality', 'Qualidade', qValue)
        + (audios.length > 1 ? row('audio', 'headphones', 'Faixa de áudio', curAudio?.label || '') : '')
        + (this.subs.length ? row('subs', 'cc', 'Legendas', esc(this.subs.find((s) => s.key === this.subKey)?.label || 'Desligadas')) : '')
        + (this.chapters.length ? row('chapters', 'chapters', 'Capítulos', esc(this.chapterAt(this.now)?.title || `${this.chapters.length}`)) : '')
        + row('loop', 'repeat', 'Repetir', loopLabel)
        + row('sleep', 'moon', 'Timer para dormir', sleepLabel)
        + (this.a ? sw('audio-only', 'headphones', 'Modo só áudio', !!this.audioOnly, 'gasta bem menos internet') : '')
        + (this.segments.length ? sw('skip', 'skipForward', 'Pular patrocínios', this.skipSegments, `${this.segments.length} trecho(s) neste vídeo`) : '')
        + action('shot', 'camera', 'Capturar quadro', 'tecla S');
    }

    const m = this.menu;
    const from = m.hidden ? 0 : m.offsetHeight;
    const width = m.hidden ? 0 : m.offsetWidth;
    m.innerHTML = `<div class="pm-panel ${dir > 0 ? 'from-right' : dir < 0 ? 'from-left' : ''}">${html}</div>`;
    if (from && dir && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const to = m.offsetHeight;
      const toW = m.offsetWidth;
      m.animate([{ height: `${from}px`, width: `${width}px` }, { height: `${to}px`, width: `${toW}px` }], { duration: 260, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
    }
    if (dir) m.querySelector('.pm-panel button')?.focus({ preventScroll: true });
  }

  mediaSession() {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: this.info.title,
      artist: this.info.channel,
      artwork: [{ src: `https://i.ytimg.com/vi/${this.info.id}/hqdefault.jpg`, sizes: '480x360', type: 'image/jpeg' }],
    });
    const ms = navigator.mediaSession;
    ms.setActionHandler('play', () => this.play());
    ms.setActionHandler('pause', () => this.pause());
    ms.setActionHandler('seekbackward', () => this.seek(this.now - 10));
    ms.setActionHandler('seekforward', () => this.seek(this.now + 10));
    ms.setActionHandler('nexttrack', this.opts.onNext ? () => this.opts.onNext() : null);
    // Barra de tempo do painel de mídia (celular, Windows): arrastar pula; "anterior" volta ao começo.
    try { ms.setActionHandler('seekto', (d) => { if (d.seekTime != null) this.seek(d.seekTime); }); } catch {}
    try { ms.setActionHandler('previoustrack', () => this.seek(0)); } catch {}
    // Chrome pode abrir o miniplayer sozinho quando você troca de aba com o vídeo tocando.
    try { if (PIP_OK) ms.setActionHandler('enterpictureinpicture', () => { if (!this.inPip) this.togglePip(); }); } catch {}
  }

  // Posição e duração para o painel de mídia do sistema (a barra de tempo anda sozinha a partir daqui).
  positionState() {
    if (!('mediaSession' in navigator) || this.live || !navigator.mediaSession.setPositionState) return;
    const duration = this.duration;
    if (!(duration > 0)) return;
    try {
      navigator.mediaSession.setPositionState({ duration, position: Math.min(duration, Math.max(0, this.now)), playbackRate: this.out.playbackRate || 1 });
    } catch {}
  }

  destroy() {
    this.destroyed = true;
    this.opts.onPipClosed = null;
    this.exitPip();
    if (this.watchAcc > 1) this.opts.onTick?.(Math.round(this.watchAcc));
    clearTimeout(this.idleTimer);
    clearInterval(this.sleepTimer);
    this.hls?.destroy();
    if ('mediaSession' in navigator) navigator.mediaSession.metadata = null; // tira os controles de mídia do sistema
    document.removeEventListener('keydown', this.onKey);
    document.removeEventListener('fullscreenchange', this.onFs);
    document.removeEventListener('visibilitychange', this.onVisible);
    removeEventListener('focus', this.onVisible);
    document.removeEventListener('click', this.onDocClick);
    for (const el of [this.v, this.a]) {
      if (!el) continue;
      el.pause();
      el.removeAttribute('src');
      el.load();
      if (el === this.a) el.remove();
    }
  }
}
