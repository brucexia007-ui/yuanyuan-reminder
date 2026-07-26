use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

use crate::{models::CursorDirectionEvent, state::AppState};

#[cfg(windows)]
fn cursor_position() -> Option<(i32, i32)> {
    use windows_sys::Win32::{Foundation::POINT, UI::WindowsAndMessaging::GetCursorPos};
    let mut point = POINT { x: 0, y: 0 };
    // SAFETY: GetCursorPos writes to a valid POINT pointer for the duration of this call.
    let ok = unsafe { GetCursorPos(&mut point) };
    (ok != 0).then_some((point.x, point.y))
}

#[cfg(not(windows))]
fn cursor_position() -> Option<(i32, i32)> {
    None
}

pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut last_frame: Option<i32> = None;
        loop {
            tokio_sleep(Duration::from_millis(66)).await;
            let settings = {
                let state = app.state::<AppState>();
                let result = state.repository.lock().get_settings().ok();
                result
            };
            let Some(settings) = settings else {
                continue;
            };
            if !settings.cursor_follow || settings.click_through {
                continue;
            }
            let Some(window) = app.get_webview_window("pet") else {
                continue;
            };
            if !window.is_visible().unwrap_or(false) {
                continue;
            }
            let next_frame = match (
                cursor_position(),
                window.outer_position().ok(),
                window.outer_size().ok(),
            ) {
                (Some((cursor_x, cursor_y)), Some(position), Some(size)) => {
                    let center_x = position.x + size.width as i32 / 2;
                    let center_y = position.y + size.height as i32 / 2;
                    direction_frame(cursor_x - center_x, cursor_y - center_y)
                }
                _ => None,
            };
            if next_frame != last_frame {
                last_frame = next_frame;
                let _ = window.emit(
                    "cursor-direction-changed",
                    CursorDirectionEvent { frame: next_frame },
                );
            }
        }
    });
}

fn direction_frame(dx: i32, dy: i32) -> Option<i32> {
    let distance = f64::from(dx).hypot(f64::from(dy));
    if !(40.0..=480.0).contains(&distance) {
        return None;
    }
    let angle = f64::from(dx).atan2(-f64::from(dy));
    let step = std::f64::consts::TAU / 16.0;
    Some(((angle / step).round() as i32).rem_euclid(16))
}

async fn tokio_sleep(duration: Duration) {
    tauri::async_runtime::spawn_blocking(move || std::thread::sleep(duration))
        .await
        .ok();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_cardinal_directions() {
        assert_eq!(direction_frame(0, -100), Some(0));
        assert_eq!(direction_frame(100, 0), Some(4));
        assert_eq!(direction_frame(0, 100), Some(8));
        assert_eq!(direction_frame(-100, 0), Some(12));
    }

    #[test]
    fn respects_deadzone_and_maximum_distance() {
        assert_eq!(direction_frame(5, 5), None);
        assert_eq!(direction_frame(1000, 0), None);
    }
}
