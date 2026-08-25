#[cfg(test)]
use windows_sys::Win32::UI::Shell::{
    QUNS_APP, QUNS_BUSY, QUNS_NOT_PRESENT, QUNS_PRESENTATION_MODE, QUNS_QUIET_TIME,
    QUNS_RUNNING_D3D_FULL_SCREEN,
};
use windows_sys::Win32::{
    Foundation::RECT,
    Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST},
    UI::{
        Shell::{SHQueryUserNotificationState, QUNS_ACCEPTS_NOTIFICATIONS},
        WindowsAndMessaging::{GetForegroundWindow, GetWindowRect},
    },
};

use super::invitation::SystemNotificationSuitability;

pub fn current_system_suitability() -> SystemNotificationSuitability {
    let mut state = 0;
    // This reads only Windows notification suitability. It does not inspect a
    // process name, window title, keystroke, screen pixel, or work content.
    let result = unsafe { SHQueryUserNotificationState(&mut state) };
    if result < 0 {
        return SystemNotificationSuitability::Unknown;
    }
    if state != QUNS_ACCEPTS_NOTIFICATIONS {
        return SystemNotificationSuitability::Suppressed;
    }
    match foreground_covers_monitor() {
        Some(true) => SystemNotificationSuitability::Suppressed,
        Some(false) => SystemNotificationSuitability::AcceptsNotifications,
        None => SystemNotificationSuitability::Unknown,
    }
}

fn foreground_covers_monitor() -> Option<bool> {
    let foreground = unsafe { GetForegroundWindow() };
    if foreground.is_null() {
        return None;
    }
    let mut window_rect = RECT::default();
    if unsafe { GetWindowRect(foreground, &mut window_rect) } == 0 {
        return None;
    }
    let monitor = unsafe { MonitorFromWindow(foreground, MONITOR_DEFAULTTONEAREST) };
    if monitor.is_null() {
        return None;
    }
    let mut info = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        rcMonitor: RECT::default(),
        rcWork: RECT::default(),
        dwFlags: 0,
    };
    if unsafe { GetMonitorInfoW(monitor, &mut info) } == 0 {
        return None;
    }
    let tolerance = 2;
    Some(
        window_rect.left <= info.rcMonitor.left + tolerance
            && window_rect.top <= info.rcMonitor.top + tolerance
            && window_rect.right >= info.rcMonitor.right - tolerance
            && window_rect.bottom >= info.rcMonitor.bottom - tolerance,
    )
}

#[cfg(test)]
fn map_query_state(
    result: i32,
    state: i32,
    foreground_fullscreen: Option<bool>,
) -> SystemNotificationSuitability {
    if result < 0 {
        return SystemNotificationSuitability::Unknown;
    }
    match state {
        QUNS_ACCEPTS_NOTIFICATIONS => match foreground_fullscreen {
            Some(false) => SystemNotificationSuitability::AcceptsNotifications,
            Some(true) => SystemNotificationSuitability::Suppressed,
            None => SystemNotificationSuitability::Unknown,
        },
        QUNS_NOT_PRESENT
        | QUNS_BUSY
        | QUNS_RUNNING_D3D_FULL_SCREEN
        | QUNS_PRESENTATION_MODE
        | QUNS_QUIET_TIME
        | QUNS_APP => SystemNotificationSuitability::Suppressed,
        _ => SystemNotificationSuitability::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_windows_notification_state_is_fail_closed_except_explicit_acceptance() {
        assert_eq!(
            map_query_state(0, QUNS_ACCEPTS_NOTIFICATIONS, Some(false)),
            SystemNotificationSuitability::AcceptsNotifications
        );
        assert_eq!(
            map_query_state(0, QUNS_ACCEPTS_NOTIFICATIONS, Some(true)),
            SystemNotificationSuitability::Suppressed
        );
        assert_eq!(
            map_query_state(0, QUNS_ACCEPTS_NOTIFICATIONS, None),
            SystemNotificationSuitability::Unknown
        );
        for state in [
            QUNS_NOT_PRESENT,
            QUNS_BUSY,
            QUNS_RUNNING_D3D_FULL_SCREEN,
            QUNS_PRESENTATION_MODE,
            QUNS_QUIET_TIME,
            QUNS_APP,
        ] {
            assert_eq!(
                map_query_state(0, state, Some(false)),
                SystemNotificationSuitability::Suppressed
            );
        }
        assert_eq!(
            map_query_state(-1, QUNS_ACCEPTS_NOTIFICATIONS, Some(false)),
            SystemNotificationSuitability::Unknown
        );
        assert_eq!(
            map_query_state(0, 99, Some(false)),
            SystemNotificationSuitability::Unknown
        );
    }
}
