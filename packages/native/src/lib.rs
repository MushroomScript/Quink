#![deny(clippy::all)]

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{
  ErrorStrategy, ThreadsafeFunction, ThreadSafeCallContext, ThreadsafeFunctionCallMode,
};
use napi_derive::napi;

#[cfg(windows)]
mod windows_hook;

#[napi(object)]
pub struct SelectionEvent {
  pub text: String,
  pub x: i32,
  pub y: i32,
}

/// Register callback for selection events.
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

/// Grab selected text: simulate Ctrl+C, read clipboard, restore clipboard, return text + cursor position.
#[napi]
pub fn grab_selection() {
  #[cfg(windows)]
  windows_hook::grab_selection();
}
