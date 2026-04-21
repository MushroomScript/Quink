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
const showDeleteConfirm = ref(false);
const deletingCategoryId = ref<number | null>(null);
const deletingCategoryName = ref('');

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
watch(() => notesStore.filterCategory, (v) => { activeCategory.value = v; });

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
  try {
    await api.deleteCategory(id);
    await loadCategories();
    if (activeCategory.value === deletingCategoryName.value) {
      activeCategory.value = '';
      notesStore.filterCategory = '';
      notesStore.fetchNotes();
    }
  } catch {}
  showDeleteConfirm.value = false;
  deletingCategoryId.value = null;
  deletingCategoryName.value = '';
}

function confirmDelete(cat: any) {
  deletingCategoryId.value = cat.id;
  deletingCategoryName.value = cat.name;
  showDeleteConfirm.value = true;
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
  // 只在非内容页时跳灵感,灵感/笔记/待办页原地筛选
  const contentPaths = ['/', '/notes', '/todos'];
  if (!contentPaths.includes(route.path)) {
    router.push('/');
  }
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
        <button @click="showAddCategory = true" class="text-xs" style="color: var(--sb-dim)" title="新增分类">+</button>
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
          <button @click.stop="confirmDelete(cat)" class="opacity-0 group-hover:opacity-100 text-[10px] hover:text-red-400" style="color: var(--sb-dim)">✕</button>
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
            <button @click.stop="confirmDelete(child)" class="opacity-0 group-hover:opacity-100 text-[10px] hover:text-red-400" style="color: var(--sb-dim)">✕</button>
          </div>
        </template>
      </div>
    </div>

  </aside>

  <Teleport to="body">
    <div v-if="showUserMenu" class="fixed inset-0 z-40" @click="closeUserMenu" />

    <!-- 添加分类弹窗 -->
    <div v-if="showAddCategory" class="fixed inset-0 z-[200] flex items-center justify-center">
      <div class="absolute inset-0 bg-black/30" @click="showAddCategory = false" />
      <div class="relative bg-white rounded-xl shadow-xl p-5 w-72">
        <p class="text-sm font-medium text-gray-700 mb-3">新增分类</p>
        <input v-model="newCategoryName" @keydown.enter="addCategory" placeholder="输入分类名称" autofocus
          class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/40" />
        <div class="flex gap-2 mt-4 justify-end">
          <button @click="showAddCategory = false; newCategoryName = ''"
            class="px-4 py-1.5 text-xs rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">取消</button>
          <button @click="addCategory"
            class="px-4 py-1.5 text-xs rounded-lg text-white font-medium"
            style="background: rgb(var(--c-accent-dark))">添加</button>
        </div>
      </div>
    </div>

    <!-- 删除分类确认弹窗 -->
    <div v-if="showDeleteConfirm" class="fixed inset-0 z-[200] flex items-center justify-center">
      <div class="absolute inset-0 bg-black/30" @click="showDeleteConfirm = false" />
      <div class="relative bg-white rounded-xl shadow-xl p-5 w-72 text-center">
        <p class="text-sm text-gray-700 mb-1">确认删除分类</p>
        <p class="text-xs text-gray-400 mb-4">「{{ deletingCategoryName }}」及关联笔记的分类将被清除</p>
        <div class="flex gap-2 justify-center">
          <button @click="showDeleteConfirm = false"
            class="px-4 py-1.5 text-xs rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">取消</button>
          <button @click="deleteCategory(deletingCategoryId!)"
            class="px-4 py-1.5 text-xs rounded-lg text-white font-medium bg-red-500 hover:bg-red-600">删除</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.nav-item:not(.router-link-active):hover {
  background: var(--sb-hover);
  color: var(--sb-text);
}
</style>
