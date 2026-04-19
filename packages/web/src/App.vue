<script setup lang="ts">
import { RouterView, useRoute, useRouter } from 'vue-router';
import { computed, onMounted, provide, ref, watch } from 'vue';
import { useAuthStore } from '@/stores/auth';
import Sidebar from '@/components/Sidebar.vue';
import TopBar from '@/components/TopBar.vue';
import NoteEditModal from '@/components/NoteEditModal.vue';
import GlobalToast from '@/components/GlobalToast.vue';
import type { Note } from '@/api';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();

const showChrome = computed(() => !['login', 'capture', 'float', 'ai-chat'].includes(route.name as string));
const showMobileSidebar = ref(false);
const appReady = ref(false);

const editingNote = ref<Note | null>(null);
function openEditModal(note: Note) { editingNote.value = note; }
function closeEditModal() { editingNote.value = null; }
provide('openEditModal', openEditModal);
provide('toggleMobileSidebar', () => { showMobileSidebar.value = !showMobileSidebar.value; });

// 路由变化时自动关闭手机端抽屉
watch(() => route.path, () => { showMobileSidebar.value = false; });

onMounted(async () => {
  const user = await auth.fetchMe();
  appReady.value = true;
  if (!user) return;
  const prefs = user.preferences || {};

  const theme = prefs.theme || 'blueberry';
  document.documentElement.setAttribute('data-theme', theme);

  const fontSize = prefs.fontSize || 16;
  document.documentElement.style.fontSize = fontSize + 'px';

  // 全局拦截引用链接点击(PC 端在应用内跳转,不打开浏览器)
  document.addEventListener('click', (e) => {
    const link = (e.target as HTMLElement).closest?.('a');
    if (!link) return;
    const href = link.getAttribute('href') || '';
    if (href.includes('ref=')) {
      e.preventDefault();
      e.stopPropagation();
      try {
        const id = new URL(href, location.origin).searchParams.get('ref');
        if (id) router.push(`/note/${id}`);
      } catch {}
    }
  });
});
</script>

<template>
  <!-- 无 chrome 路由(float / capture / ai-chat / login):直接渲染,跳过全屏 loading -->
  <RouterView v-if="!showChrome" />

  <!-- 主界面 loading -->
  <div v-else-if="!appReady" class="h-full flex items-center justify-center" style="background: var(--c-body, #f5f5f7)">
    <div class="text-center">
      <h1 class="text-2xl font-bold" style="color: rgb(var(--c-accent, 116 143 252))">Quink</h1>
      <p class="text-xs text-gray-400 mt-1">加载中...</p>
    </div>
  </div>

  <!-- 主界面 -->
  <template v-else>
    <div class="flex h-full overflow-hidden">
      <div class="hidden md:block">
        <Sidebar />
      </div>

      <!-- Mobile sidebar drawer -->
      <div v-if="showMobileSidebar" class="fixed inset-0 z-50 md:hidden">
        <div class="absolute inset-0 bg-black/40" @click="showMobileSidebar = false" />
        <div class="absolute left-0 -top-[200px] -bottom-[200px] w-60 shadow-2xl overflow-y-auto bg-sidebar pt-[200px] pb-[200px]" @click.stop>
          <Sidebar />
        </div>
      </div>

      <div class="flex-1 flex flex-col overflow-hidden">
        <TopBar />
        <main class="flex-1 overflow-y-auto" style="scrollbar-gutter: stable">
          <RouterView v-slot="{ Component }">
            <KeepAlive :include="['inspiration', 'notes', 'todos']">
              <component :is="Component" />
            </KeepAlive>
          </RouterView>
        </main>
      </div>
    </div>

    <NoteEditModal v-if="editingNote" :note="editingNote" @close="closeEditModal" />
  </template>

  <!-- 全局 Toast(所有路由,包括浮窗/登录等) -->
  <GlobalToast />
</template>
