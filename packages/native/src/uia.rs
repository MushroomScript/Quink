// UIA 读选中文本 + 返回所属窗口 HWND
use windows::Win32::Foundation::*;
use windows::Win32::System::Com::*;
use windows::Win32::UI::Accessibility::*;
use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
use windows::core::*;

pub struct UiaResult {
    pub text: String,
    pub x: i32,
    pub y: i32,
    pub hwnd: i64,
}

pub fn grab_selection_via_uia() -> Option<UiaResult> {
    unsafe {
        // 每个线程 init COM 一次(已 init 会返回 RPC_E_CHANGED_MODE,忽略)
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);

        let automation: IUIAutomation =
            CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok()?;

        let focused = automation.GetFocusedElement().ok()?;

        // element 所属窗口 hwnd
        let hwnd: i64 = focused.CurrentNativeWindowHandle().ok().map(|h| h.0 as i64).unwrap_or(0);

        // 查 TextPattern
        let pattern_obj = focused.GetCurrentPattern(UIA_TextPatternId).ok()?;
        let text_pattern: IUIAutomationTextPattern = pattern_obj.cast().ok()?;

        let selection = text_pattern.GetSelection().ok()?;
        let count = selection.Length().ok()?;
        if count == 0 {
            return None;
        }

        let mut all_text = String::new();
        for i in 0..count {
            if let Ok(range) = selection.GetElement(i) {
                if let Ok(bstr) = range.GetText(10000) {
                    let s = bstr.to_string();
                    if !all_text.is_empty() {
                        all_text.push('\n');
                    }
                    all_text.push_str(&s);
                }
            }
        }

        let text = all_text.trim().to_string();
        if text.is_empty() {
            return None;
        }

        let (x, y) = get_cursor_pos();
        Some(UiaResult { text, x, y, hwnd })
    }
}

fn get_cursor_pos() -> (i32, i32) {
    unsafe {
        let mut point = POINT::default();
        let _ = GetCursorPos(&mut point);
        (point.x, point.y)
    }
}
