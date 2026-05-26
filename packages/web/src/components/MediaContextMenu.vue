<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, markRaw } from 'vue';
import { PhDownloadSimple, PhPlay, PhArrowCounterClockwise, PhEye, PhSpeakerHigh, PhSpeakerLow, PhSpeakerSlash } from '@phosphor-icons/vue';
import { AUDIO_EXTS, playVoiceAt, getVoiceVolume, getVoiceMuted, setVoiceVolume, toggleVoiceMute } from '@/utils/audio';
import { useImagePreview, type PreviewImage } from '@/composables/useImagePreview';

const { open: openImagePreview } = useImagePreview();

type AudioState = 'idle' | 'loading' | 'playing' | 'paused';

interface MenuState {
  visible: boolean;
  x: number;
  y: number;
  kind: 'image' | 'audio';
  url: string;
  filename: string;
  audioEl: HTMLAnchorElement | null;
  audioState: AudioState;
  imgEl: HTMLImageElement | null;
}

const menu = ref<MenuState>({
  visible: false, x: 0, y: 0, kind: 'image', url: '', filename: '',
  audioEl: null, audioState: 'idle', imgEl: null,
});

async function triggerDownload(url: string, name: string) {
  // 用 fetch + blob URL 触发下载(同源安全 + 任何 click handler 都没机会拦截)
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = name;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
  } catch (e) {
    console.error('[MediaContextMenu] download failed:', e);
  }
}

function show(kind: 'image' | 'audio', url: string, filename: string, x: number, y: number,
              audioEl: HTMLAnchorElement | null = null, audioState: AudioState = 'idle',
              imgEl: HTMLImageElement | null = null) {
  // 音频: 顶部音量行 ~40 + 分割线 + 1-2 个播放控制 + 分割线 + 下载 ~ 130-170px; 图片 ~ 90px
  const W = 180;
  const H = kind === 'audio' ? (audioState === 'paused' ? 170 : 130) : 90;
  const vw = window.innerWidth, vh = window.innerHeight;
  if (x + W > vw - 8) x = vw - W - 8;
  if (y + H > vh - 8) y = vh - H - 8;
  menu.value = { visible: true, x, y, kind, url, filename, audioEl, audioState, imgEl };
  // 打开菜单时同步当前音量到 reactive ref, 让 slider 显示对的值
  volumeUi.value = getVoiceVolume();
  mutedUi.value = getVoiceMuted();
}

// 音量 UI 状态 (从 audio.ts global 读, 拖动同步回去)
const volumeUi = ref(1);
const mutedUi = ref(false);
const volumeIcon = computed(() => {
  if (mutedUi.value || volumeUi.value === 0) return markRaw(PhSpeakerSlash);
  if (volumeUi.value > 0.5) return markRaw(PhSpeakerHigh);
  return markRaw(PhSpeakerLow);
});
function onVolumeInput(e: Event) {
  const v = parseFloat((e.target as HTMLInputElement).value);
  setVoiceVolume(v);
  volumeUi.value = v;
  mutedUi.value = v === 0;
}
function onMuteClick() {
  toggleVoiceMute();
  mutedUi.value = getVoiceMuted();
}

function hide() { menu.value.visible = false; }

function doDownload() {
  if (!menu.value.url) return;
  triggerDownload(menu.value.url, menu.value.filename);
  hide();
}

function doPlay() {
  if (!menu.value.audioEl || !menu.value.url) return;
  playVoiceAt(menu.value.audioEl, menu.value.url, false);
  hide();
}

function doRestart() {
  if (!menu.value.audioEl || !menu.value.url) return;
  playVoiceAt(menu.value.audioEl, menu.value.url, true);
  hide();
}

function doPreview() {
  if (!menu.value.imgEl) return;
  const img = menu.value.imgEl;
  // 跟左键点击图片行为一致:收集同 .note-content 内所有图作为一组,可左右切换
  const container = img.closest('.note-content');
  const allImgs = container
    ? Array.from(container.querySelectorAll('img')) as HTMLImageElement[]
    : [img];
  const idx = Math.max(0, allImgs.indexOf(img));
  const images: PreviewImage[] = allImgs.map(i => ({
    url: i.src,
    filename: i.alt || (i.src.split('/').pop() || 'image').split('?')[0],
  }));
  openImagePreview(images, idx);
  hide();
}

function handleContextMenu(e: MouseEvent) {
  hide();
  const target = e.target as HTMLElement;
  const container = target.closest('.note-content');
  if (!container) return;

  // 图片
  if (target.tagName === 'IMG') {
    e.preventDefault();
    const img = target as HTMLImageElement;
    const filename = img.alt || (img.src.split('/').pop() || 'image').split('?')[0];
    show('image', img.src, filename, e.clientX, e.clientY, null, 'idle', img);
    return;
  }

  // 音频 a 标签
  const a = target.closest('a') as HTMLAnchorElement | null;
  if (a) {
    const href = a.getAttribute('href') || '';
    if (AUDIO_EXTS.test(href)) {
      e.preventDefault();
      const filename = (href.split('/').pop() || 'audio').split('?')[0];
      // 从 a.dataset.audioState 读当前播放状态(audio.ts 维护)
      const audioState = ((a.dataset.audioState as AudioState) || 'idle');
      show('audio', href, filename, e.clientX, e.clientY, a, audioState);
      return;
    }
  }
}

function handleDocClick(e: MouseEvent) {
  if (!menu.value.visible) return;
  const inMenu = (e.target as HTMLElement).closest?.('.media-context-menu');
  if (!inMenu) hide();
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && menu.value.visible) hide();
}

// HMR 友好:模块级缓存上次挂的 handler
let prevCtx: ((e: MouseEvent) => void) | null = null;
let prevClick: ((e: MouseEvent) => void) | null = null;
let prevKey: ((e: KeyboardEvent) => void) | null = null;

onMounted(() => {
  if (prevCtx) document.removeEventListener('contextmenu', prevCtx);
  if (prevClick) document.removeEventListener('click', prevClick);
  if (prevKey) document.removeEventListener('keydown', prevKey);
  document.addEventListener('contextmenu', handleContextMenu);
  document.addEventListener('click', handleDocClick);
  document.addEventListener('keydown', handleKeydown);
  window.addEventListener('blur', hide);
  window.addEventListener('resize', hide);
  prevCtx = handleContextMenu;
  prevClick = handleDocClick;
  prevKey = handleKeydown;
});

onUnmounted(() => {
  document.removeEventListener('contextmenu', handleContextMenu);
  document.removeEventListener('click', handleDocClick);
  document.removeEventListener('keydown', handleKeydown);
  window.removeEventListener('blur', hide);
  window.removeEventListener('resize', hide);
});
</script>

<template>
  <Teleport to="body">
    <Transition enter-active-class="transition duration-100 ease-out" enter-from-class="opacity-0 scale-95"
      leave-active-class="transition duration-75 ease-in" leave-to-class="opacity-0 scale-95">
      <div v-if="menu.visible"
        class="media-context-menu fixed z-[400] bg-white rounded-lg shadow-xl border border-gray-200 py-1 min-w-[150px] origin-top-left"
        :style="{ left: menu.x + 'px', top: menu.y + 'px' }">
        <!-- 图片菜单:预览 + 下载 -->
        <template v-if="menu.kind === 'image'">
          <button @click="doPreview"
            class="w-full px-3 py-2 text-sm text-left text-gray-700 hover:bg-gray-100 flex items-center gap-2 transition-colors">
            <PhEye size="1rem" weight="fill" />
            <span>预览图片</span>
          </button>
          <div class="border-t border-gray-100 my-1"></div>
          <button @click="doDownload"
            class="w-full px-3 py-2 text-sm text-left text-gray-700 hover:bg-gray-100 flex items-center gap-2 transition-colors">
            <PhDownloadSimple size="1rem" weight="fill" />
            <span>下载图片</span>
          </button>
        </template>

        <!-- 音频菜单:根据 audioState 动态显示 -->
        <template v-if="menu.kind === 'audio'">
          <!-- 音量行: 顶部内嵌 (喇叭点静音切换 + slider 拖音量); inline 不展开二级 popover, 直接操控 -->
          <div class="px-3 py-2 flex items-center gap-2">
            <button @click.stop="onMuteClick"
              class="text-gray-500 hover:text-gray-700 shrink-0 audio-volume-btn">
              <component :is="volumeIcon" size="1rem" weight="fill" />
            </button>
            <input type="range" min="0" max="1" step="0.05" :value="mutedUi ? 0 : volumeUi" @input="onVolumeInput" @click.stop
              class="audio-volume-slider flex-1"
              :style="{
                background: `linear-gradient(to right, rgb(var(--c-accent)) 0%, rgb(var(--c-accent)) ${(mutedUi ? 0 : volumeUi) * 100}%, rgb(229 231 235) ${(mutedUi ? 0 : volumeUi) * 100}%, rgb(229 231 235) 100%)`,
              }" />
          </div>
          <div class="border-t border-gray-100 my-1"></div>

          <!-- 未播放 idle → 显示 "播放" -->
          <button v-if="menu.audioState === 'idle'" @click="doPlay"
            class="w-full px-3 py-2 text-sm text-left text-gray-700 hover:bg-gray-100 flex items-center gap-2 transition-colors">
            <PhPlay size="1rem" weight="fill" />
            <span>播放</span>
          </button>

          <!-- 暂停 paused → 显示 "继续播放" -->
          <button v-if="menu.audioState === 'paused'" @click="doPlay"
            class="w-full px-3 py-2 text-sm text-left text-gray-700 hover:bg-gray-100 flex items-center gap-2 transition-colors">
            <PhPlay size="1rem" weight="fill" />
            <span>继续播放</span>
          </button>

          <!-- 播放中 playing / 暂停 paused → 都显示 "重新播放" -->
          <button v-if="menu.audioState === 'playing' || menu.audioState === 'paused'" @click="doRestart"
            class="w-full px-3 py-2 text-sm text-left text-gray-700 hover:bg-gray-100 flex items-center gap-2 transition-colors">
            <PhArrowCounterClockwise size="1rem" weight="fill" />
            <span>重新播放</span>
          </button>

          <!-- 下载始终在最尾 -->
          <div class="border-t border-gray-100 my-1"></div>
          <button @click="doDownload"
            class="w-full px-3 py-2 text-sm text-left text-gray-700 hover:bg-gray-100 flex items-center gap-2 transition-colors">
            <PhDownloadSimple size="1rem" weight="fill" />
            <span>下载音频</span>
          </button>
        </template>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.audio-volume-btn,
.audio-volume-btn:focus,
.audio-volume-btn:focus-visible {
  outline: none;
  -webkit-tap-highlight-color: transparent;
}
/* 自定义 range slider (跟 AudioPlayer 同套路, 关 webkit/moz 默认外观让 inline gradient 生效) */
.audio-volume-slider {
  -webkit-appearance: none;
  appearance: none;
  height: 4px;
  border-radius: 9999px;
  outline: none;
  cursor: pointer;
}
.audio-volume-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  background: rgb(var(--c-accent));
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 2px solid white;
  box-shadow: 0 1px 2px rgba(0,0,0,0.15);
  cursor: pointer;
}
.audio-volume-slider::-moz-range-thumb {
  background: rgb(var(--c-accent));
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 2px solid white;
  box-shadow: 0 1px 2px rgba(0,0,0,0.15);
  cursor: pointer;
}
.audio-volume-slider::-moz-range-track {
  background: transparent;
  border: none;
}
</style>
