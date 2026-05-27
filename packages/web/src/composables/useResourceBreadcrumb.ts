import { ref } from 'vue';

// 资源页面包屑跨组件共享 (Resources view 跟 TopBar 是 flex sibling 不是父子链, provide/inject 不通,
// 用 module-level ref 直接共享). Resources view 在 currentFolderId 变化时同步进来, TopBar 读 + 渲染.
export const resourceBreadcrumb = ref<Array<{ id: string; name: string }>>([]);
// 点击面包屑跳转回调, Resources view 注册, TopBar 内调用
export const resourceBreadcrumbGoTo = ref<((id: string | null) => void) | null>(null);
