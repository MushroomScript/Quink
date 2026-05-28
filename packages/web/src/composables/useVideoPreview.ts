import { ref } from 'vue';

// 全局单例 state, 跟 useImagePreview 同 pattern. 同一时刻只能有一个视频预览
export interface PreviewVideo {
  url: string;
  filename: string;
}

const current = ref<PreviewVideo | null>(null);

function open(video: PreviewVideo) {
  current.value = video;
}

function close() {
  current.value = null;
}

export function useVideoPreview() {
  return { current, open, close };
}
