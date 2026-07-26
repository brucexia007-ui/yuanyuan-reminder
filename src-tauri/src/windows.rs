use tauri::{
    menu::{CheckMenuItem, ContextMenu, Menu, MenuItem, PredefinedMenuItem},
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition,
};

use crate::{
    error::{AppError, AppResult},
    models::AppSettings,
    state::AppState,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct DisplayBounds {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

fn overlap_area(x: i32, y: i32, width: u32, height: u32, display: DisplayBounds) -> i64 {
    let left = x.max(display.x);
    let top = y.max(display.y);
    let right = (x + width as i32).min(display.x + display.width as i32);
    let bottom = (y + height as i32).min(display.y + display.height as i32);
    i64::from((right - left).max(0)) * i64::from((bottom - top).max(0))
}

fn clamp_to_display(x: i32, y: i32, width: u32, height: u32, display: DisplayBounds) -> (i32, i32) {
    let max_x = display.x + display.width.saturating_sub(width) as i32;
    let max_y = display.y + display.height.saturating_sub(height) as i32;
    (x.clamp(display.x, max_x), y.clamp(display.y, max_y))
}

fn visible_position(
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    displays: &[DisplayBounds],
    primary: Option<DisplayBounds>,
) -> (i32, i32) {
    let best_display = displays
        .iter()
        .copied()
        .max_by_key(|display| overlap_area(x, y, width, height, *display))
        .filter(|display| overlap_area(x, y, width, height, *display) > 0)
        .or(primary)
        .or_else(|| displays.first().copied());

    best_display
        .map(|display| clamp_to_display(x, y, width, height, display))
        .unwrap_or((x, y))
}

#[cfg(windows)]
pub fn lock_workstation() -> AppResult<()> {
    use windows_sys::Win32::System::Shutdown::LockWorkStation;

    // SAFETY: LockWorkStation takes no pointers and only requests the current
    // interactive Windows session to show its secure lock screen.
    let locked = unsafe { LockWorkStation() };
    if locked == 0 {
        return Err(AppError::Window(
            std::io::Error::last_os_error().to_string(),
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn lock_workstation() -> AppResult<()> {
    Err(AppError::Window(
        "workstation locking is only available on Windows".into(),
    ))
}

#[cfg(windows)]
pub fn wake_display() {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SendMessageW, HWND_BROADCAST, SC_MONITORPOWER, WM_SYSCOMMAND,
    };

    // SAFETY: This is the documented broadcast used to request that Windows
    // power the display back on. It does not and cannot unlock the session.
    unsafe {
        SendMessageW(
            HWND_BROADCAST,
            WM_SYSCOMMAND,
            SC_MONITORPOWER as usize,
            -1isize,
        );
    }
}

#[cfg(not(windows))]
pub fn wake_display() {}

pub fn show_task_panel(app: &AppHandle, route: &str) -> AppResult<()> {
    let panel = app
        .get_webview_window("panel")
        .ok_or_else(|| AppError::Window("panel window is unavailable".into()))?;

    if let Some(pet) = app.get_webview_window("pet") {
        if let (Ok(pet_pos), Ok(pet_size), Ok(panel_size)) =
            (pet.outer_position(), pet.outer_size(), panel.outer_size())
        {
            let mut x = pet_pos.x - panel_size.width as i32 - 12;
            let mut y = pet_pos.y + pet_size.height as i32 - panel_size.height as i32;
            if let Ok(Some(monitor)) = pet.current_monitor() {
                let work_pos = monitor.position();
                let work_size = monitor.size();
                if x < work_pos.x {
                    x = pet_pos.x + pet_size.width as i32 + 12;
                }
                x = x.clamp(
                    work_pos.x,
                    work_pos.x + work_size.width as i32 - panel_size.width as i32,
                );
                y = y.clamp(
                    work_pos.y,
                    work_pos.y + work_size.height as i32 - panel_size.height as i32,
                );
            }
            let _ = panel.set_position(PhysicalPosition::new(x, y));
        }
    }

    panel
        .show()
        .map_err(|error| AppError::Window(error.to_string()))?;
    panel
        .set_focus()
        .map_err(|error| AppError::Window(error.to_string()))?;
    panel
        .emit("panel-route", serde_json::json!({ "route": route }))
        .map_err(|error| AppError::Window(error.to_string()))?;
    Ok(())
}

pub fn apply_settings(app: &AppHandle, settings: &mut AppSettings) -> AppResult<()> {
    let pet = app
        .get_webview_window("pet")
        .ok_or_else(|| AppError::Window("pet window is unavailable".into()))?;
    pet.set_always_on_top(settings.always_on_top)
        .map_err(|error| AppError::Window(error.to_string()))?;
    pet.set_ignore_cursor_events(settings.click_through)
        .map_err(|error| AppError::Window(error.to_string()))?;
    let logical_width = settings.pet_width + 28;
    let logical_height = ((settings.pet_width as f64 * 208.0 / 192.0).round() as u32) + 28;
    pet.set_size(LogicalSize::new(logical_width, logical_height))
        .map_err(|error| AppError::Window(error.to_string()))?;
    let physical_size = pet
        .outer_size()
        .map_err(|error| AppError::Window(error.to_string()))?;
    if let (Some(x), Some(y)) = (settings.pet_x, settings.pet_y) {
        let displays = pet
            .available_monitors()
            .map_err(|error| AppError::Window(error.to_string()))?
            .into_iter()
            .map(|monitor| DisplayBounds {
                x: monitor.position().x,
                y: monitor.position().y,
                width: monitor.size().width,
                height: monitor.size().height,
            })
            .collect::<Vec<_>>();
        let primary = pet
            .primary_monitor()
            .map_err(|error| AppError::Window(error.to_string()))?
            .map(|monitor| DisplayBounds {
                x: monitor.position().x,
                y: monitor.position().y,
                width: monitor.size().width,
                height: monitor.size().height,
            });
        let (visible_x, visible_y) = visible_position(
            x,
            y,
            physical_size.width,
            physical_size.height,
            displays.as_slice(),
            primary,
        );
        settings.pet_x = Some(visible_x);
        settings.pet_y = Some(visible_y);
        pet.set_position(PhysicalPosition::new(visible_x, visible_y))
            .map_err(|error| AppError::Window(error.to_string()))?;
    }
    Ok(())
}

pub fn show_pet_context_menu(app: &AppHandle) -> AppResult<()> {
    let pet = app
        .get_webview_window("pet")
        .ok_or_else(|| AppError::Window("pet window is unavailable".into()))?;
    let settings = app.state::<AppState>().repository.lock().get_settings()?;

    let open = MenuItem::with_id(app, "pet-open-today", "打开今日任务", true, None::<&str>)
        .map_err(|error| AppError::Window(error.to_string()))?;
    let water = MenuItem::with_id(app, "pet-record-water", "记录一次喝水", true, None::<&str>)
        .map_err(|error| AppError::Window(error.to_string()))?;
    let add = MenuItem::with_id(app, "pet-add-task", "新建任务", true, None::<&str>)
        .map_err(|error| AppError::Window(error.to_string()))?;
    let pause = MenuItem::with_id(app, "pet-pause", "暂停提醒 30 分钟", true, None::<&str>)
        .map_err(|error| AppError::Window(error.to_string()))?;
    let sleep = MenuItem::with_id(app, "pet-sleep", "立即睡觉 / 叫醒圆圆", true, None::<&str>)
        .map_err(|error| AppError::Window(error.to_string()))?;
    let always = CheckMenuItem::with_id(
        app,
        "pet-always-on-top",
        "总在最前",
        true,
        settings.always_on_top,
        None::<&str>,
    )
    .map_err(|error| AppError::Window(error.to_string()))?;
    let click_through = CheckMenuItem::with_id(
        app,
        "pet-click-through",
        "鼠标穿透",
        true,
        settings.click_through,
        None::<&str>,
    )
    .map_err(|error| AppError::Window(error.to_string()))?;
    let settings_item = MenuItem::with_id(app, "pet-settings", "设置", true, None::<&str>)
        .map_err(|error| AppError::Window(error.to_string()))?;
    let hide = MenuItem::with_id(app, "pet-hide", "隐藏圆圆", true, None::<&str>)
        .map_err(|error| AppError::Window(error.to_string()))?;
    let quit = MenuItem::with_id(app, "pet-quit", "退出圆圆提醒工具", true, None::<&str>)
        .map_err(|error| AppError::Window(error.to_string()))?;
    let separator =
        PredefinedMenuItem::separator(app).map_err(|error| AppError::Window(error.to_string()))?;

    let menu = Menu::with_items(
        app,
        &[
            &open,
            &water,
            &add,
            &pause,
            &sleep,
            &separator,
            &always,
            &click_through,
            &settings_item,
            &hide,
            &quit,
        ],
    )
    .map_err(|error| AppError::Window(error.to_string()))?;
    menu.popup(pet.as_ref().window().clone())
        .map_err(|error| AppError::Window(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::{visible_position, DisplayBounds};

    #[test]
    fn keeps_position_on_the_selected_monitor() {
        let displays = [
            DisplayBounds {
                x: 0,
                y: 0,
                width: 1920,
                height: 1080,
            },
            DisplayBounds {
                x: 1920,
                y: 0,
                width: 2560,
                height: 1440,
            },
        ];

        assert_eq!(
            visible_position(2200, 800, 220, 236, &displays, Some(displays[0])),
            (2200, 800)
        );
    }

    #[test]
    fn clamps_partially_offscreen_position() {
        let display = DisplayBounds {
            x: 0,
            y: 0,
            width: 2560,
            height: 1440,
        };

        assert_eq!(
            visible_position(2500, 1380, 220, 236, &[display], Some(display)),
            (2340, 1204)
        );
    }

    #[test]
    fn restores_fully_offscreen_position_to_primary_monitor() {
        let display = DisplayBounds {
            x: 0,
            y: 0,
            width: 2560,
            height: 1440,
        };

        assert_eq!(
            visible_position(2591, 1063, 220, 236, &[display], Some(display)),
            (2340, 1063)
        );
    }
}
