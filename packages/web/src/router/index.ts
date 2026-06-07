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
      // PR #8 命名重整: 灵感路由从 / 改到 /quink, 跟 /notes /todos 对称. 旧 / 加重定向到 /quink 保留用户书签
      path: '/quink',
      name: 'inspiration',
      component: () => import('@/views/Inspiration.vue'),
      meta: { title: '灵感' },
    },
    {
      path: '/',
      redirect: '/quink',
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
      meta: { title: '统计', hideSearch: true },
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
      meta: { title: '', hideSearch: true },
    },
    {
      path: '/tags',
      name: 'tags',
      component: () => import('@/views/Tags.vue'),
      meta: { title: '标签' },
    },
    {
      path: '/trash',
      name: 'trash',
      component: () => import('@/views/Trash.vue'),
      meta: { title: '回收站' },
    },
    {
      path: '/groups',
      name: 'groups',
      component: () => import('@/views/Groups.vue'),
      meta: { title: '群组', hideSearch: true },
    },
    {
      path: '/groups/:id',
      name: 'group-detail',
      component: () => import('@/views/Groups.vue'),
      meta: { title: '群组', hideSearch: true },
    },
    {
      path: '/invite/:token',
      name: 'invite',
      component: () => import('@/views/Invite.vue'),
      // public: 未登录可看邀请页 (点"申请加入"再跳登录回跳)
      meta: { public: true, hideChrome: true },
    },
    {
      path: '/settings',
      name: 'settings',
      component: () => import('@/views/Settings.vue'),
      meta: { title: '设置', hideSearch: true, hideRefresh: true },
    },
    {
      path: '/notifications',
      name: 'notifications',
      component: () => import('@/views/Notifications.vue'),
      meta: { title: '消息通知', hideSearch: true },
    },
    {
      path: '/capture',
      name: 'capture',
      component: () => import('@/views/Capture.vue'),
      meta: { public: false, hideChrome: true },
    },
    {
      path: '/float',
      name: 'float',
      component: () => import('@/views/FloatingMenu.vue'),
      meta: { public: false, hideChrome: true },
    },
    {
      path: '/ai-chat',
      name: 'ai-chat',
      component: () => import('@/views/AiChat.vue'),
      meta: { public: false, hideChrome: true },
    },
  ],
});

router.beforeEach((to) => {
  // 引用链接 /?ref=id → 重定向到详情页
  if (to.query.ref) {
    return { path: `/note/${to.query.ref}`, replace: true };
  }
  if (!to.meta.public && !isLoggedIn()) {
    return { name: 'login' };
  }
});

export default router;
