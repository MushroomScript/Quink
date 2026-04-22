const AUDIO_EXTS = /\.(webm|mp3|wav|ogg|m4a)(\?.*)?$/i;

let currentAudio: HTMLAudioElement | null = null;
let currentEl: HTMLElement | null = null;

function togglePlay(el: HTMLElement, src: string) {
  if (currentEl === el && currentAudio && !currentAudio.paused) {
    currentAudio.pause();
    currentAudio.currentTime = 0;
    el.classList.remove('voice-playing');
    currentAudio = null;
    currentEl = null;
    return;
  }

  if (currentAudio) {
    currentAudio.pause();
    currentAudio.currentTime = 0;
    currentEl?.classList.remove('voice-playing');
  }

  const audio = new Audio(src);
  currentAudio = audio;
  currentEl = el;
  el.classList.add('voice-playing');

  audio.addEventListener('ended', () => {
    el.classList.remove('voice-playing');
    currentAudio = null;
    currentEl = null;
  });
  audio.addEventListener('error', () => {
    el.classList.remove('voice-playing');
    currentAudio = null;
    currentEl = null;
  });
  audio.play().catch(() => {
    el.classList.remove('voice-playing');
  });
}

export function initAudioBubbleHandler() {
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;

    const a = target.closest?.('a') as HTMLAnchorElement | null;
    if (a) {
      const href = a.getAttribute('href') || '';
      if (AUDIO_EXTS.test(href)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        togglePlay(a, href);
        return;
      }
    }
  }, true);
}
