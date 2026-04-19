<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue';
import Vditor from 'vditor';
import 'vditor/dist/index.css';
import { api } from '@/api';

const props = withDefaults(defineProps<{
  initialContent?: string;
  initialType?: string;
  initialTags?: string[];
  placeholder?: string;
  showTypeSelector?: boolean;
  submitLabel?: string;
  zIndex?: number;
  minHeight?: number;
  maxHeight?: number;
  showAi?: boolean;
  showFullscreenBtn?: boolean;
}>(), {
  initialContent: '',
  initialType: 'note',
  initialTags: () => [],
  placeholder: '写下你的想法...',
  showTypeSelector: true,
  submitLabel: '保存',
  showAi: true,
  zIndex: 50,
  minHeight: 120,
  maxHeight: 320,
  showFullscreenBtn: true,
});

const isFullscreen = ref(false);
function toggleFullscreen() { isFullscreen.value = !isFullscreen.value; }

const emit = defineEmits<{
  (e: 'submit', data: { html: string; type: string; tags: string[] }): void;
}>();

const noteTypes = [
  { value: 'note', label: '灵感', icon: '💡' },
  { value: 'snippet', label: '笔记', icon: '📝' },
  { value: 'todo', label: '待办', icon: '✅' },
];

const noteType = ref(props.initialType);
const tags = ref<string[]>([...props.initialTags]);
const showTagInput = ref(false);
const tagInput = ref('');
const showRefSearch = ref(false);
const refQuery = ref('');
const refResults = ref<any[]>([]);

// AI panel
const showAiPanel = ref(false);
const aiFeature = ref<'polish' | 'expand' | 'write'>('polish');
const aiPromptText = ref('');
const aiProcessing = ref(false);
const aiResult = ref('');
const aiError = ref('');

const aiFeatureOptions = [
  { value: 'polish' as const, label: '润色', icon: '✨' },
  { value: 'expand' as const, label: '扩充', icon: '📖' },
  { value: 'write' as const, label: '写文', icon: '✍️' },
];

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
    toolbarConfig: { pin: true },
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
      // Focus editor
      vditor?.focus();
    },
    input: () => {
      dirty.value = true;
    },
  });
});

onBeforeUnmount(() => {
  vditor?.destroy();
  vditor = null;
});

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
  try { const r = await api.getNotes({ search: refQuery.value, limit: '5' }); refResults.value = r.data; } catch { refResults.value = []; }
}
function insertRef(note: any) {
  const firstLine = (note.content || '').split('\n').find((l: string) => l.trim()) || '';
  const label = firstLine.replace(/[#*`\[\]!>~]/g, '').trim().slice(0, 20) || '引用笔记';
  vditor?.insertValue(`[📌 ${label}](/?ref=${note.id})`);
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

defineExpose({ clearContent, isDirty: computed(() => dirty.value) });
</script>

<template>
  <div @keydown="onKeydown"
    :data-fullscreen="isFullscreen || undefined"
    :class="isFullscreen
      ? 'fixed inset-0 z-[200] bg-white flex flex-col'
      : 'flex flex-col'">
    <!-- Vditor editor -->
    <div ref="editorRef" class="vditor-wrapper"
      :style="isFullscreen ? { flex: '1 1 auto', minHeight: 0 } : { '--editor-max': maxHeight + 'px' }"></div>

    <!-- AI buttons + bottom bar -->
    <div class="flex items-center justify-between px-3 py-2 bg-gray-50 border-t border-gray-100 select-none">
      <div class="flex items-center gap-2">
        <!-- Type selector -->
        <div v-if="showTypeSelector" class="flex gap-0.5">
          <button v-for="t in noteTypes" :key="t.value" @click="noteType = t.value"
            class="px-2 py-1 rounded-md text-xs transition-colors"
            :class="noteType === t.value ? 'bg-primary-light text-primary-dark font-medium' : 'text-gray-400 hover:bg-gray-100 hover:text-gray-600'">
            {{ t.icon }} {{ t.label }}
          </button>
        </div>
        <span v-if="showTypeSelector" class="sep"></span>

        <!-- AI buttons with labels -->
        <template v-if="showAi">
          <div class="flex gap-0.5">
            <button v-for="f in aiFeatureOptions" :key="f.value"
              @click="aiFeature === f.value && showAiPanel ? closeAiPanel() : openAiPanel(f.value)"
              class="px-2 py-1 rounded-md text-xs transition-colors"
              :class="showAiPanel && aiFeature === f.value ? 'bg-primary-light text-primary-dark font-medium' : 'text-gray-400 hover:bg-gray-100 hover:text-gray-600'">
              {{ f.icon }} {{ f.label }}
            </button>
          </div>
          <span class="sep"></span>
        </template>

        <!-- Tags -->
        <div class="relative">
          <button @click.stop="showTagInput = !showTagInput" class="tbtn text-gray-400" title="添加标签">🏷️</button>
          <div v-if="showTagInput" class="absolute bottom-full left-0 mb-1 bg-white border border-gray-200 rounded-lg shadow-lg p-2 flex items-center gap-2 whitespace-nowrap" :style="{ zIndex: zIndex + 10 }">
            <input v-model="tagInput" @keydown.enter="addTag" placeholder="输入标签回车添加" class="popup-input w-40" />
            <button @click="addTag" class="popup-btn shrink-0">添加</button>
          </div>
        </div>
        <!-- Reference -->
        <div class="relative">
          <button @click.stop="showRefSearch = !showRefSearch" class="tbtn text-gray-400" title="引用笔记">📌</button>
          <div v-if="showRefSearch" class="absolute bottom-full left-0 mb-1 bg-white border border-gray-200 rounded-lg shadow-lg p-2 w-64" :style="{ zIndex: zIndex + 10 }">
            <input v-model="refQuery" @input="searchRefs" placeholder="搜索笔记..." class="popup-input w-full mb-1" />
            <div v-if="refResults.length" class="max-h-32 overflow-y-auto space-y-1">
              <button v-for="r in refResults" :key="r.id" @click="insertRef(r)" class="w-full text-left px-2 py-1.5 rounded hover:bg-gray-50 text-xs text-gray-600 truncate">
                {{ r.content.replace(/[#*`\[\]<>]/g, '').slice(0, 50) }}
              </button>
            </div>
            <div v-else-if="refQuery.trim()" class="text-xs text-gray-400 py-2 text-center">无结果</div>
          </div>
        </div>
      </div>

      <!-- Submit + fullscreen -->
      <div class="flex items-center gap-1.5">
        <button v-if="showFullscreenBtn" @click="toggleFullscreen"
          class="p-1.5 rounded-md text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
          :title="isFullscreen ? '退出全屏 (Esc)' : '全屏编辑'">
          <svg v-if="!isFullscreen" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
          </svg>
          <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />
          </svg>
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
        <span class="text-xs font-medium text-gray-500">{{ aiFeatureOptions.find(f => f.value === aiFeature)?.icon }} {{ aiFeatureOptions.find(f => f.value === aiFeature)?.label }}</span>
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

  <!-- Click outside overlay -->
  <Teleport to="body">
    <div v-if="showTagInput || showRefSearch" class="fixed inset-0" :style="{ zIndex }" @click="closePopups" />
  </Teleport>
</template>

<style>
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
/* 全屏时 toolbar 不 pin(fixed + fixed 会遮挡编辑区） */
[data-fullscreen="true"] .vditor-toolbar--pin {
  position: static !important;
}
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
</style>
