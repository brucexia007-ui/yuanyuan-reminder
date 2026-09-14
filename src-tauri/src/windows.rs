use tauri::{
    menu::{CheckMenuItem, ContextMenu, Menu, MenuItem, PredefinedMenuItem, Submenu},
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, PhysicalSize,
};

use crate::{
    error::{AppError, AppResult},
    models::AppSettings,
    state::AppState,
};

const PET_SLEEP_TOGGLE_LABEL: &str = "立即睡觉/叫醒圆圆";

#[derive(Default)]
pub struct PanelDialogState(parking_lot::Mutex<PanelDialogElevation>);

#[derive(Default)]
struct PanelDialogElevation {
    depth: usize,
    original_topmost: bool,
}

impl PanelDialogElevation {
    fn enter(
        &mut self,
        read: impl FnOnce() -> AppResult<bool>,
        elevate: impl FnOnce() -> AppResult<()>,
    ) -> AppResult<()> {
        if self.depth == 0 {
            let original = read()?;
            elevate()?;
            self.original_topmost = original;
        }
        self.depth += 1;
        Ok(())
    }

    fn leave(&mut self) -> Option<bool> {
        if self.depth == 0 {
            return None;
        }
        self.depth -= 1;
        (self.depth == 0).then_some(self.original_topmost)
    }
}

/// An owned native picker must be above the separate topmost pet window,
/// including its transparent learning hit region. Elevate only its panel
/// owner for the dialog lifetime; never change saved pet settings or leases.
pub struct PanelDialogScope {
    app: AppHandle,
    panel: tauri::WebviewWindow,
}

impl PanelDialogScope {
    pub fn enter(app: &AppHandle) -> AppResult<Self> {
        let panel = app
            .get_webview_window("panel")
            .ok_or_else(|| AppError::Window("panel window is unavailable".into()))?;
        app.state::<PanelDialogState>().0.lock().enter(
            || {
                panel
                    .is_always_on_top()
                    .map_err(|e| AppError::Window(e.to_string()))
            },
            || {
                panel
                    .set_always_on_top(true)
                    .map_err(|e| AppError::Window(e.to_string()))
            },
        )?;
        Ok(Self {
            app: app.clone(),
            panel,
        })
    }
}

impl Drop for PanelDialogScope {
    fn drop(&mut self) {
        // Serialize restoration with another dialog opening at the same time.
        let state = self.app.state::<PanelDialogState>();
        let mut elevation = state.0.lock();
        if let Some(original) = elevation.leave() {
            if let Err(error) = self.panel.set_always_on_top(original) {
                tracing::warn!(error = %error, "native dialog panel order could not be restored");
            }
        }
    }
}

fn learning_quick_start_menu_label(visible: bool) -> &'static str {
    if visible {
        "关闭快捷按键"
    } else {
        "显示快捷按键"
    }
}

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

fn logical_size_in_physical(width: u32, height: u32, scale_factor: f64) -> (u32, u32) {
    (
        (width as f64 * scale_factor).round() as u32,
        (height as f64 * scale_factor).round() as u32,
    )
}

// A small display can have less usable height than the configured logical
// minimum at high DPI. Size limits must fit that display before positioning.
fn panel_dimensions(
    current: (u32, u32),
    scale: f64,
    work: DisplayBounds,
) -> ((u32, u32), (u32, u32), (u32, u32)) {
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    let minimum = logical_size_in_physical(360, 560, scale);
    let maximum = logical_size_in_physical(480, 760, scale);
    let preferred = logical_size_in_physical(390, 620, scale);
    let available = (work.width.max(1), work.height.max(1));
    let maximum = (maximum.0.min(available.0), maximum.1.min(available.1));
    let minimum = (minimum.0.min(maximum.0), minimum.1.min(maximum.1));
    let width = if current.0 < minimum.0 {
        preferred.0
    } else {
        current.0
    };
    let height = if current.1 < minimum.1 {
        preferred.1
    } else {
        current.1
    };
    (
        (
            width.clamp(minimum.0, maximum.0),
            height.clamp(minimum.1, maximum.1),
        ),
        minimum,
        maximum,
    )
}

fn fit_panel_on_monitor(panel: &tauri::WebviewWindow, monitor: &tauri::Monitor) -> AppResult<()> {
    let work = monitor.work_area();
    let display = DisplayBounds {
        x: work.position.x,
        y: work.position.y,
        width: work.size.width,
        height: work.size.height,
    };
    let current = panel
        .outer_size()
        .map_err(|e| AppError::Window(e.to_string()))?;
    let (size, minimum, maximum) = panel_dimensions(
        (current.width, current.height),
        monitor.scale_factor(),
        display,
    );
    // Drop the previous minimum before applying a smaller work area or a new
    // DPI range; the old minimum may exceed the new maximum (and vice versa).
    panel
        .set_min_size(None::<PhysicalSize<u32>>)
        .map_err(|e| AppError::Window(e.to_string()))?;
    panel
        .set_max_size(Some(PhysicalSize::new(maximum.0, maximum.1)))
        .map_err(|e| AppError::Window(e.to_string()))?;
    panel
        .set_min_size(Some(PhysicalSize::new(minimum.0, minimum.1)))
        .map_err(|e| AppError::Window(e.to_string()))?;
    if (current.width, current.height) != size {
        panel
            .set_size(PhysicalSize::new(size.0, size.1))
            .map_err(|e| AppError::Window(e.to_string()))?;
    }
    let pos = panel
        .outer_position()
        .map_err(|e| AppError::Window(e.to_string()))?;
    let (x, y) = clamp_to_display(pos.x, pos.y, size.0, size.1, display);
    panel
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|e| AppError::Window(e.to_string()))?;
    Ok(())
}

pub fn fit_panel_to_current_monitor(panel: &tauri::WebviewWindow) -> AppResult<()> {
    if let Some(monitor) = panel
        .current_monitor()
        .map_err(|e| AppError::Window(e.to_string()))?
    {
        fit_panel_on_monitor(panel, &monitor)?;
    }
    Ok(())
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

fn panel_route_allowed(route: &str) -> bool {
    matches!(
        route,
        "today"
            | "taskwatch"
            | "focus"
            | "care"
            | "history"
            | "manage"
            | "add"
            | "settings"
            | "mypet"
    ) || (cfg!(feature = "learning") && route == "learning")
}

pub fn show_task_panel(app: &AppHandle, route: &str) -> AppResult<()> {
    if !panel_route_allowed(route) {
        return Err(AppError::Validation("panel route is unsupported".into()));
    }
    let panel = app
        .get_webview_window("panel")
        .ok_or_else(|| AppError::Window("panel window is unavailable".into()))?;

    if let Some(pet) = app.get_webview_window("pet") {
        if let Some(monitor) = pet
            .current_monitor()
            .map_err(|e| AppError::Window(e.to_string()))?
        {
            fit_panel_on_monitor(&panel, &monitor)?;
        }
        if let (Ok(pet_pos), Ok(pet_size), Ok(panel_size)) =
            (pet.outer_position(), pet.outer_size(), panel.outer_size())
        {
            let mut x = pet_pos.x - panel_size.width as i32 - 12;
            let mut y = pet_pos.y + pet_size.height as i32 - panel_size.height as i32;
            if let Ok(Some(monitor)) = pet.current_monitor() {
                let work_area = monitor.work_area();
                let work_pos = &work_area.position;
                let work_size = &work_area.size;
                if x < work_pos.x {
                    x = pet_pos.x + pet_size.width as i32 + 12;
                }
                (x, y) = clamp_to_display(
                    x,
                    y,
                    panel_size.width,
                    panel_size.height,
                    DisplayBounds {
                        x: work_pos.x,
                        y: work_pos.y,
                        width: work_size.width,
                        height: work_size.height,
                    },
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
    let scale_factor = pet
        .scale_factor()
        .map_err(|error| AppError::Window(error.to_string()))?;
    let (physical_width, physical_height) =
        logical_size_in_physical(logical_width, logical_height, scale_factor);
    if let (Some(x), Some(y)) = (settings.pet_x, settings.pet_y) {
        let displays = pet
            .available_monitors()
            .map_err(|error| AppError::Window(error.to_string()))?
            .into_iter()
            .map(|monitor| {
                let work_area = monitor.work_area();
                DisplayBounds {
                    x: work_area.position.x,
                    y: work_area.position.y,
                    width: work_area.size.width,
                    height: work_area.size.height,
                }
            })
            .collect::<Vec<_>>();
        let primary = pet
            .primary_monitor()
            .map_err(|error| AppError::Window(error.to_string()))?
            .map(|monitor| {
                let work_area = monitor.work_area();
                DisplayBounds {
                    x: work_area.position.x,
                    y: work_area.position.y,
                    width: work_area.size.width,
                    height: work_area.size.height,
                }
            });
        let (visible_x, visible_y) = visible_position(
            x,
            y,
            physical_width,
            physical_height,
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
    let pet_name = crate::pet_commands::current_name(app);
    let sleep_label = PET_SLEEP_TOGGLE_LABEL.replace("圆圆", &pet_name);
    let sleep = MenuItem::with_id(app, "pet-sleep", sleep_label, true, None::<&str>)
        .map_err(|error| AppError::Window(error.to_string()))?;
    let scene_rest_active = app.state::<AppState>().scene_rest.lock().is_some();
    let rest_5 = MenuItem::with_id(app, "pet-rest-5", "5 分钟", true, None::<&str>)
        .map_err(|error| AppError::Window(error.to_string()))?;
    let rest_10 = MenuItem::with_id(app, "pet-rest-10", "10 分钟", true, None::<&str>)
        .map_err(|error| AppError::Window(error.to_string()))?;
    let rest_20 = MenuItem::with_id(app, "pet-rest-20", "20 分钟", true, None::<&str>)
        .map_err(|error| AppError::Window(error.to_string()))?;
    let rest_stop = MenuItem::with_id(
        app,
        "pet-rest-stop",
        "提前结束",
        scene_rest_active,
        None::<&str>,
    )
    .map_err(|error| AppError::Window(error.to_string()))?;
    let rest = Submenu::with_items(
        app,
        "休息一下",
        true,
        &[&rest_5, &rest_10, &rest_20, &rest_stop],
    )
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
    let learning_quick_start = CheckMenuItem::with_id(
        app,
        "pet-learning-quick-start-visible",
        learning_quick_start_menu_label(settings.learning_quick_start_visible),
        true,
        settings.learning_quick_start_visible,
        None::<&str>,
    )
    .map_err(|error| AppError::Window(error.to_string()))?;
    let settings_item = MenuItem::with_id(app, "pet-settings", "设置", true, None::<&str>)
        .map_err(|error| AppError::Window(error.to_string()))?;
    let my_pet = MenuItem::with_id(app, "pet-my-pet", "我的宠物", true, None::<&str>)
        .map_err(|error| AppError::Window(error.to_string()))?;
    let hide = MenuItem::with_id(
        app,
        "pet-hide",
        format!("隐藏{pet_name}"),
        true,
        None::<&str>,
    )
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
            &rest,
            &separator,
            &always,
            &click_through,
            &learning_quick_start,
            &settings_item,
            &my_pet,
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
    #[test]
    fn high_dpi_panel_fits_small_work_area_without_invalid_position_bounds() {
        let work = super::DisplayBounds {
            x: -1024,
            y: 40,
            width: 1024,
            height: 708,
        };
        for scale in [1.0, 1.25, 1.5, 2.0] {
            let current = super::logical_size_in_physical(390, 620, scale);
            let (size, minimum, maximum) = super::panel_dimensions(current, scale, work);
            assert!(size.0 <= work.width && size.1 <= work.height);
            assert!(minimum.0 <= size.0 && minimum.1 <= size.1);
            assert!(maximum.0 >= size.0 && maximum.1 >= size.1);
            let (x, y) = super::clamp_to_display(100, -800, size.0, size.1, work);
            assert!(x >= work.x && y >= work.y);
            assert!(x + size.0 as i32 <= work.x + work.width as i32);
            assert!(y + size.1 as i32 <= work.y + work.height as i32);
        }
        let (size, _, _) = super::panel_dimensions((488, 775), 1.25, work);
        assert_eq!(size, (488, 708));
        // Positioning remains safe even if Windows reports a stale oversized
        // native size while processing the resize request.
        assert_eq!(super::clamp_to_display(0, 0, 488, 775, work), (-488, 40));
    }

    #[test]
    fn live_scale_change_restores_readable_panel_width_and_preserves_user_resize() {
        let work = super::DisplayBounds {
            x: 0,
            y: 0,
            width: 1920,
            height: 1032,
        };
        assert_eq!(
            super::panel_dimensions((390, 620), 1.25, work).0,
            (488, 775)
        );
        assert_eq!(super::panel_dimensions((390, 620), 1.5, work).0, (585, 930));
        assert_eq!(super::panel_dimensions((460, 700), 1.0, work).0, (460, 700));
        let tiny = super::DisplayBounds {
            width: 300,
            height: 400,
            ..work
        };
        assert_eq!(super::panel_dimensions((390, 620), 1.5, tiny).0, (300, 400));
    }

    #[test]
    fn dialog_scope_restores_original_panel_order_only_after_last_close() {
        for original in [false, true] {
            let mut state = super::PanelDialogElevation::default();
            state.enter(|| Ok(original), || Ok(())).unwrap();
            state
                .enter(
                    || panic!("nested scope cannot replace the baseline"),
                    || panic!("already elevated"),
                )
                .unwrap();
            assert_eq!(state.leave(), None);
            assert_eq!(state.leave(), Some(original));
            assert_eq!(state.leave(), None);
            state.enter(|| Ok(!original), || Ok(())).unwrap();
            assert_eq!(state.leave(), Some(!original));
        }
    }

    #[test]
    fn failed_dialog_elevation_does_not_leave_a_phantom_scope() {
        let mut state = super::PanelDialogElevation::default();
        assert!(state
            .enter(
                || Err(super::AppError::Window("missing".into())),
                || panic!("no window")
            )
            .is_err());
        assert_eq!(state.leave(), None);
        assert!(state
            .enter(
                || Ok(false),
                || Err(super::AppError::Window("closed".into()))
            )
            .is_err());
        assert_eq!(state.leave(), None);
        state.enter(|| Ok(false), || Ok(())).unwrap();
        assert_eq!(state.leave(), Some(false));
    }

    #[test]
    fn my_pet_native_route_is_available_with_or_without_learning() {
        for route in [
            "today",
            "taskwatch",
            "focus",
            "care",
            "history",
            "manage",
            "add",
            "settings",
            "mypet",
        ] {
            assert!(super::panel_route_allowed(route), "{route}");
        }
        assert_eq!(
            super::panel_route_allowed("learning"),
            cfg!(feature = "learning")
        );
        for route in ["", "my-pet", "http://example.invalid", "../mypet"] {
            assert!(!super::panel_route_allowed(route));
        }
    }
    use super::{
        learning_quick_start_menu_label, logical_size_in_physical, visible_position, DisplayBounds,
        PET_SLEEP_TOGGLE_LABEL,
    };

    #[test]
    fn learning_quick_start_menu_uses_the_action_for_the_saved_visibility() {
        assert_eq!(learning_quick_start_menu_label(true), "关闭快捷按键");
        assert_eq!(learning_quick_start_menu_label(false), "显示快捷按键");
    }

    #[test]
    fn sleep_toggle_menu_uses_one_unambiguous_label() {
        assert_eq!(PET_SLEEP_TOGGLE_LABEL, "立即睡觉/叫醒圆圆");
    }

    #[test]
    fn converts_logical_pet_size_at_high_dpi() {
        assert_eq!(logical_size_in_physical(348, 375, 1.5), (522, 563));
    }

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
    fn clamps_pet_above_the_taskbar_work_area() {
        let work_area = DisplayBounds {
            x: 0,
            y: 0,
            width: 2560,
            height: 1392,
        };

        assert_eq!(
            visible_position(77, 1280, 522, 563, &[work_area], Some(work_area)),
            (77, 829)
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
