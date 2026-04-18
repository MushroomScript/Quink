#![deny(clippy::all)]

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{
  ErrorStrategy, ThreadSafeCallContext, ThreadsafeFunction,
};
use napi_derive::napi;

#[cfg(windows)]
mod windows_hook;
#[cfg(windows)]
mod uia;

#[napi(object)]
pub struct SelectionEvent {
  pub text: String,
  pub x: i32,
  pub y: i32,
}

/// 注册剪贴板 fallback 成功时的回调。
#[napi]
pub fn on_selection(callback: JsFunction) -> Result<()> {
  let tsfn: ThreadsafeFunction<SelectionEvent, ErrorStrategy::Fatal> =
    callback.create_threadsafe_function(0, |ctx: ThreadSafeCallContext<SelectionEvent>| {
      Ok(vec![ctx.value])
    })?;

  #[cfg(windows)]
  windows_hook::set_callback(tsfn);

  Ok(())
}

/// 剪贴板 fallback:模拟 Ctrl+C 读剪贴板,恢复旧剪贴板,回调返回结果。
#[napi]
pub fn grab_selection() {
  #[cfg(windows)]
  windows_hook::grab_selection();
}

#[napi(object)]
pub struct UiaSelection {
  pub text: String,
  pub x: i32,
  pub y: i32,
  /// 选中文本所在控件的原生窗口句柄(用于跟 Electron 自身窗口比对,跳过自触发)
  pub hwnd: i64,
}

/// UIA 无感读取:不模拟按键,不碰剪贴板,直接从焦点控件的 TextPattern 读 selection。
#[napi]
pub async fn read_selection_uia() -> Option<UiaSelection> {
  tokio::task::spawn_blocking(|| {
    #[cfg(windows)]
    {
      uia::grab_selection_via_uia().map(|r| UiaSelection {
        text: r.text,
        x: r.x,
        y: r.y,
        hwnd: r.hwnd,
      })
    }
    #[cfg(not(windows))]
    {
      None
    }
  })
  .await
  .ok()
  .flatten()
}

/// 返回当前前台窗口(焦点窗口)的原生 HWND。
/// JS 侧可拿 Electron BrowserWindow 的 nativeHandle 跟它比,判断是否 Quink 自己的窗口。
#[napi]
pub fn get_foreground_window() -> i64 {
  #[cfg(windows)]
  {
    windows_hook::get_foreground_hwnd()
  }
  #[cfg(not(windows))]
  {
    0
  }
}
