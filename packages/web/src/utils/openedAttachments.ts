// 已打开过的附件 URL Set, 跨调用点共享 (App.vue 处理笔记内附件链接, Resources.vue 处理资源页文件单击).
// 跟 main 端 attachmentCache 同进程生命周期, 一致性自然保证(都是进程内 Map, 重启都清).
// 用途:
//   - 二次点击同一附件跳过 dock 进度提示, 直接 toast(因为 main cache 命中, 几乎瞬间打开)
//   - 决定大文件 confirm 是否触发: 已打开过 = 已缓存 = 跳过 confirm 秒开
export const openedAttachments = new Set<string>();
