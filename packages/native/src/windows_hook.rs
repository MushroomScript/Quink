use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode};
use std::sync::OnceLock;
use std::time::Duration;

use windows::Win32::Foundation::*;
use windows::Win32::UI::Input::KeyboardAndMouse::*;
use windows::Win32::UI::WindowsAndMessaging::*;

use crate::SelectionEvent;

static CALLBACK: OnceLock<ThreadsafeFunction<SelectionEvent, ErrorStrategy::Fatal>> = OnceLock::new();

pub fn set_callback(cb: ThreadsafeFunction<SelectionEvent, ErrorStrategy::Fatal>) {
    let _ = CALLBACK.set(cb);
}

pub fn grab_selection() {
    std::thread::spawn(|| {
        let old_clipboard = get_clipboard_text().unwrap_or_default();
        let (x, y) = get_cursor_pos();

        // 用 keybd_event 模拟 Ctrl+C（比 SendInput 更底层，兼容性更好）
        simulate_ctrl_c_keybd_event();

        std::thread::sleep(Duration::from_millis(200));

        let new_clipboard = get_clipboard_text().unwrap_or_default();

        if !new_clipboard.is_empty() && new_clipboard != old_clipboard {
            let text = new_clipboard.trim().to_string();
            set_clipboard_text(&old_clipboard);

            if !text.is_empty() && text.len() < 10000 {
                if let Some(cb) = CALLBACK.get() {
                    cb.call(
                        SelectionEvent { text, x, y },
                        ThreadsafeFunctionCallMode::NonBlocking,
                    );
                }
            }
        }
    });
}

fn simulate_ctrl_c_keybd_event() {
    unsafe {
        // keybd_event 比 SendInput 更底层
        keybd_event(VK_CONTROL.0 as u8, 0, KEYBD_EVENT_FLAGS(0), 0);
        keybd_event(VK_C.0 as u8, 0, KEYBD_EVENT_FLAGS(0), 0);
        keybd_event(VK_C.0 as u8, 0, KEYEVENTF_KEYUP, 0);
        keybd_event(VK_CONTROL.0 as u8, 0, KEYEVENTF_KEYUP, 0);
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

fn set_clipboard_text(text: &str) {
    let _ = clipboard_win::set_clipboard_string(text);
}
