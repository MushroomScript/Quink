import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { api, type Note } from '@/api';

export const useNotesStore = defineStore('notes', () => {
  const notes = ref<Note[]>([]);
  const loading = ref(false);
  const total = ref(0);
  const currentPage = ref(1);
  const searchQuery = ref('');
  const filterCategory = ref('');
  const filterType = ref('');
  const sortBy = ref<'created' | 'updated'>('created');

  // Sorted notes
  const sortedNotes = computed(() => {
    return [...notes.value].sort((a, b) => {
      const dateA = sortBy.value === 'updated' ? a.updatedAt : a.createdAt;
      const dateB = sortBy.value === 'updated' ? b.updatedAt : b.createdAt;
      return dateB.localeCompare(dateA);
    });
  });

  // Group notes by date
  const groupedByDate = computed(() => {
    const groups: Record<string, Note[]> = {};
    for (const note of sortedNotes.value) {
      const dateField = sortBy.value === 'updated' ? note.updatedAt : note.createdAt;
      const date = dateField.slice(0, 10);
      if (!groups[date]) groups[date] = [];
      groups[date].push(note);
    }
    return groups;
  });

  async function fetchNotes(extra?: { tag?: string; tags?: string; types?: string; dateFrom?: string; dateTo?: string }) {
    loading.value = true;
    try {
      const params: Record<string, string> = {
        page: String(currentPage.value),
        limit: '50',
      };
      if (searchQuery.value) params.search = searchQuery.value;
      if (filterCategory.value) params.category = filterCategory.value;
      if (filterType.value) params.type = filterType.value;
      if (extra?.tag) params.tag = extra.tag;
      if (extra?.tags) params.tags = extra.tags;
      if (extra?.types) params.types = extra.types;
      if (extra?.dateFrom) params.dateFrom = extra.dateFrom;
      if (extra?.dateTo) params.dateTo = extra.dateTo;

      const res = await api.getNotes(params);
      notes.value = res.data;
      total.value = res.pagination.total;
    } finally {
      loading.value = false;
    }
  }

  async function createNote(content: string, type: string = 'note', tags?: string[]) {
    const res = await api.createNote({ content, type, tags });
    notes.value.unshift(res.data);
    total.value++;
    return res.data;
  }

  async function updateNote(id: string, data: Partial<Note>) {
    const res = await api.updateNote(id, data);
    const idx = notes.value.findIndex((n) => n.id === id);
    if (idx !== -1) notes.value[idx] = res.data;
    return res.data;
  }

  async function deleteNote(id: string) {
    await api.deleteNote(id);
    notes.value = notes.value.filter((n) => n.id !== id);
    total.value = Math.max(0, total.value - 1);
  }

  async function togglePin(id: string) {
    const note = notes.value.find((n) => n.id === id);
    if (note) {
      await updateNote(id, { pinned: !note.pinned });
      await fetchNotes();
    }
  }

  async function toggleTodo(id: string) {
    const note = notes.value.find((n) => n.id === id);
    if (note && note.type === 'todo') {
      const newStatus = note.todoStatus === 'done' ? 'pending' : 'done';
      await updateNote(id, { todoStatus: newStatus as any });
    }
  }

  // 监听桌面端快捷输入保存事件，自动刷新
  if (typeof window !== 'undefined') {
    window.addEventListener('quink-note-created', () => {
      fetchNotes();
    });
  }

  // ── 批量操作 ──
  const selectMode = ref(false);
  const selectedIds = ref<Set<string>>(new Set());

  function toggleSelectMode() {
    selectMode.value = !selectMode.value;
    if (!selectMode.value) selectedIds.value.clear();
  }

  function toggleSelect(id: string) {
    if (selectedIds.value.has(id)) selectedIds.value.delete(id);
    else selectedIds.value.add(id);
  }

  function selectAll() {
    for (const n of notes.value) selectedIds.value.add(n.id);
  }

  function clearSelection() {
    selectedIds.value.clear();
  }

  async function batchDelete() {
    for (const id of selectedIds.value) {
      await api.deleteNote(id);
    }
    selectedIds.value.clear();
    await fetchNotes();
  }

  async function batchMove(category: string) {
    for (const id of selectedIds.value) {
      await api.updateNote(id, { category } as any);
    }
    selectedIds.value.clear();
    await fetchNotes();
  }

  return {
    notes,
    loading,
    total,
    currentPage,
    searchQuery,
    filterCategory,
    filterType,
    sortBy,
    sortedNotes,
    groupedByDate,
    fetchNotes,
    createNote,
    updateNote,
    deleteNote,
    togglePin,
    toggleTodo,
    selectMode,
    selectedIds,
    toggleSelectMode,
    toggleSelect,
    selectAll,
    clearSelection,
    batchDelete,
    batchMove,
  };
});
