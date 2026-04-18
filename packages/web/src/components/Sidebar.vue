<script setup lang="ts">
import { ref, watch, onMounted } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { useNotesStore } from '@/stores/notes';
import { api, isLoggedIn, type Category } from '@/api';

const router = useRouter();
const route = useRoute();
const auth = useAuthStore();
const notesStore = useNotesStore();
const stats = ref({ totalNotes: 0, totalTodos: 0, pendingTodos: 0 });
const showUserMenu = ref(false);
const categories = ref<Category[]>([]);
const showAddCategory = ref(false);
const newCategoryName = ref('');
const activeCategory = ref('');

async function loadStats() {
  if (!isLoggedIn()) return;
  try { const res = await api.getStats(); stats.value = res.data; } catch {}
}
async function loadCategories() {
  if (!isLoggedIn()) return;
  try { const res = await api.getCategories(); categories.value = res.data; } catch {}
}
loadStats();
loadCategories();
watch(() => notesStore.notes, () => { loadStats(); }, { deep: true });

async function addCategory() {
  const name = newCategoryName.value.trim();
  if (!name) return;
  try {
    await api.createCategory({ name });
    newCategoryName.value = '';
    showAddCategory.value = false;
    await loadCategories();
  } catch {}
}

async function deleteCategory(id: number) {
  try { await api.deleteCategory(id); await loadCategories(); } catch {}
}

function filterByCategory(name: string) {
  if (activeCategory.value === name) {
    activeCategory.value = '';
    notesStore.filterCategory = '';
  } else {
    activeCategory.value = name;
    notesStore.filterCategory = name;
  }
  notesStore.fetchNotes();
  router.push('/');
}

const mainNav = [
  { path: '/', label: '灵感', icon: '💡' },
  { path: '/notes', label: '笔记', icon: '📝' },
  { path: '/todos', label: '待办', icon: '✅' },
  { path: '/ai', label: 'AI', icon: '🤖' },
];

const moreNav = [
  { path: '/stats', label: '统计', icon: '📊' },
  { path: '/resources', label: '资源', icon: '📁' },
  { path: '/tags', label: '标签', icon: '🏷️' },
  { path: '/trash', label: '回收站', icon: '🗑️' },
];

const morePaths = moreNav.map(n => n.path);
const showMore = ref(morePaths.includes(route.path));

function isActive(path: string) { return route.path === path; }
function toggleUserMenu() { showUserMenu.value = !showUserMenu.value; }
function closeUserMenu() { showUserMenu.value = false; }
function goSettings() { closeUserMenu(); router.push('/settings'); }
function handleLogout() { closeUserMenu(); auth.logout(); router.push('/login'); }
function getInitial(name: string) { return name ? name.charAt(0).toUpperCase() : '?'; }
</script>

<template>
  <aside class="w-60 bg-sidebar flex flex-col min-h-full shrink-0" style="border-right: 1px solid var(--sb-border); box-shadow: 1px 0 4px rgba(0,0,0,0.04)">
    <!-- User -->
    <div class="relative px-3 py-4" style="border-bottom: 1px solid var(--sb-border)">
      <button @click="toggleUserMenu"
        class="flex items-center gap-3 w-full rounded-xl px-3 py-2.5 transition-colors text-left"
        style="color: var(--sb-text)" @mouseenter="$event.currentTarget.style.background = 'var(--sb-hover)'" @mouseleave="$event.currentTarget.style.background = 'transparent'">
        <div v-if="auth.avatar" class="w-9 h-9 rounded-full bg-cover bg-center shrink-0" :style="{ backgroundImage: `url(${auth.avatar})` }" />
        <div v-else class="w-9 h-9 rounded-full bg-primary/30 text-primary flex items-center justify-center text-sm font-bold shrink-0">
          {{ getInitial(auth.nickname) }}
        </div>
        <div class="flex-1 min-w-0">
          <div class="text-sm font-medium truncate" style="color: var(--sb-text)">{{ auth.nickname || '未设置' }}</div>
          <div class="text-xs truncate" style="color: var(--sb-dim)">@{{ auth.user?.username }}</div>
        </div>
        <svg class="w-4 h-4 shrink-0 transition-transform" :class="{ 'rotate-180': showUserMenu }" style="color: var(--sb-dim)" viewBox="0 0 20 20" fill="currentColor">
          <path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clip-rule="evenodd" />
        </svg>
      </button>

      <Transition enter-active-class="transition duration-100 ease-out" enter-from-class="opacity-0 scale-95"
        enter-to-class="opacity-100 scale-100" leave-active-class="transition duration-75 ease-in"
        leave-from-class="opacity-100 scale-100" leave-to-class="opacity-0 scale-95">
        <div v-if="showUserMenu" class="absolute left-3 right-3 top-full mt-1 bg-sidebar-light rounded-xl shadow-xl z-50 py-1" style="border: 1px solid var(--sb-border)">
          <button @click="goSettings" class="w-full flex items-center gap-2 px-4 py-2.5 text-sm transition-colors"
            style="color: var(--sb-text)" @mouseenter="$event.currentTarget.style.background = 'var(--sb-hover)'" @mouseleave="$event.currentTarget.style.background = 'transparent'">
            <span>&#9881;</span><span>设置</span>
          </button>
          <div style="border-top: 1px solid var(--sb-border); margin: 4px 0"></div>
          <button @click="handleLogout" class="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-red-400 hover:bg-red-500/10">
            <span>&#10151;</span><span>注销</span>
          </button>
        </div>
      </Transition>
    </div>

    <!-- Nav -->
    <nav class="flex-1 px-3 py-3 space-y-0.5 overflow-y-auto">
      <!-- Main nav -->
      <router-link v-for="item in mainNav" :key="item.path" :to="item.path"
        class="flex items-center gap-3 px-3 py-2 rounded-xl text-sm transition-all duration-150 nav-item"
        :style="isActive(item.path)
          ? { background: 'var(--sb-active-bg)', color: 'var(--sb-active-text)', fontWeight: 500 }
          : { color: 'var(--sb-dim)' }">
        <span class="text-base">{{ item.icon }}</span>
        <span>{{ item.label }}</span>
        <span v-if="item.label === '待办' && stats.pendingTodos > 0"
          class="ml-auto bg-red-500 text-white text-xs leading-none w-5 h-5 flex items-center justify-center rounded-full font-semibold">
          {{ stats.pendingTodos }}
        </span>
      </router-link>

      <!-- More (collapsed) -->
      <button @click="showMore = !showMore"
        class="flex items-center gap-3 px-3 py-1.5 rounded-xl text-xs w-full transition-colors nav-item"
        style="color: var(--sb-dim)">
        <span class="text-base">{{ showMore ? '▾' : '▸' }}</span>
        <span>更多</span>
      </button>
      <template v-if="showMore">
        <router-link v-for="item in moreNav" :key="item.path" :to="item.path"
          class="flex items-center gap-3 px-3 py-1.5 rounded-xl text-xs transition-all duration-150 nav-item"
          :style="isActive(item.path)
            ? { background: 'var(--sb-active-bg)', color: 'var(--sb-active-text)', fontWeight: 500 }
            : { color: 'var(--sb-dim)' }">
          <span class="text-sm">{{ item.icon }}</span>
          <span>{{ item.label }}</span>
        </router-link>
      </template>
    </nav>

    <!-- Categories -->
    <div class="px-3 py-2" style="border-top: 1px solid var(--sb-border)">
      <div class="flex items-center justify-between px-3 mb-1">
        <span class="text-[11px] font-medium" style="color: var(--sb-dim)">分类</span>
        <button @click="showAddCategory = !showAddCategory" class="text-xs" style="color: var(--sb-dim)" title="新增分类">+</button>
      </div>
      <!-- Add form -->
      <div v-if="showAddCategory" class="flex gap-1 px-2 mb-2">
        <input v-model="newCategoryName" @keydown.enter="addCategory" placeholder="分类名称"
          class="flex-1 px-2 py-1 rounded-md text-xs outline-none" style="background: var(--sb-hover); color: var(--sb-text)" />
        <button @click="addCategory" class="px-2 py-1 rounded-md text-xs" style="background: var(--sb-hover); color: var(--sb-text)">添加</button>
      </div>
      <!-- Tree -->
      <div v-if="categories.length === 0 && !showAddCategory" class="px-3 py-2">
        <span class="text-[11px]" style="color: var(--sb-dim); opacity: 0.5">暂无分类</span>
      </div>
      <div v-else class="space-y-0.5 max-h-40 overflow-y-auto">
        <div v-for="cat in categories" :key="cat.id"
          @click="filterByCategory(cat.name)"
          class="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs cursor-pointer transition-all group"
          :style="activeCategory === cat.name
            ? { background: 'var(--sb-active-bg)', color: 'var(--sb-active-text)' }
            : { color: 'var(--sb-dim)' }">
          <span>📂</span>
          <span class="flex-1 truncate">{{ cat.name }}</span>
          <button @click.stop="deleteCategory(cat.id)" class="opacity-0 group-hover:opacity-100 text-[10px] hover:text-red-400" style="color: var(--sb-dim)">✕</button>
          <!-- Children -->
        </div>
        <template v-for="cat in categories" :key="'children-' + cat.id">
          <div v-for="child in cat.children" :key="child.id"
            @click="filterByCategory(child.name)"
            class="flex items-center gap-2 px-3 py-1.5 pl-8 rounded-lg text-xs cursor-pointer transition-all group"
            :style="activeCategory === child.name
              ? { background: 'var(--sb-active-bg)', color: 'var(--sb-active-text)' }
              : { color: 'var(--sb-dim)' }">
            <span>📄</span>
            <span class="flex-1 truncate">{{ child.name }}</span>
            <button @click.stop="deleteCategory(child.id)" class="opacity-0 group-hover:opacity-100 text-[10px] hover:text-red-400" style="color: var(--sb-dim)">✕</button>
          </div>
        </template>
      </div>
    </div>

  </aside>

  <Teleport to="body">
    <div v-if="showUserMenu" class="fixed inset-0 z-40" @click="closeUserMenu" />
  </Teleport>
</template>

<style scoped>
.nav-item:not(.router-link-active):hover {
  background: var(--sb-hover);
  color: var(--sb-text);
}
</style>
