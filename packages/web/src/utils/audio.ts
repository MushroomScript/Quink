const AUDIO_EXTS = /\.(webm|mp3|wav|ogg|m4a)(\?.*)?$/i;

type AudioState = 'idle' | 'loading' | 'playing' | 'paused';

let currentAudio: HTMLAudioElement | null = null;
let currentEl: HTMLElement | null = null;
let rafId: number | null = null;

function setState(el: HTMLElement, state: AudioState) {
  el.dataset.audioState = state;
  el.classList.toggle('voice-loading', state === 'loading');
  el.classList.toggle('voice-playing', state === 'playing');
  el.classList.toggle('voice-paused', state === 'paused');
}

// rAF 每帧 (~60Hz) 读 currentTime 更新 --progress CSS 变量,比 timeupdate (4Hz) 平滑
function startProgressRaf() {
  function tick() {
    if (!currentAudio || !currentEl || currentAudio.paused || currentAudio.ended) {
      rafId = null;
      return;
    }
    if (isFinite(currentAudio.duration) && currentAudio.duration > 0) {
      const pct = (currentAudio.currentTime / currentAudio.duration) * 100;
      currentEl.style.setProperty('--progress', pct + '%');
    }
    rafId = requestAnimationFrame(tick);
  }
  if (rafId) cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(tick);
}

function stopProgressRaf() {
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
}

function resetProgress(el: HTMLElement) {
  el.style.removeProperty('--progress');
}

function detachCurrent() {
  if (!currentAudio || !currentEl) return;
  currentAudio.pause();
  currentAudio.currentTime = 0;
  stopProgressRaf();
  resetProgress(currentEl);
  setState(currentEl, 'idle');
  currentAudio = null;
  currentEl = null;
}

function bindAudioEvents(audio: HTMLAudioElement, el: HTMLElement) {
  audio.addEventListener('play', () => {
    if (currentEl === el) {
      setState(el, 'playing');
      startProgressRaf();
    }
  });
  audio.addEventListener('pause', () => {
    // ended 也会触发 pause,但 ended 事件单独处理重置进度,这里只处理"用户暂停"
    if (currentEl === el && !audio.ended) {
      setState(el, 'paused');
      stopProgressRaf();
    }
  });
  audio.addEventListener('ended', () => {
    if (currentEl === el) {
      stopProgressRaf();
      resetProgress(el);
      setState(el, 'idle');
      currentAudio = null;
      currentEl = null;
    }
  });
  audio.addEventListener('error', () => {
    if (currentEl === el) {
      stopProgressRaf();
      resetProgress(el);
      setState(el, 'idle');
      currentAudio = null;
      currentEl = null;
    }
  });
}

// 公开 API:供 MediaContextMenu 调用
// restart=true → 从头播;否则:idle 从头开始,paused 从断点继续
export function playVoiceAt(el: HTMLElement, src: string, restart = false) {
  // 别的胶囊在播 → 先停
  if (currentEl && currentEl !== el) detachCurrent();

  if (currentEl === el && currentAudio) {
    if (restart) {
      currentAudio.currentTime = 0;
      resetProgress(el);
    }
    currentAudio.play().catch(() => setState(el, 'idle'));
    return;
  }

  // 新胶囊 → 创建 audio
  const audio = new Audio(src);
  currentAudio = audio;
  currentEl = el;
  setState(el, 'loading');
  bindAudioEvents(audio, el);
  // play() 期间状态保持 loading,canplay 后浏览器自动触发 play 事件 → 切到 playing
  audio.play().catch(() => {
    if (currentEl === el) {
      setState(el, 'idle');
      currentAudio = null;
      currentEl = null;
    }
  });
}

export function pauseVoiceAt(el: HTMLElement) {
  if (currentEl === el && currentAudio && !currentAudio.paused) {
    currentAudio.pause();
  }
}

function togglePlay(el: HTMLElement, src: string) {
  // 同一胶囊
  if (currentEl === el && currentAudio) {
    if (currentAudio.paused) {
      currentAudio.play().catch(() => setState(el, 'idle'));
    } else {
      currentAudio.pause();
    }
    return;
  }
  // 新胶囊
  playVoiceAt(el, src, false);
}

export { AUDIO_EXTS };

// HMR 友好:模块级缓存 listener,重 mount 时先清旧的避免多份 handler 累积
const HMR_KEY = '__quinkAudioClickHandler';
const _w = window as any;

export function initAudioBubbleHandler() {
  if (_w[HMR_KEY]) {
    document.removeEventListener('click', _w[HMR_KEY], true);
  }
  const handler = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    const a = target.closest?.('a') as HTMLAnchorElement | null;
    if (!a) return;
    // 只处理笔记渲染内容里的音频 a 标签(.note-content / Vditor 编辑器预览)
    if (!a.closest('.note-content') && !a.closest('.vditor-reset')) return;
    const href = a.getAttribute('href') || '';
    if (!AUDIO_EXTS.test(href)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    togglePlay(a, href);
  };
  document.addEventListener('click', handler, true);
  _w[HMR_KEY] = handler;
}
