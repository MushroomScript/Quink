import { createRouter, createWebHistory } from 'vue-router';
import { isLoggedIn } from '@/api';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/login',
      name: 'login',
      component: () => import('@/views/Login.vue'),
      meta: { public: true },
    },
    {
      path: '/',
      name: 'inspiration',
      component: () => import('@/views/Inspiration.vue'),
      meta: { title: '灵感' },
    },
    {
      path: '/notes',
      name: 'notes',
      component: () => import('@/views/Notes.vue'),
      meta: { title: '笔记' },
    },
    {
      path: '/todos',
      name: 'todos',
      component: () => import('@/views/Todos.vue'),
      meta: { title: '待办' },
    },
    {
      path: '/ai',
      name: 'ai',
      component: () => import('@/views/AI.vue'),
      meta: { title: 'AI', hideSearch: true },
    },
    {
      path: '/stats',
      name: 'stats',
      component: () => import('@/views/Stats.vue'),
      meta: { title: '统计' },
    },
    {
      path: '/resources',
      name: 'resources',
      component: () => import('@/views/Resources.vue'),
      meta: { title: '资源' },
    },
    {
      path: '/note/:id',
      name: 'note-detail',
      component: () => import('@/views/NoteDetail.vue'),
      meta: { title: '笔记详情', hideSearch: true },
    },
    {
      path: '/trash',
      name: 'trash',
      component: () => import('@/views/Trash.vue'),
      meta: { title: '回收站', hideSearch: true },
    },
    {
      path: '/settings',
      name: 'settings',
      component: () => import('@/views/Settings.vue'),
      meta: { title: '设置', hideSearch: true },
    },
    {
      path: '/capture',
      name: 'capture',
      component: () => import('@/views/Capture.vue'),
      meta: { public: false, hideChrome: true },
    },
  ],
});

router.beforeEach((to) => {
  if (!to.meta.public && !isLoggedIn()) {
    return { name: 'login' };
  }
});

export default router;
