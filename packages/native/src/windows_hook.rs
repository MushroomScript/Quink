use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction, ThreadSafeCallContext, ThreadsafeFunctionCallMode};
use std::sync::atomic::{AtomicBool, Ordering};
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

/// Called when user presses the hotkey — grab selected text and return it.
pub fn grab_selection() {
    std::thread::spawn(|| {
        // Save current clipboard
        let old_clipboard = get_clipboard_text().unwrap_or_default();

        // Get cursor position
        let (x, y) = get_cursor_pos();

        // Simulate Ctrl+C
        simulate_ctrl_c();

        // Wait for clipboard to update
        std::thread::sleep(Duration::from_millis(150));

        // Read new clipboard
        let new_clipboard = get_clipboard_text().unwrap_or_default();

        if !new_clipboard.is_empty() && new_clipboard != old_clipboard {
            let text = new_clipboard.trim().to_string();

            // Restore old clipboard
            set_clipboard_text(&old_clipboard);

            if !text.is_empty() && text.len() < 10000 {
                if let Some(cb) = CALLBACK.get() {
                    cb.call(
                        SelectionEvent { text, x, y },
                        ThreadsafeFunctionCallMode::NonBlocking,
                    );
                }
            }
        } else {
            // Nothing new selected, restore clipboard just in case
            set_clipboard_text(&old_clipboard);
        }
    });
}

fn simulate_ctrl_c() {
    unsafe {
        let inputs = [
            INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VK_CONTROL,
                        wScan: 0,
                        dwFlags: KEYBD_EVENT_FLAGS(0),
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            },
            INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VK_C,
                        wScan: 0,
                        dwFlags: KEYBD_EVENT_FLAGS(0),
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            },
            INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VK_C,
                        wScan: 0,
                        dwFlags: KEYEVENTF_KEYUP,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            },
            INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VK_CONTROL,
                        wScan: 0,
                        dwFlags: KEYEVENTF_KEYUP,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            },
        ];
        SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
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
