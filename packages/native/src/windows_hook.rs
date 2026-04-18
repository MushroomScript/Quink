// 剪贴板 fallback:用 SendInput 发 Ctrl+C,保证修饰键状态干净
use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use windows::Win32::Foundation::*;
use windows::Win32::UI::Input::KeyboardAndMouse::*;
use windows::Win32::UI::WindowsAndMessaging::*;

use crate::SelectionEvent;

static CALLBACK: OnceLock<ThreadsafeFunction<SelectionEvent, ErrorStrategy::Fatal>> =
    OnceLock::new();

pub fn set_callback(cb: ThreadsafeFunction<SelectionEvent, ErrorStrategy::Fatal>) {
    let _ = CALLBACK.set(cb);
}

pub fn get_foreground_hwnd() -> i64 {
    unsafe { GetForegroundWindow().0 as i64 }
}

pub fn grab_selection() {
    std::thread::spawn(|| {
        // 1) 等用户完全松开修饰键,避免 Alt+Q 按着时发出 Alt+Ctrl+C 这种假组合
        wait_modifiers_release(Duration::from_millis(300));

        let old_clipboard = get_clipboard_text().unwrap_or_default();
        let (x, y) = get_cursor_pos();

        // 2) SendInput 发 Ctrl+C,先松开所有残留修饰键
        send_ctrl_c_clean();

        // 3) 轮询剪贴板变化(有变化立刻取,最多等 300ms)
        let new_text = poll_clipboard_change(&old_clipboard, Duration::from_millis(300));

        // 4) 无论成功与否,恢复旧剪贴板
        if new_text.is_some() {
            let _ = clipboard_win::set_clipboard_string(&old_clipboard);
        }

        if let Some(text) = new_text {
            let t = text.trim().to_string();
            if !t.is_empty() && t.len() < 20000 {
                if let Some(cb) = CALLBACK.get() {
                    cb.call(
                        SelectionEvent { text: t, x, y },
                        ThreadsafeFunctionCallMode::NonBlocking,
                    );
                }
            }
        }
    });
}

fn wait_modifiers_release(max: Duration) {
    let start = Instant::now();
    loop {
        let any_down = is_key_down(VK_MENU)
            || is_key_down(VK_LWIN)
            || is_key_down(VK_RWIN)
            || is_key_down(VK_SHIFT)
            || is_key_down(VK_CONTROL);
        if !any_down {
            return;
        }
        if start.elapsed() >= max {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn is_key_down(vk: VIRTUAL_KEY) -> bool {
    unsafe { (GetAsyncKeyState(vk.0 as i32) as u16 & 0x8000) != 0 }
}

fn send_ctrl_c_clean() {
    unsafe {
        let mut inputs: Vec<INPUT> = Vec::new();

        // 任何残留的修饰键先松开(重复松开无副作用)
        for vk in [VK_MENU, VK_LWIN, VK_RWIN, VK_SHIFT, VK_CONTROL] {
            if is_key_down(vk) {
                inputs.push(make_key_input(vk, true));
            }
        }

        // Ctrl+C 完整序列
        inputs.push(make_key_input(VK_CONTROL, false));
        inputs.push(make_key_input(VK_C, false));
        inputs.push(make_key_input(VK_C, true));
        inputs.push(make_key_input(VK_CONTROL, true));

        SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
    }
}

fn make_key_input(vk: VIRTUAL_KEY, key_up: bool) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                wScan: 0,
                dwFlags: if key_up {
                    KEYEVENTF_KEYUP
                } else {
                    KEYBD_EVENT_FLAGS(0)
                },
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

fn poll_clipboard_change(old: &str, max: Duration) -> Option<String> {
    let start = Instant::now();
    // 给目标应用一点时间响应 Ctrl+C
    std::thread::sleep(Duration::from_millis(30));
    loop {
        let cur = get_clipboard_text().unwrap_or_default();
        if !cur.is_empty() && cur != old {
            return Some(cur);
        }
        if start.elapsed() >= max {
            return None;
        }
        std::thread::sleep(Duration::from_millis(15));
    }
}

fn get_cursor_pos() -> (i32, i32) {
    unsafe {
        let mut point = POINT::default();
        let _ = GetCursorPos(&mut point);
        (point.x, point.y)
    }
}

fn get_clipboard_text() -> Option<String> {
    clipboard_win::get_clipboard_string().ok()
}
