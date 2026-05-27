<script setup lang="ts">
// 紧凑音频播放器: 替代 <audio controls> 在窄卡片里的丑布局.
// 单行: [▶/⏸] 进度条(可点 seek) 时间 [🔊];
// 音量 popover Teleport 到 body, 避免被祖先 overflow-hidden 截断.
import { ref, computed, markRaw } from 'vue';
import { PhPlay, PhPause, PhSpeakerHigh, PhSpeakerLow, PhSpeakerSlash } from '@phosphor-icons/vue';

const props = defineProps<{ src: string; hideBars?: boolean }>();

const audioEl = ref<HTMLAudioElement>();
const volumeBtn = ref<HTMLElement>();
const isPlaying = ref(false);
const duration = ref(0);
const currentTime = ref(0);
const volume = ref(1);
const muted = ref(false);
const showVolumePopover = ref(false);
const volumePopoverPos = ref({ top: '0px', left: '0px' });

function togglePlay() {
  if (!audioEl.value) return;
  if (isPlaying.value) audioEl.value.pause();
  else audioEl.value.play();
}

// 进度条点击 seek: 算点击位置占比 → 设 currentTime
function onSeek(e: MouseEvent) {
  if (!audioEl.value || !duration.value) return;
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  audioEl.value.currentTime = ratio * duration.value;
}

// hover 触发音量 popover (鼠标在按钮 / popover 上保持显示, 离开 150ms 后关闭).
// 用 setTimeout 给 popover 自身留 mouseenter 机会取消, 否则 button → popover 间 8px 间隙会瞬间关闭
let closeTimer: number | null = null;
function onVolumeMouseEnter() {
  if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
  if (showVolumePopover.value) return;
  if (volumeBtn.value) {
    const r = volumeBtn.value.getBoundingClientRect();
    // popover 宽 ~40px (w-10), 高 ~120px (h-28 + p-2 = 112 + 16); 向上弹, 中心对齐按钮中心
    volumePopoverPos.value = {
      top: (r.top - 8 - 120) + 'px',
      left: (r.left + r.width / 2 - 20) + 'px',
    };
  }
  showVolumePopover.value = true;
}
function onVolumeMouseLeave() {
  closeTimer = window.setTimeout(() => {
    showVolumePopover.value = false;
    closeTimer = null;
  }, 150);
}

function onVolumeSliderInput(e: Event) {
  if (!audioEl.value) return;
  const v = parseFloat((e.target as HTMLInputElement).value);
  audioEl.value.volume = v;
  // 拖到 0 自动静音, 拖回来取消静音
  if (v === 0 && !audioEl.value.muted) audioEl.value.muted = true;
  else if (v > 0 && audioEl.value.muted) audioEl.value.muted = false;
}

function toggleMute() {
  if (!audioEl.value) return;
  audioEl.value.muted = !audioEl.value.muted;
}

function fmt(s: number): string {
  if (!isFinite(s) || s < 0) return '00:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

const progressPct = computed(() => (duration.value ? (currentTime.value / duration.value) * 100 : 0));
// 未播过 (currentTime≈0) 显示总时长预览; 播过 / seek 过 / 播放中 都显示当前位置 (让 seek 操作有可见反馈)
const displayTime = computed(() => (currentTime.value < 0.1 ? fmt(duration.value) : fmt(currentTime.value)));
const volumeIcon = computed(() => {
  if (muted.value || volume.value === 0) return markRaw(PhSpeakerSlash);
  if (volume.value > 0.5) return markRaw(PhSpeakerHigh);
  return markRaw(PhSpeakerLow);
});

function syncFromAudio() {
  if (!audioEl.value) return;
  volume.value = audioEl.value.volume;
  muted.value = audioEl.value.muted;
}
</script>

<template>
  <!-- 顶部 visual: 4 条圆角竖线 — 停止时灰色等高静止, 播放时主题色独立节奏跳动 (4 条不同 animation-duration 实现"长短不一").
       hideBars 时跳过 (用于 list view / 紧凑场景, 仅显示单行播放控件不要顶部 visualizer) -->
  <div v-if="!hideBars" class="flex justify-center mb-3 h-7 items-center">
    <div class="audio-bars flex items-center gap-1 h-7" :class="{ playing: isPlaying }">
      <span class="bar"></span>
      <span class="bar"></span>
      <span class="bar"></span>
      <span class="bar"></span>
    </div>
  </div>

  <div class="flex items-center gap-2 w-full bg-white rounded-full border border-gray-200 px-2 py-1">
    <audio ref="audioEl" :src="src" preload="metadata"
      @timeupdate="currentTime = audioEl?.currentTime || 0"
      @durationchange="duration = audioEl?.duration || 0"
      @play="isPlaying = true"
      @pause="isPlaying = false"
      @ended="isPlaying = false; currentTime = 0"
      @volumechange="syncFromAudio" />

    <button @click="togglePlay"
      class="w-6 h-6 flex items-center justify-center rounded-full bg-primary text-white hover:bg-primary-dark shrink-0 transition-colors">
      <PhPlay v-if="!isPlaying" size="0.625rem" weight="fill" style="margin-left: 1px" />
      <PhPause v-else size="0.625rem" weight="fill" />
    </button>

    <div @click="onSeek" class="flex-1 h-1 bg-gray-200 rounded-full cursor-pointer relative min-w-0">
      <div class="absolute left-0 top-0 h-full bg-primary rounded-full transition-[width] duration-100"
        :style="{ width: progressPct + '%' }" />
    </div>

    <span class="text-[10px] text-gray-500 tabular-nums shrink-0">{{ displayTime }}</span>

    <button ref="volumeBtn"
      @click="toggleMute"
      @mouseenter="onVolumeMouseEnter"
      @mouseleave="onVolumeMouseLeave"
      class="audio-volume-btn w-5 h-5 flex items-center justify-center text-gray-400 hover:text-gray-500 shrink-0 transition-colors">
      <component :is="volumeIcon" size="0.875rem" weight="fill" />
    </button>
  </div>

  <!-- 音量 popover: hover 喇叭弹出, 竖向 slider 向上展开. Teleport 到 body 避开卡片 overflow-hidden 截断. -->
  <Teleport to="body">
    <div v-if="showVolumePopover"
      @mouseenter="onVolumeMouseEnter"
      @mouseleave="onVolumeMouseLeave"
      class="fixed z-[9999] bg-white border border-gray-200 rounded-lg shadow-md p-2 w-10"
      :style="volumePopoverPos">
      <!-- 竖向 slider: rotate(-90deg) 把水平 range 转成竖直; track 用 linear-gradient 自定义填充主色 + 未填充浅灰 (-webkit-appearance:none 关掉 chromium 默认黑色 track) -->
      <div class="relative w-6 h-24 flex items-center justify-center">
        <input type="range" min="0" max="1" step="0.05" :value="muted ? 0 : volume" @input="onVolumeSliderInput"
          class="audio-volume-slider"
          :style="{
            transform: 'rotate(-90deg)',
            width: '6rem',
            background: `linear-gradient(to right, rgb(var(--c-accent)) 0%, rgb(var(--c-accent)) ${(muted ? 0 : volume) * 100}%, rgb(229 231 235) ${(muted ? 0 : volume) * 100}%, rgb(229 231 235) 100%)`,
          }" />
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* 喇叭按钮: 去 focus outline (浏览器默认 focus 描边) + tap highlight (移动端按下时一闪深色) */
.audio-volume-btn,
.audio-volume-btn:focus,
.audio-volume-btn:focus-visible {
  outline: none;
  -webkit-tap-highlight-color: transparent;
}

/* 自定义 range slider: 关 webkit/moz 默认外观让 inline gradient background 生效;
   thumb 主题色实心圆 (跨浏览器一致, 不依赖 accent-color 在 chromium 下的默认 track 渲染) */
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

/* Audio bars 顶部 visual:
   - 默认: 4 条 gray-400 等高圆角竖线 (上下两端 border-radius 圆头胶囊形)
   - 播放 (.playing): 切到主题色 + animation 独立节奏跳动 (4 条不同 animation-duration 实现"长短不一")
   - 用 transform: scaleY 而不是 height (不触发 layout, 60fps 平滑) */
.audio-bars .bar {
  display: inline-block;
  width: 4px;
  background: rgb(156 163 175);  /* gray-400 */
  border-radius: 9999px;
  transform-origin: center;
  transition: background 0.2s;
}
/* 静止时 4 条短长短长交替, 已经有"音频"识别度 (跟跳动时各自不同 animation-duration 配合, 整体节奏感更强) */
.audio-bars .bar:nth-child(1) { height: 12px; }
.audio-bars .bar:nth-child(2) { height: 22px; }
.audio-bars .bar:nth-child(3) { height: 12px; }
.audio-bars .bar:nth-child(4) { height: 22px; }
.audio-bars.playing .bar {
  background: rgb(var(--c-accent));
  animation: audio-bar-bounce 0.8s ease-in-out infinite alternate;
}
.audio-bars.playing .bar:nth-child(1) { animation-duration: 0.7s; animation-delay: -0.1s; }
.audio-bars.playing .bar:nth-child(2) { animation-duration: 1.0s; animation-delay: -0.3s; }
.audio-bars.playing .bar:nth-child(3) { animation-duration: 0.6s; animation-delay: -0.5s; }
.audio-bars.playing .bar:nth-child(4) { animation-duration: 0.85s; animation-delay: -0.2s; }
@keyframes audio-bar-bounce {
  0%   { transform: scaleY(0.3); }
  100% { transform: scaleY(1); }
}
</style>
