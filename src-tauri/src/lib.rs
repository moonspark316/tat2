mod storage;

use std::sync::Mutex;
use std::time::Duration;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, PhysicalPosition, WindowEvent,
};

/// Remembers the horizontal center (physical px) of the last tray click so the
/// popover can re-anchor under the menu-bar icon even when opened via shortcut.
#[derive(Default)]
struct TrayAnchor(Mutex<Option<f64>>);

/// When pinned, the popover does NOT auto-hide on blur (reference mode).
#[derive(Default)]
struct Pinned(Mutex<bool>);

/// The currently registered global-shortcut accelerator (for safe replacement).
#[derive(Default)]
struct CurrentShortcut(Mutex<Option<String>>);

const WINDOW_LABEL: &str = "main";
/// Event the frontend listens for to flush pending writes before the app quits.
const BEFORE_QUIT_EVENT: &str = "tat2://before-quit";

/// Place the popover just under the menu bar on the display the user is
/// currently on.
///
/// Multi-display anchoring (all coordinates are global physical px, top-left
/// origin — the space `set_position` uses):
///
/// - The **target monitor** is the one under the OS cursor. When the user
///   clicks the tray icon the cursor sits over that display's menu bar, and
///   when summoning via the global shortcut it sits on whatever display the
///   user is working on — so this single signal anchors us on the right screen
///   in both cases (and when the menu bar lives on a non-primary display).
///   Falls back to the window's current/primary monitor.
/// - The **x anchor** centers under the tray icon when the last tray click lies
///   on the target monitor; otherwise it centers on the cursor, so a shortcut
///   summon still appears under the user's pointer rather than on a stale
///   display. Final fallback is the monitor's top-right corner.
///
/// The result is clamped to keep the window fully on the target monitor.
fn position_window(app: &tauri::AppHandle) {
    let Some(win) = app.get_webview_window(WINDOW_LABEL) else {
        return;
    };
    let anchor_x = *app.state::<TrayAnchor>().0.lock().unwrap();
    let cursor = app.cursor_position().ok();

    // Pick the display the user is on (cursor), else where the window already
    // is, else the primary display.
    let monitor = cursor
        .and_then(|c| app.monitor_from_point(c.x, c.y).ok().flatten())
        .or_else(|| win.current_monitor().ok().flatten())
        .or_else(|| win.primary_monitor().ok().flatten());

    let win_w = win.outer_size().map(|s| s.width as f64).unwrap_or(420.0);

    let (mon_x, mon_y, mon_w, scale) = match &monitor {
        Some(m) => (
            m.position().x as f64,
            m.position().y as f64,
            m.size().width as f64,
            m.scale_factor(),
        ),
        None => (0.0, 0.0, 1440.0, 1.0),
    };

    // Only trust the tray-click x if it falls on the chosen monitor; otherwise
    // it belongs to a different display (stale shortcut summon).
    let anchor_on_monitor = anchor_x.filter(|cx| *cx >= mon_x && *cx <= mon_x + mon_w);
    let cursor_x_on_monitor = cursor
        .map(|c| c.x)
        .filter(|cx| *cx >= mon_x && *cx <= mon_x + mon_w);

    // A few px below the macOS menu bar / Windows tray area.
    let y = mon_y + 34.0 * scale;
    let x = match anchor_on_monitor.or(cursor_x_on_monitor) {
        Some(cx) => cx - win_w / 2.0,
        None => mon_x + mon_w - win_w - 12.0 * scale,
    };
    // Keep the window fully on-screen.
    let min_x = mon_x + 4.0;
    let max_x = (mon_x + mon_w - win_w - 4.0).max(min_x);
    let x = x.clamp(min_x, max_x);

    let _ = win.set_position(PhysicalPosition::new(x as i32, y as i32));
}

/// Force the popover to the front of the **active Space** and grab keyboard
/// focus, even though Tat2 runs as an `Accessory` app (no dock icon).
///
/// Why this is needed: an `Accessory` app is not the active application, so
/// `NSWindow::makeKeyAndOrderFront:` (what Tauri's `set_focus` issues) can order
/// the window forward without it ever becoming *key* — the user would have to
/// click before typing. Real menu-bar utilities work around this by explicitly
/// activating the app. We do the same, in order:
///
/// - `NSApplication::activateIgnoringOtherApps(true)` makes Tat2 the active app
///   regardless of who is focused, so its window can legitimately take keyboard
///   focus. (The modern `activate` is best-effort and may no-op unless the other
///   app yields — unacceptable for a summon-and-type tool, so we use the
///   still-functional `IgnoringOtherApps` variant.)
/// - `makeKeyAndOrderFront:` + `orderFrontRegardless()` make it key and surface
///   it above full-screen Spaces (paired with the `canJoinAllSpaces |
///   fullScreenAuxiliary` collection behavior set at setup — see
///   `set_visible_on_all_workspaces`).
///
/// This does **not** touch the activation policy, so the no-dock-icon invariant
/// is preserved. No-op off the main thread (we are always on it here).
#[cfg(target_os = "macos")]
fn focus_app_macos(win: &tauri::WebviewWindow) {
    use objc2::rc::Retained;
    use objc2_app_kit::{NSApplication, NSWindow};
    use objc2_foundation::MainThreadMarker;

    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let Ok(ns_window_ptr) = win.ns_window() else {
        return;
    };
    if ns_window_ptr.is_null() {
        return;
    }

    // SAFETY: `ns_window()` hands us an autoreleased pointer to the window's
    // live `NSWindow`. We retain it for the duration of these calls and only
    // invoke standard AppKit methods on the main thread.
    unsafe {
        let app = NSApplication::sharedApplication(mtm);
        #[allow(deprecated)]
        app.activateIgnoringOtherApps(true);

        let ns_window: Retained<NSWindow> =
            Retained::retain(ns_window_ptr.cast()).expect("non-null NSWindow");
        ns_window.makeKeyAndOrderFront(None);
        ns_window.orderFrontRegardless();
    }
}

/// Summon the popover: position it on the user's current display, show it, and
/// grab keyboard focus. Idempotent — safe to call while already visible or in
/// rapid succession (re-anchors and re-focuses without flicker).
fn show_window(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window(WINDOW_LABEL) {
        position_window(app);
        let _ = win.show();
        // `set_focus` is a no-op until the window is visible, hence after show.
        let _ = win.set_focus();
        #[cfg(target_os = "macos")]
        focus_app_macos(&win);
    }
}

fn toggle_window(app: &tauri::AppHandle) {
    let Some(win) = app.get_webview_window(WINDOW_LABEL) else {
        return;
    };
    if win.is_visible().unwrap_or(false) {
        let _ = win.hide();
    } else {
        show_window(app);
    }
}

/// Ask the frontend to flush, then exit shortly after (with a hard fallback).
fn flush_and_quit(app: &tauri::AppHandle) {
    let _ = app.emit(BEFORE_QUIT_EVENT, ());
    let handle = app.clone();
    std::thread::spawn(move || {
        // Fallback: quit even if the frontend never acks (e.g. not loaded).
        // Generous enough to let a large multi-pad flush finish on a slow disk;
        // the frontend normally calls quit_app well before this fires.
        std::thread::sleep(Duration::from_millis(4000));
        handle.exit(0);
    });
}

// ---- Window control commands callable from the frontend ----

#[tauri::command]
fn hide_popover(window: tauri::Window) {
    let _ = window.hide();
}

#[tauri::command]
fn set_pinned(app: tauri::AppHandle, pinned: bool) {
    *app.state::<Pinned>().0.lock().unwrap() = pinned;
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

/// Parse + register the global summon shortcut, then drop the previous one.
/// On failure the previous shortcut stays active (no gap with no hotkey).
#[cfg(desktop)]
fn apply_shortcut(app: &tauri::AppHandle, accelerator: &str) -> Result<(), String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;

    // No-op if it's already the active shortcut.
    {
        let state = app.state::<CurrentShortcut>();
        let cur = state.0.lock().unwrap();
        if cur.as_deref() == Some(accelerator) {
            return Ok(());
        }
    }

    let sc = accelerator
        .parse::<tauri_plugin_global_shortcut::Shortcut>()
        .map_err(|e| format!("invalid shortcut: {e}"))?;
    let gs = app.global_shortcut();
    // Register the new one FIRST; only on success retire the old one.
    gs.register(sc)
        .map_err(|e| format!("could not register \"{accelerator}\" (already in use?): {e}"))?;

    let state = app.state::<CurrentShortcut>();
    let mut cur = state.0.lock().unwrap();
    if let Some(prev) = cur.clone() {
        if let Ok(prev_sc) = prev.parse::<tauri_plugin_global_shortcut::Shortcut>() {
            let _ = gs.unregister(prev_sc);
        }
    }
    *cur = Some(accelerator.to_string());
    Ok(())
}

#[cfg(desktop)]
#[tauri::command]
fn set_shortcut(app: tauri::AppHandle, accelerator: String) -> Result<(), String> {
    apply_shortcut(&app, &accelerator)
}

#[cfg(not(desktop))]
#[tauri::command]
fn set_shortcut(_app: tauri::AppHandle, _accelerator: String) -> Result<(), String> {
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        use tauri_plugin_global_shortcut::ShortcutState;
        builder = builder
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_process::init())
            .plugin(tauri_plugin_autostart::init(
                tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                None,
            ))
            .plugin(
                tauri_plugin_global_shortcut::Builder::new()
                    .with_handler(|app, _shortcut, event| {
                        if event.state() == ShortcutState::Pressed {
                            toggle_window(app);
                        }
                    })
                    .build(),
            );
    }

    builder
        .manage(TrayAnchor::default())
        .manage(Pinned::default())
        .manage(CurrentShortcut::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                // Remember the size the user picked, but let us anchor position.
                .with_state_flags(tauri_plugin_window_state::StateFlags::SIZE)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            storage::load_workspace,
            storage::save_index,
            storage::save_pad,
            storage::trash_pad,
            storage::list_trash,
            storage::restore_pad,
            storage::delete_trash,
            storage::list_revisions,
            storage::read_revision,
            storage::force_snapshot,
            storage::export_pad,
            storage::import_file,
            hide_popover,
            set_pinned,
            set_shortcut,
            quit_app,
        ])
        .setup(|app| {
            // No dock icon on macOS — Tat2 lives in the menu bar.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // ---- Tray icon + right-click menu ----
            let toggle_i =
                MenuItem::with_id(app, "toggle", "Show / Hide Tat2", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit Tat2", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&toggle_i, &quit_i])?;

            let _tray = TrayIconBuilder::with_id("tat2-tray")
                .icon(app.default_window_icon().cloned().unwrap())
                .tooltip("Tat2 — quick sketchpads")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "toggle" => toggle_window(app),
                    "quit" => flush_and_quit(app),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        position,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        *app.state::<TrayAnchor>().0.lock().unwrap() = Some(position.x);
                        toggle_window(app);
                    }
                })
                .build(app)?;

            // ---- Global shortcut to summon the popover (user-configured) ----
            #[cfg(desktop)]
            {
                let handle = app.handle().clone();
                // Fall back to the platform default if the saved combo won't register.
                if apply_shortcut(&handle, &storage::saved_shortcut(&handle)).is_err() {
                    let _ = apply_shortcut(&handle, &storage::default_shortcut());
                }
            }

            // ---- Menubar behavior: hide when focus is lost (unless pinned) ----
            if let Some(win) = app.get_webview_window(WINDOW_LABEL) {
                // Let the popover appear over other apps' full-screen Spaces
                // (macOS), like a real menu-bar utility. A plain always-on-top
                // window can't draw over a full-screen app; this sets the
                // NSWindow collection behavior (canJoinAllSpaces |
                // fullScreenAuxiliary) so the summoned pad floats above it.
                let _ = win.set_visible_on_all_workspaces(true);

                let w = win.clone();
                win.on_window_event(move |event| match event {
                    WindowEvent::Focused(false) => {
                        let pinned = *w.app_handle().state::<Pinned>().0.lock().unwrap();
                        if !pinned {
                            let _ = w.hide();
                        }
                    }
                    WindowEvent::CloseRequested { api, .. } => {
                        // Closing the window just hides the popover; quit via tray.
                        api.prevent_close();
                        let _ = w.hide();
                    }
                    _ => {}
                });
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
