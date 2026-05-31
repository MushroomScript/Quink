import { useToast } from '@/composables/useToast';

const AUDIO_EXTS = /\.(webm|mp3|wav|ogg|m4a)(\?.*)?$/i;

type AudioState = 'idle' | 'loading' | 'playing' | 'paused';

let currentAudio: HTMLAudioElement | null = null;
let currentEl: HTMLElement | null = null;
let rafId: number | null = null;

// 全局音量 (跨胶囊保留, 新建 audio 时复用; localStorage 持久化, 用户改一次以后都生效)
const VOLUME_KEY = 'quink_voice_volume';
const MUTED_KEY = 'quink_voice_muted';
let globalVolume = (() => {
  const v = parseFloat(localStorage.getItem(VOLUME_KEY) || '1');
  return isFinite(v) && v >= 0 && v <= 1 ? v : 1;
})();
let globalMuted = localStorage.getItem(MUTED_KEY) === '1';

export function getVoiceVolume() { return globalVolume; }
export function getVoiceMuted() { return globalMuted; }

export function setVoiceVolume(v: number) {
  globalVolume = Math.max(0, Math.min(1, v));
  // 拖到 0 = 静音, 从 0 拖回来取消静音
  if (globalVolume === 0) globalMuted = true;
  else if (globalMuted) globalMuted = false;
  localStorage.setItem(VOLUME_KEY, String(globalVolume));
  localStorage.setItem(MUTED_KEY, globalMuted ? '1' : '0');
  if (currentAudio) {
    currentAudio.volume = globalVolume;
    currentAudio.muted = globalMuted;
  }
}

export function toggleVoiceMute() {
  globalMuted = !globalMuted;
  localStorage.setItem(MUTED_KEY, globalMuted ? '1' : '0');
  if (currentAudio) currentAudio.muted = globalMuted;
}

function setState(el: HTMLElement, state: AudioState) {
  el.dataset.audioState = state;
  el.classList.toggle('voice-loading', state === 'loading');
  el.classList.toggle('voice-playing', state === 'playing');
  el.classList.toggle('voice-paused', state === 'paused');
}

// 胶囊 link 文本末尾的"35s" / "1:23" 同步当前播放位置: rAF 期间持续更新, 停止时恢复原始;
// 备份原文本到 dataset.originalLabel, restore 时取回 (避免污染 markdown 源)
function formatSeconds(s: number): string {
  if (!isFinite(s) || s < 0) return '0s';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return m === 0 ? `${sec}s` : `${m}:${String(sec).padStart(2, '0')}`;
}
function updateLinkLabel(el: HTMLElement, currentTime: number) {
  if (!el.dataset.originalLabel) el.dataset.originalLabel = el.textContent || '';
  const original = el.dataset.originalLabel;
  // 替换末尾 " Xs" 或 " M:SS" 段; 如果原文本没匹配的尾巴 (用户自定义 label) 就追加
  if (/\s+(\d+s|\d+:\d{2})\s*$/.test(original)) {
    el.textContent = original.replace(/\s+(\d+s|\d+:\d{2})\s*$/, ' ' + formatSeconds(currentTime));
  } else {
    el.textContent = original + ' ' + formatSeconds(currentTime);
  }
}
function restoreLinkLabel(el: HTMLElement) {
  if (el.dataset.originalLabel) {
    el.textContent = el.dataset.originalLabel;
    delete el.dataset.originalLabel;
  }
}

// rAF 每帧 (~60Hz) 读 currentTime 更新 --progress CSS 变量 + link 文本秒数, 比 timeupdate (4Hz) 平滑
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
    updateLinkLabel(currentEl, currentAudio.currentTime);
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
  restoreLinkLabel(currentEl);
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
      // 暂停时定格当前时间 (rAF 已停, 主动更新一次)
      updateLinkLabel(el, audio.currentTime);
    }
  });
  audio.addEventListener('ended', () => {
    if (currentEl === el) {
      stopProgressRaf();
      resetProgress(el);
      restoreLinkLabel(el);
      setState(el, 'idle');
      currentAudio = null;
      currentEl = null;
    }
  });
  audio.addEventListener('error', () => {
    if (currentEl === el) {
      stopProgressRaf();
      resetProgress(el);
      restoreLinkLabel(el);
      setState(el, 'idle');
      currentAudio = null;
      currentEl = null;
    }
    // audio.error 最常见原因 = 源 404 (后端文件被删). 网络/解码失败极少 (本地后端).
    // 用户视角统一"录音文件不存在", 比"加载失败"明确
    useToast().show('录音文件不存在', 'error', 2500);
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

  // 新胶囊 → 创建 audio (复用 global volume / muted, 让多个胶囊间音量一致)
  const audio = new Audio(src);
  audio.volume = globalVolume;
  audio.muted = globalMuted;
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

// ── 拖动 seek (mousedown → 累积 mousemove 超阈值 → mouseup 时按位置 seek; 距离 < 阈值 = 单击 = togglePlay) ──
const DRAG_THRESHOLD = 4;
let dragStart: { el: HTMLAnchorElement; startX: number; src: string; rect: DOMRect } | null = null;
let dragging = false;
let wasDragging = false;  // mouseup 后短暂置 true, 让冒泡的 click 跳过 togglePlay

function findAudioAnchor(target: EventTarget | null): HTMLAnchorElement | null {
  const el = target as HTMLElement | null;
  if (!el || !el.closest) return null;
  const a = el.closest('a') as HTMLAnchorElement | null;
  if (!a) return null;
  if (!a.closest('.note-content') && !a.closest('.vditor-reset')) return null;
  const href = a.getAttribute('href') || '';
  return AUDIO_EXTS.test(href) ? a : null;
}

function onPointerDown(e: PointerEvent) {
  if (e.button !== 0) return;
  const a = findAudioAnchor(e.target);
  if (!a) return;
  dragStart = { el: a, startX: e.clientX, src: a.getAttribute('href') || '', rect: a.getBoundingClientRect() };
  dragging = false;
}

function onPointerMove(e: PointerEvent) {
  if (!dragStart) return;
  if (!dragging && Math.abs(e.clientX - dragStart.startX) >= DRAG_THRESHOLD) {
    dragging = true;
  }
  if (!dragging) return;
  const ratio = Math.max(0, Math.min(1, (e.clientX - dragStart.rect.left) / dragStart.rect.width));
  // 实时反馈: 当前 audio 还在播/暂停 → 直接设 currentTime (CSS --progress 由 rAF 自动跟); 暂停时 rAF 不在跑, 主动同步 progress + label
  if (currentEl === dragStart.el && currentAudio && isFinite(currentAudio.duration) && currentAudio.duration > 0) {
    const t = ratio * currentAudio.duration;
    currentAudio.currentTime = t;
    dragStart.el.style.setProperty('--progress', (ratio * 100) + '%');
    if (currentAudio.paused) updateLinkLabel(dragStart.el, t);
  } else {
    // idle 胶囊拖动预览: 临时加 voice-paused class 让 CSS 渐变 background 生效
    dragStart.el.style.setProperty('--progress', (ratio * 100) + '%');
    if (!dragStart.el.classList.contains('voice-playing') && !dragStart.el.classList.contains('voice-paused')) {
      dragStart.el.classList.add('voice-paused');
      dragStart.el.dataset.audioState = 'paused';
      dragStart.el.dataset.dragPreview = '1';
    }
  }
}

function clearDragPreview(el: HTMLAnchorElement) {
  if (el.dataset.dragPreview === '1') {
    el.classList.remove('voice-paused');
    el.style.removeProperty('--progress');
    delete el.dataset.audioState;
    delete el.dataset.dragPreview;
  }
}

function onPointerUp(e: PointerEvent) {
  if (!dragStart) { dragging = false; return; }
  const { el, src, rect } = dragStart;
  if (dragging) {
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    if (currentEl === el && currentAudio && isFinite(currentAudio.duration) && currentAudio.duration > 0) {
      const t = ratio * currentAudio.duration;
      currentAudio.currentTime = t;
      // paused 状态拖 seek 后保持 paused (不调 play()); 同步 label 定格当前秒数
      if (currentAudio.paused) updateLinkLabel(el, t);
    } else {
      clearDragPreview(el);  // 真正 load 前清掉预览, seekAndLoad 重新走标准状态机 (loading → paused)
      seekAndLoad(el, src, ratio);
    }
    wasDragging = true;
    // click 在 pointerup 后才 fire; 窗口给足 (鼠标动作慢时 click 来得晚), 避免拖完触发 togglePlay 让暂停胶囊变成播放
    setTimeout(() => { wasDragging = false; }, 400);
  } else {
    // 没拖动 = 单击, 清掉残留 preview (一般没有, 但保险)
    clearDragPreview(el);
  }
  dragStart = null;
  dragging = false;
}

// 拖动 idle 胶囊后释放: 创建 audio + 等 metadata ready 设 currentTime + 进入 paused 状态 (不 auto play);
// 用户想播再点胶囊触发 togglePlay (currentAudio.paused=true → play())
function seekAndLoad(el: HTMLAnchorElement, src: string, ratio: number) {
  if (currentEl && currentEl !== el) detachCurrent();
  const audio = new Audio(src);
  audio.volume = globalVolume;
  audio.muted = globalMuted;
  audio.preload = 'metadata';
  currentAudio = audio;
  currentEl = el;
  setState(el, 'loading');
  bindAudioEvents(audio, el);
  audio.addEventListener('loadedmetadata', () => {
    if (currentEl === el && audio.duration) {
      audio.currentTime = ratio * audio.duration;
      el.style.setProperty('--progress', (ratio * 100) + '%');
      setState(el, 'paused');  // 显示进度条 + label 秒数, 等用户单击才 play
      updateLinkLabel(el, audio.currentTime);
    }
  }, { once: true });
}

// HMR 友好:模块级缓存 listener,重 mount 时先清旧的避免多份 handler 累积
const HMR_KEY = '__quinkAudioClickHandler';
const HMR_PD_KEY = '__quinkAudioPointerDownHandler';
const HMR_PM_KEY = '__quinkAudioPointerMoveHandler';
const HMR_PU_KEY = '__quinkAudioPointerUpHandler';
const _w = window as any;

export function initAudioBubbleHandler() {
  if (_w[HMR_KEY]) document.removeEventListener('click', _w[HMR_KEY], true);
  if (_w[HMR_PD_KEY]) document.removeEventListener('pointerdown', _w[HMR_PD_KEY], true);
  if (_w[HMR_PM_KEY]) document.removeEventListener('pointermove', _w[HMR_PM_KEY], true);
  if (_w[HMR_PU_KEY]) document.removeEventListener('pointerup', _w[HMR_PU_KEY], true);

  const clickHandler = (e: MouseEvent) => {
    const a = findAudioAnchor(e.target);
    if (!a) return;
    if (wasDragging) {
      // 刚拖完, 浏览器仍可能 fire click → 阻止 togglePlay
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
    const href = a.getAttribute('href') || '';
    togglePlay(a, href);
  };

  document.addEventListener('click', clickHandler, true);
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('pointermove', onPointerMove, true);
  document.addEventListener('pointerup', onPointerUp, true);

  _w[HMR_KEY] = clickHandler;
  _w[HMR_PD_KEY] = onPointerDown;
  _w[HMR_PM_KEY] = onPointerMove;
  _w[HMR_PU_KEY] = onPointerUp;
}
