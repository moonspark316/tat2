mod storage;

use std::sync::Mutex;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, PhysicalPosition, WindowEvent,
};

/// Remembers the horizontal center (physical px) of the last tray click so the
/// popover can re-anchor under the menu-bar icon even when opened via shortcut.
#[derive(Default)]
struct TrayAnchor(Mutex<Option<f64>>);

const WINDOW_LABEL: &str = "main";

/// Place the popover just under the menu bar, horizontally centered on the
/// tray icon (falling back to the top-right corner of the primary display).
fn position_window(app: &tauri::AppHandle) {
    let Some(win) = app.get_webview_window(WINDOW_LABEL) else {
        return;
    };
    let anchor_x = *app.state::<TrayAnchor>().0.lock().unwrap();

    let monitor = win
        .current_monitor()
        .ok()
        .flatten()
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

    // A few px below the macOS menu bar / Windows tray area.
    let y = mon_y + 34.0 * scale;
    let x = match anchor_x {
        Some(cx) => cx - win_w / 2.0,
        None => mon_x + mon_w - win_w - 12.0 * scale,
    };
    // Keep the window fully on-screen.
    let min_x = mon_x + 4.0;
    let max_x = (mon_x + mon_w - win_w - 4.0).max(min_x);
    let x = x.clamp(min_x, max_x);

    let _ = win.set_position(PhysicalPosition::new(x as i32, y as i32));
}

fn toggle_window(app: &tauri::AppHandle) {
    let Some(win) = app.get_webview_window(WINDOW_LABEL) else {
        return;
    };
    if win.is_visible().unwrap_or(false) {
        let _ = win.hide();
    } else {
        position_window(app);
        let _ = win.show();
        let _ = win.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        use tauri_plugin_global_shortcut::ShortcutState;
        builder = builder.plugin(
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
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            storage::load_workspace,
            storage::save_index,
            storage::save_pad,
            storage::delete_pad,
            storage::list_revisions,
            storage::read_revision,
            storage::force_snapshot,
        ])
        .setup(|app| {
            // No dock icon on macOS — Tat2 lives in the menu bar.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // ---- Tray icon + right-click menu ----
            let toggle_i = MenuItem::with_id(app, "toggle", "Show / Hide Tat2", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit Tat2", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&toggle_i, &quit_i])?;

            let _tray = TrayIconBuilder::with_id("tat2-tray")
                .icon(app.default_window_icon().cloned().unwrap())
                .tooltip("Tat2 — quick sketchpads")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "toggle" => toggle_window(app),
                    "quit" => app.exit(0),
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

            // ---- Global shortcut to summon the popover ----
            #[cfg(desktop)]
            {
                use tauri_plugin_global_shortcut::GlobalShortcutExt;
                if let Ok(shortcut) =
                    storage::default_shortcut().parse::<tauri_plugin_global_shortcut::Shortcut>()
                {
                    let _ = app.global_shortcut().register(shortcut);
                }
            }

            // ---- Menubar behavior: hide when focus is lost ----
            if let Some(win) = app.get_webview_window(WINDOW_LABEL) {
                let w = win.clone();
                win.on_window_event(move |event| {
                    if let WindowEvent::Focused(false) = event {
                        let _ = w.hide();
                    }
                });
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
