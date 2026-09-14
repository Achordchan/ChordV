//! Native window transitions keep animation timing independent of WebView work.
use tauri::WebviewWindow;

const LOGIN_SIZE: (f64, f64) = (660.0, 440.0);
const MAIN_SIZE: (f64, f64) = (980.0, 700.0);

#[derive(Default)]
pub struct WindowTransitionState(tokio::sync::Mutex<()>);

#[derive(Clone, Copy, Debug, PartialEq)]
struct Frame { x: f64, y: f64, width: f64, height: f64 }

fn centered_frame(from: Frame, size: (f64, f64), bounds: Option<Frame>) -> Frame {
    let mut target = Frame {
        x: from.x + (from.width - size.0) / 2.0,
        y: from.y + (from.height - size.1) / 2.0,
        width: size.0,
        height: size.1,
    };
    if let Some(bounds) = bounds {
        target.x = target.x.min(bounds.x + bounds.width - target.width).max(bounds.x);
        target.y = target.y.min(bounds.y + bounds.height - target.height).max(bounds.y);
    }
    target
}

#[tauri::command]
pub async fn transition_main_window(
    window: WebviewWindow,
    state: tauri::State<'_, WindowTransitionState>,
    signed_in: bool,
    animate: bool,
) -> Result<(), String> {
    if window.label() != "main" { return Err("Only the main window can change layout".into()); }
    let _guard = state.0.lock().await;
    let size = if signed_in { MAIN_SIZE } else { LOGIN_SIZE };
    transition(window, size, animate).await
}

#[cfg(target_os = "macos")]
async fn transition(window: WebviewWindow, size: (f64, f64), animate: bool) -> Result<(), String> {
    use objc2_app_kit::NSWindow;
    use objc2_foundation::{NSPoint, NSRect, NSSize};
    let (send, receive) = tokio::sync::oneshot::channel();
    let handle = window.clone();
    window.run_on_main_thread(move || {
        let result = (|| {
            let pointer = handle.ns_window().map_err(|e| e.to_string())?;
            // Tauri owns this live NSWindow. Access is confined to the main thread,
            // and the retained WebviewWindow handle lives through the whole resize.
            let native = unsafe { &*(pointer as *const NSWindow) };
            let from = native.frame();
            let requested = native.frameRectForContentRect(NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(size.0, size.1)));
            let bounds = native.screen().map(|screen| {
                let rect = screen.visibleFrame();
                Frame { x: rect.origin.x, y: rect.origin.y, width: rect.size.width, height: rect.size.height }
            });
            let target = centered_frame(
                Frame { x: from.origin.x, y: from.origin.y, width: from.size.width, height: from.size.height },
                (requested.size.width, requested.size.height), bounds,
            );
            native.setContentMinSize(NSSize::new(LOGIN_SIZE.0, LOGIN_SIZE.1));
            // AppKit changes position and size atomically and supplies its own
            // resize animation, rather than two asynchronous JS IPC calls per frame.
            native.setFrame_display_animate(
                NSRect::new(NSPoint::new(target.x, target.y), NSSize::new(target.width, target.height)),
                true, animate && (from.size != requested.size),
            );
            native.setContentMinSize(NSSize::new(size.0, size.1));
            Ok(())
        })();
        let _ = send.send(result);
    }).map_err(|e| e.to_string())?;
    receive.await.map_err(|e| e.to_string())?
}

#[cfg(target_os = "windows")]
async fn transition(window: WebviewWindow, size: (f64, f64), animate: bool) -> Result<(), String> {
    use std::time::{Duration, Instant};
    let inner = window.inner_size().map_err(|e| e.to_string())?;
    let outer = window.outer_size().map_err(|e| e.to_string())?;
    let position = window.outer_position().map_err(|e| e.to_string())?;
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let bounds = window.current_monitor().map_err(|e| e.to_string())?.map(|monitor| {
        let area = monitor.work_area();
        Frame { x: area.position.x as f64, y: area.position.y as f64, width: area.size.width as f64, height: area.size.height as f64 }
    });
    let from = Frame { x: position.x as f64, y: position.y as f64, width: outer.width as f64, height: outer.height as f64 };
    let target = centered_frame(from, (
        size.0 * scale + (outer.width - inner.width) as f64,
        size.1 * scale + (outer.height - inner.height) as f64,
    ), bounds);
    window.set_min_size(Some(tauri::LogicalSize::new(LOGIN_SIZE.0, LOGIN_SIZE.1))).map_err(|e| e.to_string())?;
    let duration = if animate && (from.width != target.width || from.height != target.height) { 0.24 } else { 0.0 };
    let started = Instant::now();
    loop {
        let progress = if duration > 0.0 { (started.elapsed().as_secs_f64() / duration).min(1.0) } else { 1.0 };
        let eased = 1.0 - (1.0 - progress).powi(3);
        let mix = |a: f64, b: f64| a + (b - a) * eased;
        set_windows_frame(&window, Frame { x: mix(from.x, target.x), y: mix(from.y, target.y), width: mix(from.width, target.width), height: mix(from.height, target.height) }).await?;
        if progress >= 1.0 { break; }
        tokio::time::sleep(Duration::from_millis(16)).await;
    }
    window.set_min_size(Some(tauri::LogicalSize::new(size.0, size.1))).map_err(|e| e.to_string())
}

#[cfg(target_os = "windows")]
async fn set_windows_frame(window: &WebviewWindow, frame: Frame) -> Result<(), String> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{SetWindowPos, SWP_NOACTIVATE, SWP_NOZORDER};
    let (send, receive) = tokio::sync::oneshot::channel();
    let handle = window.clone();
    window.run_on_main_thread(move || {
        let result = (|| {
            let hwnd = handle.hwnd().map_err(|e| e.to_string())?;
            // Only our own HWND is changed; do not activate or reorder windows.
            let ok = unsafe { SetWindowPos(hwnd.0 as _, std::ptr::null_mut(), frame.x.round() as i32, frame.y.round() as i32, frame.width.round() as i32, frame.height.round() as i32, SWP_NOACTIVATE | SWP_NOZORDER) };
            if ok == 0 { return Err(std::io::Error::last_os_error().to_string()); }
            Ok(())
        })();
        let _ = send.send(result);
    }).map_err(|e| e.to_string())?;
    receive.await.map_err(|e| e.to_string())?
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
async fn transition(_window: WebviewWindow, _size: (f64, f64), _animate: bool) -> Result<(), String> { Ok(()) }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn transition_keeps_center_in_both_directions() {
        let small = Frame { x: 500.0, y: 300.0, width: LOGIN_SIZE.0, height: LOGIN_SIZE.1 };
        let big = centered_frame(small, MAIN_SIZE, None);
        assert_eq!(big.x + big.width / 2.0, small.x + small.width / 2.0);
        assert_eq!(big.y + big.height / 2.0, small.y + small.height / 2.0);
        assert_eq!(centered_frame(big, LOGIN_SIZE, None), small);
    }
    #[test]
    fn transition_stays_on_negative_coordinate_monitor() {
        let bounds = Frame { x: -1920.0, y: 0.0, width: 1920.0, height: 1080.0 };
        let target = centered_frame(Frame { x: -1900.0, y: 10.0, width: 660.0, height: 440.0 }, MAIN_SIZE, Some(bounds));
        assert!(target.x >= bounds.x && target.x + target.width <= 0.0);
        assert!(target.y >= 0.0 && target.y + target.height <= bounds.height);
    }
    #[test]
    fn startup_config_matches_compact_window() {
        let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(config["app"]["windows"][0]["width"].as_f64(), Some(LOGIN_SIZE.0));
        assert_eq!(config["app"]["windows"][0]["height"].as_f64(), Some(LOGIN_SIZE.1));
    }
}
