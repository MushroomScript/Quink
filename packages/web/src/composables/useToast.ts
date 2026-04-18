import { ref } from 'vue';

type ToastKind = 'default' | 'success' | 'error';

interface ToastState {
  visible: boolean;
  message: string;
  kind: ToastKind;
}

const state = ref<ToastState>({ visible: false, message: '', kind: 'default' });
let timer: ReturnType<typeof setTimeout> | null = null;

export function useToast() {
  return {
    state,
    show(message: string, kind: ToastKind = 'default', duration = 1600) {
      state.value = { visible: true, message, kind };
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        state.value.visible = false;
      }, duration);
    },
  };
}
