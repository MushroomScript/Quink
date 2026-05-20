<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick, markRaw } from 'vue';
import Vditor from 'vditor';
import 'vditor/dist/index.css';
import { api } from '@/api';
import {
  PhLightbulb,
  PhNotePencil,
  PhCheckSquare,
  PhSparkle,
  PhBookOpen,
  PhPenNib,
  PhTag,
  PhPushPin,
  PhMicrophone,
  PhWaveform,
  PhRecord,
  PhArrowsOut,
  PhArrowsIn,
} from '@phosphor-icons/vue';

const props = withDefaults(defineProps<{
  initialContent?: string;
  initialType?: string;
  initialTags?: string[];
  initialFullscreen?: boolean;
  placeholder?: string;
  showTypeSelector?: boolean;
  submitLabel?: string;
  zIndex?: number;
  minHeight?: number;
  maxHeight?: number;
  showAi?: boolean;
  showFullscreenBtn?: boolean;
  hintText?: string;
}>(), {
  initialContent: '',
  initialType: 'note',
  initialTags: () => [],
  initialFullscreen: false,
  placeholder: '写下你的想法...',
  showTypeSelector: true,
  submitLabel: '保存',
  showAi: true,
  zIndex: 50,
  minHeight: 120,
  maxHeight: 320,
  showFullscreenBtn: true,
  hintText: '',
});

const isFullscreen = ref(props.initialFullscreen);
function toggleFullscreen() { isFullscreen.value = !isFullscreen.value; }

const emit = defineEmits<{
  (e: 'submit', data: { html: string; type: string; tags: string[] }): void;
  (e: 'ready'): void;
}>();

const noteTypes = [
  { value: 'note', label: '灵感', icon: markRaw(PhLightbulb), iconStyle: '' },
  { value: 'snippet', label: '笔记', icon: markRaw(PhNotePencil), iconStyle: '' },
  { value: 'todo', label: '待办', icon: markRaw(PhCheckSquare), iconStyle: '' },
];

const noteType = ref(props.initialType);
const tags = ref<string[]>([...props.initialTags]);
const showTagInput = ref(false);
const tagInput = ref('');
const showRefSearch = ref(false);
const refQuery = ref('');
const refResults = ref<any[]>([]);
const refBtnEl = ref<HTMLElement>();
const liveTextEl = ref<HTMLElement>();
const tagBtnEl = ref<HTMLElement>();

function getPopupPos(el: HTMLElement | undefined, width: number) {
  if (!el) return { display: 'none' };
  const r = el.getBoundingClientRect();
  const maxH = Math.max(r.top - 8, 100);
  return {
    position: 'fixed' as const,
    bottom: `${window.innerHeight - r.top + 4}px`,
    left: `${Math.max(r.right - width, 8)}px`,
    zIndex: 9999,
    maxHeight: `${maxH}px`,
    display: 'flex',
    flexDirection: 'column' as const,
  };
}

// AI panel
const showAiPanel = ref(false);
const aiFeature = ref<'polish' | 'expand' | 'write'>('polish');
const aiPromptText = ref('');
const aiProcessing = ref(false);
const aiResult = ref('');
const aiError = ref('');

// 三个图标都比文字基线整体下移 1px（蘑菇视觉偏好），并按各自重心偏差再细调对齐：
// PhBookOpen 顶部空白 -1，PhPenNib 重心偏上 +1，PhSparkle 居中为 0
const aiFeatureOptions = [
  { value: 'polish' as const, label: '润色', icon: markRaw(PhSparkle), iconStyle: 'margin-top: 1px' },
  { value: 'expand' as const, label: '扩充', icon: markRaw(PhBookOpen), iconStyle: 'margin-top: 0px' },
  { value: 'write' as const, label: '写文', icon: markRaw(PhPenNib), iconStyle: 'margin-top: 2px' },
];

const currentAiFeatureIcon = computed(() =>
  aiFeatureOptions.find(f => f.value === aiFeature.value)?.icon
);

const editorRef = ref<HTMLDivElement>();
let vditor: Vditor | null = null;
const dirty = ref(false);

onMounted(() => {
  if (!editorRef.value) return;

  vditor = new Vditor(editorRef.value, {
    value: props.initialContent,
    placeholder: props.placeholder,
    minHeight: props.minHeight,
    width: '100%',
    mode: 'ir',
    cdn: '/vditor',
    toolbar: [
      'emoji', 'headings', 'bold', 'italic', 'strike', 'link', '|',
      'list', 'ordered-list', 'check', 'quote', '|',
      'code', 'inline-code', 'table', 'line', '|',
      'upload', 'undo', 'redo',
    ],
    toolbarConfig: { pin: false },
    counter: { enable: false },
    preview: { actions: [] },
    cache: { enable: false },
    upload: {
      url: '/api/upload/file',
      fieldName: 'file',
      headers: { Authorization: `Bearer ${localStorage.getItem('quink_token') || ''}` },
      format(files: File[], responseText: string) {
        try {
          const res = JSON.parse(responseText);
          if (res.data?.url) {
            const file = files[0];
            if (file.type.startsWith('image/')) {
              return JSON.stringify({ msg: '', code: 0, data: { errFiles: [], succMap: { [file.name]: res.data.url } } });
            }
            // Non-image: insert as link
            vditor?.insertValue(`[📎 ${file.name}](${res.data.url})`);
            return JSON.stringify({ msg: '', code: 0, data: { errFiles: [], succMap: {} } });
          }
        } catch {}
        return responseText;
      },
    },
    after: () => {
      vditor?.focus();
      setupAudioButtons();
      emit('ready');
    },
    input: () => {
      dirty.value = true;
      requestAnimationFrame(setupAudioButtons);
    },
  });
});

onBeforeUnmount(() => {
  vditor?.destroy();
  vditor = null;
});

// ── 编辑器内音频链接：插入播放按钮 ──
let editorAudio: HTMLAudioElement | null = null;
let editorPlayingBtn: HTMLElement | null = null;

function setupAudioButtons() {
  if (!editorRef.value) return;
  const links = editorRef.value.querySelectorAll<HTMLElement>('span.vditor-ir__marker--link, a[href]');
  links.forEach(el => {
    let href = '';
    if (el.tagName === 'A') {
      href = el.getAttribute('href') || '';
    } else {
      href = el.textContent || '';
    }
    if (!/\.(webm|mp3|wav|ogg|m4a)$/i.test(href)) return;

    const parent = el.closest('.vditor-ir__node') || el.parentElement;
    if (!parent || parent.querySelector('.voice-play-btn')) return;

    const btn = document.createElement('span');
    btn.className = 'voice-play-btn';
    btn.contentEditable = 'false';
    btn.setAttribute('data-src', href);
    btn.innerHTML = '▶';
    btn.title = '播放语音';
    (parent as HTMLElement).style.position = 'relative';
    parent.appendChild(btn);

    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      const src = btn.getAttribute('data-src') || '';
      if (!src) return;

      if (editorPlayingBtn === btn && editorAudio && !editorAudio.paused) {
        editorAudio.pause();
        editorAudio.currentTime = 0;
        btn.innerHTML = '▶';
        btn.classList.remove('voice-play-btn--playing');
        editorAudio = null;
        editorPlayingBtn = null;
        return;
      }

      if (editorAudio) {
        editorAudio.pause();
        editorAudio.currentTime = 0;
        if (editorPlayingBtn) {
          editorPlayingBtn.innerHTML = '▶';
          editorPlayingBtn.classList.remove('voice-play-btn--playing');
        }
      }

      const audio = new Audio(src);
      editorAudio = audio;
      editorPlayingBtn = btn;
      btn.innerHTML = '⏸';
      btn.classList.add('voice-play-btn--playing');

      audio.addEventListener('ended', () => {
        btn.innerHTML = '▶';
        btn.classList.remove('voice-play-btn--playing');
        editorAudio = null;
        editorPlayingBtn = null;
      });
      audio.play().catch(() => {
        btn.innerHTML = '▶';
        btn.classList.remove('voice-play-btn--playing');
      });
    });
  });
}

// ── Tab key to switch type ──
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && isFullscreen.value) {
    e.preventDefault();
    e.stopPropagation();
    isFullscreen.value = false;
    return;
  }
  if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    const idx = noteTypes.findIndex(t => t.value === noteType.value);
    noteType.value = noteTypes[(idx + 1) % noteTypes.length].value;
    return;
  }
  if (e.ctrlKey && e.key === 'Enter') {
    e.preventDefault();
    handleSubmit();
  }
}

function handleSubmit() {
  if (!vditor) return;
  const md = vditor.getValue().trim();
  if (!md) return;

  emit('submit', { html: md, type: noteType.value, tags: [...tags.value] });
  dirty.value = false;
}

function clearContent() {
  vditor?.setValue('');
  tags.value = [];
  noteType.value = props.initialType;
  dirty.value = false;
}

// ── Tags ──
function addTag() {
  const t = tagInput.value.trim();
  if (t && !tags.value.includes(t)) tags.value.push(t);
  tagInput.value = '';
  showTagInput.value = false;
}
function removeTag(tag: string) { tags.value = tags.value.filter(t => t !== tag); }

// ── Reference ──
async function searchRefs() {
  if (!refQuery.value.trim()) { refResults.value = []; return; }
  try { const r = await api.getNotes({ search: refQuery.value, limit: '20' }); refResults.value = r.data; } catch { refResults.value = []; }
}
function insertRef(note: any) {
  const firstLine = (note.content || '').split('\n').find((l: string) => l.trim()) || '';
  const label = firstLine.replace(/[#*`\[\]!>~]/g, '').trim().slice(0, 20) || '引用笔记';
  vditor?.insertValue(`[${label}](/?ref=${note.id})`);
  showRefSearch.value = false; refQuery.value = ''; refResults.value = [];
}

// ── AI ──
async function openAiPanel(feature: 'polish' | 'expand' | 'write') {
  aiFeature.value = feature;
  aiResult.value = '';
  aiError.value = '';
  try {
    const res = await api.getAiPrompts();
    aiPromptText.value = res.data[feature]?.prompt || '';
  } catch { aiPromptText.value = ''; }
  showAiPanel.value = true;
}

async function runAi() {
  if (!vditor || aiProcessing.value) return;
  aiProcessing.value = true;
  aiError.value = '';
  aiResult.value = '';

  const selection = vditor.getSelection();
  const content = selection || vditor.getValue();

  try {
    const res = await api.aiProcess(aiFeature.value, content, aiPromptText.value);
    aiResult.value = res.data.result;
  } catch (err: any) {
    aiError.value = err.message || 'AI 处理失败';
  } finally { aiProcessing.value = false; }
}

function applyAiResult() {
  if (!vditor || !aiResult.value) return;
  const selection = vditor.getSelection();
  if (selection) {
    // Replace selection — Vditor doesn't have replaceSelection, insert after clearing
    document.execCommand('insertText', false, aiResult.value);
  } else {
    vditor.setValue(aiResult.value);
  }
  showAiPanel.value = false;
  aiResult.value = '';
}

function closeAiPanel() { showAiPanel.value = false; }
function closePopups() { showTagInput.value = false; showRefSearch.value = false; }

// ── 录音(讯飞流式语音听写) ──
const isRecording = ref(false);
const recordingTime = ref(0);
let recordTimer: ReturnType<typeof setInterval> | null = null;
let audioContext: AudioContext | null = null;
let mediaStream: MediaStream | null = null;
let iatWs: WebSocket | null = null;
let scriptNode: ScriptProcessorNode | null = null;
let iatResultText = '';
const iatLiveText = ref('');

async function toggleRecording() {
  if (isRecording.value) {
    stopRecording();
  } else {
    startRecording();
  }
}

async function startRecording() {
  try {
    const res = await api.getIatUrl();
    const { url, appId } = res.data;

    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: { sampleRate: 16000, channelCount: 1 } });
    audioContext = new AudioContext({ sampleRate: 16000 });
    const source = audioContext.createMediaStreamSource(mediaStream);
    scriptNode = audioContext.createScriptProcessor(4096, 1, 1);

    iatWs = new WebSocket(url);
    iatResultText = '';
    iatLiveText.value = '';
    isFinishing = false;
    let frameIndex = 0;
    const resultMap = new Map<number, string>();

    iatWs.onopen = () => {
      isRecording.value = true;
      recordingTime.value = 0;
      recordTimer = setInterval(() => { recordingTime.value++; }, 1000);
    };

    iatWs.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.code !== 0) { console.error('[讯飞] error:', msg.message); return; }
        if (msg.data?.result) {
          const r = msg.data.result;
          const sn = r.sn;
          const pgs = r.pgs;
          const text = r.ws?.map((w: any) => w.cw.map((c: any) => c.w).join('')).join('') || '';
          // dwa=wpgs 模式：pgs='rpl' 时先删除 rg 范围内的旧片段再覆盖
          if (pgs === 'rpl' && r.rg) {
            for (let i = r.rg[0]; i <= r.rg[1]; i++) resultMap.delete(i);
          }
          resultMap.set(sn, text);
          const sorted = [...resultMap.entries()].sort((a, b) => a[0] - b[0]);
          iatResultText = sorted.map(([, t]) => t).join('');
          iatLiveText.value = iatResultText;
          nextTick(() => { if (liveTextEl.value) liveTextEl.value.scrollLeft = liveTextEl.value.scrollWidth; });
        }
        if (msg.data?.status === 2) {
          finishRecording();
        }
      } catch {}
    };

    iatWs.onerror = () => { finishRecording(); };
    iatWs.onclose = () => {};

    scriptNode.onaudioprocess = (e) => {
      if (!iatWs || iatWs.readyState !== WebSocket.OPEN) return;
      const pcm = e.inputBuffer.getChannelData(0);
      const int16 = new Int16Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) {
        int16[i] = Math.max(-1, Math.min(1, pcm[i])) * 0x7FFF;
      }
      const bytes = new Uint8Array(int16.buffer);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      const base64 = btoa(binary);

      const frame: any = {
        data: { status: frameIndex === 0 ? 0 : 1, format: 'audio/L16;rate=16000', encoding: 'raw', audio: base64 },
      };
      if (frameIndex === 0) {
        frame.common = { app_id: appId };
        frame.business = { language: 'zh_cn', domain: 'iat', accent: 'mandarin', ptt: 1, vad_eos: 10000, dwa: 'wpgs' };
      }
      iatWs.send(JSON.stringify(frame));
      frameIndex++;
    };

    source.connect(scriptNode);
    scriptNode.connect(audioContext.destination);
  } catch (e: any) {
    console.error('[录音] 启动失败:', e.message);
    stopRecording();
  }
}

let isFinishing = false;

function finishRecording() {
  if (isFinishing) return;
  isFinishing = true;
  const text = iatResultText.trim();
  iatResultText = '';
  iatLiveText.value = '';
  cleanupRecording();
  if (text && vditor) {
    vditor.focus();
    setTimeout(() => { vditor?.insertValue(text); }, 80);
  }
}

function stopRecording() {
  if (iatWs && iatWs.readyState === WebSocket.OPEN) {
    iatWs.send(JSON.stringify({ data: { status: 2, format: 'audio/L16;rate=16000', encoding: 'raw', audio: '' } }));
  }
  // 等讯飞返回最终结果(500ms),然后 finishRecording
  setTimeout(() => {
    if (isRecording.value) finishRecording();
  }, 1000);
}

function cleanupRecording() {
  if (scriptNode) { scriptNode.disconnect(); scriptNode = null; }
  if (audioContext) { audioContext.close().catch(() => {}); audioContext = null; }
  if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
  if (iatWs) { try { iatWs.close(); } catch {} iatWs = null; }
  isRecording.value = false;
  if (recordTimer) { clearInterval(recordTimer); recordTimer = null; }
}

// ── 录音保存(语音备忘) ──
const isVoiceRecording = ref(false);
const voiceRecordTime = ref(0);
let voiceRecordTimer: ReturnType<typeof setInterval> | null = null;
let mediaRecorder: MediaRecorder | null = null;
let voiceChunks: Blob[] = [];
let voiceStream: MediaStream | null = null;
const voiceUploading = ref(false);

async function toggleVoiceRecord() {
  if (isVoiceRecording.value) {
    stopVoiceRecord();
  } else {
    startVoiceRecord();
  }
}

async function startVoiceRecord() {
  try {
    voiceStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(voiceStream, { mimeType: 'audio/webm;codecs=opus' });
    voiceChunks = [];

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) voiceChunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      const dur = voiceRecordTime.value;
      cleanupVoiceRecord();
      if (!voiceChunks.length) return;

      const blob = new Blob(voiceChunks, { type: 'audio/webm' });
      voiceChunks = [];
      voiceUploading.value = true;
      try {
        const file = new File([blob], `voice-${Date.now()}.webm`, { type: 'audio/webm' });
        const res = await api.uploadFile(file, 'file');
        if (res.data?.url && vditor) {
          vditor.focus();
          setTimeout(() => {
            vditor?.insertValue(`[语音备忘 ${dur}s](${res.data.url})`);
          }, 80);
          // 自动转写（如果开启）
          try {
            const me = await api.getMe();
            const prefs = me.data?.preferences || {};
            if (prefs.autoTranscribeVoice) {
              api.transcribeAsync(res.data.url).catch(() => {});
            }
          } catch {}
        }
      } catch (err: any) {
        console.error('[录音保存] 上传失败:', err.message);
      } finally {
        voiceUploading.value = false;
      }
    };

    mediaRecorder.start(1000);
    isVoiceRecording.value = true;
    voiceRecordTime.value = 0;
    voiceRecordTimer = setInterval(() => { voiceRecordTime.value++; }, 1000);
  } catch (e: any) {
    console.error('[录音保存] 启动失败:', e.message);
  }
}

function stopVoiceRecord() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
}

function cleanupVoiceRecord() {
  if (voiceStream) { voiceStream.getTracks().forEach(t => t.stop()); voiceStream = null; }
  mediaRecorder = null;
  isVoiceRecording.value = false;
  if (voiceRecordTimer) { clearInterval(voiceRecordTimer); voiceRecordTimer = null; }
}

defineExpose({ clearContent, isDirty: computed(() => dirty.value) });
</script>

<template>
  <div @keydown="onKeydown"
    :data-fullscreen="isFullscreen || undefined"
    :class="isFullscreen
      ? 'fixed inset-0 z-[200] bg-white flex flex-col'
      : 'flex flex-col'">
    <!-- Vditor editor -->
    <!-- minHeight 占位：Vditor 异步加载完前 wrapper 是空 div，会让下面工具栏贴到顶部，
         给一个等于 Vditor 加载完预期高度的占位（工具栏 ~36px + content minHeight）避免布局跳变 -->
    <div ref="editorRef" class="vditor-wrapper"
      :style="isFullscreen ? { flex: '1 1 auto', minHeight: 0 } : { '--editor-max': maxHeight + 'px', minHeight: (minHeight + 36) + 'px' }"></div>

    <!-- 语音识别实时预览 -->
    <div v-if="isRecording || iatLiveText" class="flex items-center gap-2 px-3 py-1.5" style="background: rgba(var(--c-accent), 0.06)">
      <span class="w-1.5 h-1.5 rounded-full animate-pulse shrink-0" style="background: rgb(var(--c-accent))"></span>
      <span ref="liveTextEl" class="text-sm flex-1 min-w-0 overflow-x-auto whitespace-nowrap scrollbar-hide" style="color: rgb(var(--c-accent-dark))">{{ iatLiveText || '正在聆听...' }}</span>
    </div>

    <!-- AI buttons + bottom bar -->
    <div class="flex items-center justify-between px-3 py-2 bg-gray-50 border-t border-gray-100 select-none">
      <div class="flex items-center gap-2">
        <!-- Type selector -->
        <div v-if="showTypeSelector" class="flex gap-0.5">
          <button v-for="t in noteTypes" :key="t.value" @click="noteType = t.value"
            class="px-2 py-1 rounded-md text-xs transition-colors inline-flex items-center gap-1"
            :class="noteType === t.value ? 'bg-primary-light text-primary-dark font-medium' : 'text-gray-400 hover:bg-gray-100 hover:text-gray-600'">
            <component :is="t.icon" size="0.875rem" weight="fill" :style="t.iconStyle" />
            {{ t.label }}
          </button>
        </div>
        <span v-if="showTypeSelector" class="sep"></span>

        <!-- AI buttons with labels -->
        <template v-if="showAi">
          <div class="flex gap-0.5">
            <button v-for="f in aiFeatureOptions" :key="f.value"
              @click="aiFeature === f.value && showAiPanel ? closeAiPanel() : openAiPanel(f.value)"
              class="px-2 py-1 rounded-md text-xs transition-colors inline-flex items-center gap-1"
              :class="showAiPanel && aiFeature === f.value ? 'bg-primary-light text-primary-dark font-medium' : 'text-gray-400 hover:bg-gray-100 hover:text-gray-600'">
              <component :is="f.icon" size="0.875rem" weight="fill" :style="f.iconStyle" />
              {{ f.label }}
            </button>
          </div>
          <span class="sep"></span>
        </template>

        <!-- Tags -->
        <div class="relative">
          <button ref="tagBtnEl" @click.stop="showTagInput = !showTagInput" class="tbtn text-gray-400" title="添加标签"><PhTag size="0.875rem" weight="fill" /></button>
        </div>
        <!-- Reference -->
        <div class="relative">
          <button ref="refBtnEl" @click.stop="showRefSearch = !showRefSearch" class="tbtn text-gray-400" title="引用笔记"><PhPushPin size="0.875rem" weight="fill" /></button>
        </div>
        <!-- 录音 -->
        <button @click="toggleRecording"
          class="tbtn transition-colors"
          :class="isRecording ? 'text-red-500 bg-red-100 rounded-md' : 'text-gray-400'"
          :title="isRecording ? '' : '语音输入'">
          <PhRecord v-if="isRecording" size="0.875rem" weight="fill" class="text-red-500" />
          <PhMicrophone v-else size="0.875rem" weight="fill" />
        </button>
        <span v-if="isRecording" class="text-[11px] text-red-500 font-medium tabular-nums select-none">
          {{ recordingTime }}s
        </span>
        <!-- 录音保存 -->
        <button @click="toggleVoiceRecord" :disabled="voiceUploading || isRecording"
          class="tbtn transition-colors"
          :class="isVoiceRecording ? 'rounded-md' : voiceUploading ? 'text-gray-300' : 'text-gray-400'"
          :style="isVoiceRecording ? 'color: white; background: rgb(var(--c-accent))' : ''"
          :title="isVoiceRecording ? '' : voiceUploading ? '上传中...' : '录音保存'">
          <PhRecord v-if="isVoiceRecording" size="0.875rem" weight="fill" class="text-white" />
          <PhWaveform v-else-if="voiceUploading" size="0.875rem" weight="fill" class="animate-pulse" />
          <PhWaveform v-else size="0.875rem" weight="fill" />
        </button>
        <span v-if="isVoiceRecording" class="text-[11px] font-medium tabular-nums select-none" style="color: rgb(var(--c-accent))">
          {{ voiceRecordTime }}s
        </span>
      </div>

      <!-- Submit + fullscreen -->
      <div class="flex items-center gap-1.5">
        <span v-if="hintText" class="text-[11px] text-gray-400 mr-1">{{ hintText }}</span>
        <button v-if="showFullscreenBtn" @click="toggleFullscreen"
          class="p-1.5 rounded-md text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
          :title="isFullscreen ? '退出全屏 (Esc)' : '全屏编辑'">
          <PhArrowsOut v-if="!isFullscreen" size="0.875rem" weight="fill" />
          <PhArrowsIn v-else size="0.875rem" weight="fill" />
        </button>
        <slot name="submit-button">
          <button @click="handleSubmit"
            class="px-4 py-1.5 bg-primary text-white text-xs font-medium rounded-lg hover:bg-primary-dark disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
            {{ submitLabel }}
          </button>
        </slot>
      </div>
    </div>

    <!-- AI Panel -->
    <div v-if="showAi && showAiPanel" class="border-t border-gray-100 bg-gray-50/80">
      <div class="flex items-center px-3 pt-2">
        <span class="text-xs font-medium text-gray-500 inline-flex items-center gap-1">
          <component :is="currentAiFeatureIcon" size="0.875rem" weight="fill" />
          {{ aiFeatureOptions.find(f => f.value === aiFeature)?.label }}
        </span>
        <button @click="closeAiPanel" class="ml-auto p-1 text-gray-400 hover:text-gray-600 text-xs">✕</button>
      </div>
      <div class="px-3 py-2">
        <textarea v-model="aiPromptText" rows="6"
          class="w-full px-3 py-2 border border-gray-200 rounded-lg text-xs leading-relaxed outline-none focus:border-primary font-mono resize-none text-gray-600 bg-white" />
        <p class="text-[11px] text-gray-400 mt-1">提示词可临时编辑，关闭后恢复默认。{content} 替换为笔记内容。选中文本时仅处理选中部分，否则处理全文。</p>
      </div>
      <div class="px-3 pb-3">
        <div v-if="aiError" class="text-xs text-red-500 bg-red-50 rounded-lg px-3 py-2 mb-2">{{ aiError }}</div>
        <div v-if="aiResult" class="mb-2">
          <div class="text-[10px] text-gray-400 mb-1">AI 结果预览：</div>
          <pre class="max-h-40 overflow-y-auto bg-white border border-gray-200 rounded-lg px-3 py-2 text-xs text-gray-700 whitespace-pre-wrap font-mono">{{ aiResult }}</pre>
        </div>
        <div class="flex gap-2">
          <button v-if="!aiResult" @click="runAi" :disabled="aiProcessing"
            class="px-4 py-1.5 text-white text-xs font-medium rounded-lg disabled:opacity-50 transition-colors"
            style="background: rgb(var(--c-accent))">
            {{ aiProcessing ? '处理中...' : '开始' }}
          </button>
          <template v-else>
            <button @click="applyAiResult" class="px-4 py-1.5 text-white text-xs font-medium rounded-lg transition-colors" style="background: rgb(var(--c-accent))">应用</button>
            <button @click="runAi" :disabled="aiProcessing" class="px-4 py-1.5 text-xs text-gray-500 rounded-lg hover:bg-gray-100">{{ aiProcessing ? '处理中...' : '重新生成' }}</button>
          </template>
        </div>
      </div>
    </div>

    <!-- Tags display -->
    <div v-if="tags.length" class="flex flex-wrap gap-1 px-4 py-2 border-t border-gray-50">
      <span v-for="tag in tags" :key="tag" class="inline-flex items-center gap-1 text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">
        #{{ tag }} <button @click="removeTag(tag)" class="text-gray-400 hover:text-red-500">&times;</button>
      </span>
    </div>
  </div>

  <!-- Popups: Teleport 到 body,不受 modal overflow-hidden 裁剪 -->
  <Teleport to="body">
    <div v-if="showTagInput || showRefSearch" class="fixed inset-0" style="z-index: 9998" @click="closePopups" />
    <!-- Tag popup -->
    <div v-if="showTagInput" class="bg-white border border-gray-200 rounded-lg shadow-lg p-2 flex items-center gap-2 whitespace-nowrap"
      :style="getPopupPos(tagBtnEl, 220)">
      <input v-model="tagInput" @keydown.enter="addTag" @click.stop placeholder="输入标签回车添加" class="popup-input w-40" />
      <button @click.stop="addTag" class="popup-btn shrink-0">添加</button>
    </div>
    <!-- Reference popup -->
    <div v-if="showRefSearch" class="bg-white border border-gray-200 rounded-lg shadow-lg p-2 w-64"
      :style="getPopupPos(refBtnEl, 256)">
      <div v-if="refResults.length" class="flex-1 min-h-0 overflow-y-auto space-y-1 mb-1">
        <button v-for="r in refResults" :key="r.id" @click.stop="insertRef(r)" class="w-full text-left px-2 py-1.5 rounded hover:bg-gray-50 text-xs text-gray-600 truncate">
          {{ r.content.replace(/[#*`\[\]<>]/g, '').split('\n')[0]?.slice(0, 40) }}
        </button>
      </div>
      <div v-else-if="refQuery.trim()" class="text-xs text-gray-400 py-2 text-center mb-1">无结果</div>
      <input v-model="refQuery" @input="searchRefs" @click.stop placeholder="搜索笔记..." class="popup-input w-full shrink-0" />
    </div>
  </Teleport>
</template>

<style>
.scrollbar-hide { -ms-overflow-style: none; scrollbar-width: none; }
.scrollbar-hide::-webkit-scrollbar { display: none; }
/* 编辑器内音频播放按钮 */
.voice-play-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: rgb(var(--c-accent));
  color: white;
  font-size: 10px;
  cursor: pointer;
  user-select: none;
  vertical-align: middle;
  margin-left: 4px;
  line-height: 1;
}
.voice-play-btn:hover { opacity: 0.8; }
.voice-play-btn--playing { animation: voice-pulse 1s ease-in-out infinite; }
/* Vditor theme overrides —— Vditor 把 .vditor class 合并到 .vditor-wrapper 上 */
.vditor-wrapper {
  border: none !important;
  width: 100% !important;
  display: flex !important;
  flex-direction: column !important;
}
/* 非全屏:限制内容区 max-height + overflow */
.vditor-wrapper > .vditor-content {
  max-height: var(--editor-max, none) !important;
  overflow-y: auto !important;
}
.vditor-wrapper .vditor-toolbar {
  border-bottom: 1px solid #f1f5f9 !important;
  padding: 2px 6px !important;
  background: transparent !important;
}
.vditor-wrapper .vditor-toolbar__item {
  padding: 0 !important;
  margin: 0 1px !important;
}
.vditor-wrapper .vditor-toolbar__item button,
.vditor-wrapper .vditor-toolbar__item > span {
  color: #64748b;
  height: 28px !important;
  width: 28px !important;
  padding: 0 !important;
}
.vditor-wrapper .vditor-toolbar__item button svg {
  height: 14px !important;
  width: 14px !important;
}
.vditor-wrapper .vditor-toolbar__item button:hover {
  color: #1e293b;
  background: #f1f5f9;
  border-radius: 6px;
}
.vditor-wrapper .vditor-toolbar__item--current button {
  color: rgb(var(--c-accent)) !important;
  background: rgb(var(--c-accent-light)) !important;
  border-radius: 6px;
}
.vditor-wrapper .vditor-ir .vditor-reset,
.vditor-wrapper .vditor-wysiwyg .vditor-reset,
.vditor-wrapper .vditor-sv .vditor-reset {
  font-size: 14px;
  padding: 8px 16px;
  min-height: 80px;
}
/* 去掉编辑区第一个元素的上边距 */
.vditor-wrapper .vditor-reset > :first-child {
  margin-top: 0 !important;
  padding-top: 0 !important;
}
/* 去掉 Vditor 内置的居中和多余间距，让内容区撑满 */
.vditor-wrapper .vditor-reset,
.vditor .vditor-reset,
.vditor-ir .vditor-reset,
.vditor-ir pre.vditor-reset {
  max-width: none !important;
  margin: 0 !important;
  padding: 8px 16px !important;
  width: 100% !important;
  box-sizing: border-box !important;
}
/* placeholder 也从头开始 */
.vditor-ir pre.vditor-reset:empty::before,
.vditor-ir .vditor-reset .vditor-ir__marker--bi::before {
  margin-left: 0 !important;
}
.vditor-wrapper .vditor-reset {
  color: #1e293b;
}
.vditor-wrapper .vditor-reset::before {
  color: #9ca3af !important;
}
/* 全屏时 content 撑满 */
[data-fullscreen="true"] > .vditor-wrapper > .vditor-content {
  flex: 1 1 0 !important;
  max-height: none !important;
  min-height: 0 !important;
  height: 0 !important;
}
/* tooltip 统一翻转到下方（全屏贴顶/Capture 被标题栏挡） */
[data-fullscreen="true"] .vditor-tooltipped::after,
.tooltip-below .vditor-tooltipped::after {
  top: 100% !important;
  bottom: auto !important;
  margin-top: 5px !important;
  margin-bottom: 0 !important;
}
[data-fullscreen="true"] .vditor-tooltipped::before,
.tooltip-below .vditor-tooltipped::before {
  top: 100% !important;
  bottom: auto !important;
  border: 5px solid transparent !important;
  border-bottom-color: rgba(0,0,0,0.8) !important;
  margin-top: -1px !important;
}
/* Fix emoji panel */
.vditor-wrapper .vditor-hint, .vditor-wrapper .vditor-panel--arrow {
  z-index: 999 !important;
}
/* Dark mode */
[data-theme="dark"] .vditor-wrapper .vditor-toolbar { border-bottom-color: rgba(255,255,255,0.06) !important; }
[data-theme="dark"] .vditor-wrapper .vditor-toolbar__item button,
[data-theme="dark"] .vditor-wrapper .vditor-toolbar__item > span { color: #94a3b8; }
[data-theme="dark"] .vditor-wrapper .vditor-toolbar__item button:hover { color: #e2e8f0; background: rgba(255,255,255,0.08); }
[data-theme="dark"] .vditor-wrapper .vditor-reset { color: #e2e8f0; }
[data-theme="dark"] .vditor-wrapper .vditor-reset::before { color: rgba(255,255,255,0.25) !important; }
[data-theme="dark"] .voice-play-btn { background: rgb(var(--c-accent)); }
</style>
