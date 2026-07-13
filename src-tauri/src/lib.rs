mod commands;
mod events;
mod notifications;

use comail_core::config::Paths;
use comail_core::Core;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager};

pub(crate) fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// True for a `mailto:` deep link (case-insensitive, tolerant of leading space).
fn is_mailto(s: &str) -> bool {
    s.trim_start().to_ascii_lowercase().starts_with("mailto:")
}

/// First `mailto:` argument in a process arg list, if any.
fn mailto_from_args<I: IntoIterator<Item = String>>(args: I) -> Option<String> {
    args.into_iter().find(|a| is_mailto(a))
}

/// Bring the window forward and hand a `mailto:` link to the frontend (which
/// opens a prefilled composer). De-duplicated because the same link can arrive
/// twice on a cold start (launch argv *and* the deep-link plugin's callback).
fn forward_mailto(app: &tauri::AppHandle, url: &str) {
    if !is_mailto(url) {
        return;
    }
    static LAST: std::sync::LazyLock<std::sync::Mutex<Option<(String, std::time::Instant)>>> =
        std::sync::LazyLock::new(|| std::sync::Mutex::new(None));
    {
        let mut last = LAST.lock().unwrap();
        let now = std::time::Instant::now();
        if let Some((u, t)) = last.as_ref() {
            if u == url && now.duration_since(*t) < std::time::Duration::from_millis(1500) {
                return;
            }
        }
        *last = Some((url.to_string(), now));
    }
    show_main(app);
    let _ = app.emit("deeplink:mailto", url);
}

/// Resolve a persisted language setting ("system" | a code) to a concrete code.
/// Tauri menus have no built-in i18n, so the tray labels are localized here.
fn resolve_lang(setting: &str) -> String {
    if setting.is_empty() || setting == "system" {
        return std::env::var("LANG")
            .ok()
            .and_then(|l| l.split(['_', '.', '-']).next().map(str::to_string))
            .filter(|l| !l.is_empty())
            .unwrap_or_else(|| "en".into());
    }
    setting.to_string()
}

/// Localized tray menu labels: (open, quit). "Comail" is a proper noun and stays.
/// Add a match arm per language as catalogs are added on the frontend.
fn tray_labels(lang: &str) -> (String, String) {
    let (open, quit) = match lang {
        "es" => ("Abrir", "Salir"),
        "fr" => ("Ouvrir", "Quitter"),
        "zh" => ("打开", "退出"),
        "vi" => ("Mở", "Thoát"),
        _ => ("Open", "Quit"),
    };
    (format!("{open} Comail"), format!("{quit} Comail"))
}

pub struct AppState {
    pub core: Core,
}

/// Detect the GPU/session and choose a WebKitGTK renderer that actually works,
/// so a single Linux binary runs correctly on any hardware without the user
/// picking a launch script.
///
/// WebKitGTK's DMABUF renderer is broken on many Linux GPU and Wayland setups
/// and quietly drops the webview to software compositing (~100% CPU, laggy
/// scrolling). Turning it off is the safe default and is right for Intel, AMD,
/// nouveau, and anything on X11. The one case where the DMABUF path is both
/// working and faster is the proprietary NVIDIA driver under Wayland, once it
/// is pointed at NVIDIA's GBM backend. We detect that and configure it instead.
///
/// Every variable is only set when the user has not already set it, so an
/// explicit override from the environment always wins.
#[cfg(target_os = "linux")]
fn configure_linux_renderer() {
    use std::path::Path;

    // An explicit choice from the environment beats auto-detection.
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_some() {
        return;
    }

    let wayland = std::env::var_os("WAYLAND_DISPLAY").is_some()
        || std::env::var("XDG_SESSION_TYPE")
            .map(|s| s == "wayland")
            .unwrap_or(false);
    // The proprietary driver exposes this file; nouveau does not.
    let nvidia_proprietary = Path::new("/proc/driver/nvidia/version").exists();

    if wayland && nvidia_proprietary {
        // NVIDIA on Wayland: keep DMABUF on and route it through NVIDIA's GBM
        // backend, which is the fast path on RTX + Wayland machines.
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "0");
        if std::env::var_os("GBM_BACKEND").is_none() {
            std::env::set_var("GBM_BACKEND", "nvidia-drm");
        }
        if std::env::var_os("__GLX_VENDOR_LIBRARY_NAME").is_none() {
            std::env::set_var("__GLX_VENDOR_LIBRARY_NAME", "nvidia");
        }
        tracing::info!("linux renderer: NVIDIA + Wayland, DMABUF via nvidia-drm GBM backend");
    } else {
        // Intel, AMD, nouveau, or any X11 session: the DMABUF path is
        // unreliable, so disable it and use the plain GL renderer.
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        tracing::info!("linux renderer: DMABUF disabled (safe default)");
    }
}

/// Log to stderr (dev) and to `<data_dir>/logs/comail.log` (packaged builds,
/// where stderr goes nowhere). The file is rotated once to `.1` when it
/// crosses 5 MB so it can't grow unbounded. `RUST_LOG` overrides the filter.
fn init_logging() {
    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::util::SubscriberInitExt;
    use tracing_subscriber::Layer;

    // `html5ever`/`markup5ever` (pulled in via `ammonia` to sanitize HTML email
    // bodies) log a WARN for every message that contains malformed HTML
    // ("foster parenting not implemented" and friends). That's routine for real
    // email and nothing we can act on, so quiet those targets by default.
    let filter = || {
        tracing_subscriber::EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| "info,comail_core=debug,html5ever=off,markup5ever=off".into())
    };

    let file = (|| {
        let dir = Paths::default_dirs().data_dir.join("logs");
        std::fs::create_dir_all(&dir).ok()?;
        let path = dir.join("comail.log");
        if std::fs::metadata(&path).is_ok_and(|m| m.len() > 5 * 1024 * 1024) {
            let _ = std::fs::rename(&path, dir.join("comail.log.1"));
        }
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .ok()
    })();

    let registry =
        tracing_subscriber::registry().with(tracing_subscriber::fmt::layer().with_filter(filter()));
    match file {
        Some(f) => registry
            .with(
                tracing_subscriber::fmt::layer()
                    .with_ansi(false)
                    .with_writer(std::sync::Mutex::new(f))
                    .with_filter(filter()),
            )
            .init(),
        None => registry.init(),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    init_logging();
    tracing::info!(
        version = env!("CARGO_PKG_VERSION"),
        os = std::env::consts::OS,
        "comail starting"
    );

    // Pick a WebKitGTK rendering path that suits this machine's GPU. Must run
    // before the webview is created.
    #[cfg(target_os = "linux")]
    configure_linux_renderer();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // Backstop for external links the in-webview JS interception didn't catch
        // (email-body links in the sandboxed iframe, AI-answer links): open
        // external web/mailto targets in the OS default browser and cancel the
        // in-app navigation so the SPA is never replaced. Internal app
        // navigations (tauri://, localhost, about:, data:) proceed untouched.
        .plugin(
            // Pin the (unused) plugin-config type to `()`; only the runtime is
            // inferred. Without this the config type param can't be resolved.
            tauri::plugin::Builder::<_, ()>::new("comail-external-links")
                .on_navigation(|_webview, url| {
                    let host = url.host_str().unwrap_or("");
                    let app_host = host.is_empty()
                        || host == "localhost"
                        || host == "tauri.localhost"
                        || host.ends_with(".localhost");
                    let external_web = matches!(url.scheme(), "http" | "https") && !app_host;
                    if external_web || url.scheme() == "mailto" {
                        let _ = tauri_plugin_opener::open_url(url.as_str(), None::<&str>);
                        return false;
                    }
                    true
                })
                .build(),
        )
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // Single-instance must be registered before deep-link so a mailto click
        // while the app runs focuses the existing window instead of spawning a
        // second copy; the forwarded argv carries the link on Linux/Windows.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.set_focus();
            }
            if let Some(url) = mailto_from_args(args) {
                forward_mailto(app, &url);
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .setup(|app| {
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                // Register as a mailto handler at runtime (needed for dev and for
                // Linux/Windows); bundled installers also declare it via the
                // deep-link `schemes` in tauri.conf.json.
                #[cfg(any(target_os = "linux", target_os = "windows"))]
                let _ = app.deep_link().register("mailto");
                // macOS delivers links via this callback; on Linux/Windows it
                // carries cold-start argv links too.
                let dl_handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        forward_mailto(&dl_handle, url.as_str());
                    }
                });
            }
            // Cold start: a mailto passed straight on the command line.
            if let Some(url) = mailto_from_args(std::env::args()) {
                forward_mailto(&app.handle(), &url);
            }
            let handle = app.handle().clone();
            // Expose the bundle resource dir to comail-core (which is Tauri-free)
            // so it can copy the bundled default embedding model on first run.
            if let Ok(res) = handle.path().resource_dir() {
                std::env::set_var("COMAIL_RESOURCE_DIR", res);
            }
            let lang = tauri::async_runtime::block_on(async move {
                let core = Core::start(Paths::default_dirs())
                    .await
                    .expect("failed to start comail core");
                events::spawn_forwarder(handle.clone(), core.bus.subscribe());
                let lang = resolve_lang(&core.get_settings().await.unwrap_or_default().language);
                handle.manage(AppState { core: core.clone() });
                notifications::spawn_dispatcher(handle.clone(), core);
                lang
            });

            // Tray: closing the window hides it; sync keeps running.
            let (open_label, quit_label) = tray_labels(&lang);
            let open = MenuItem::with_id(app, "open", &open_label, true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", &quit_label, true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
            TrayIconBuilder::with_id("comail-tray")
                .icon(app.default_window_icon().expect("window icon").clone())
                .tooltip("Comail")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_main(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    // Left click opens (works where the platform delivers
                    // click events; Linux appindicators are menu-only).
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::ui_ready,
            commands::list_accounts,
            commands::add_account_password,
            commands::test_connection,
            commands::remove_account,
            commands::start_oauth,
            commands::cancel_oauth,
            commands::list_threads,
            commands::get_thread,
            commands::get_body,
            commands::get_attachment,
            commands::save_attachment,
            commands::open_logs_dir,
            commands::focus_main_window,
            commands::preview_attachment,
            commands::list_folders,
            commands::perform_action,
            commands::undo_last,
            commands::cancel_send,
            commands::send_now,
            commands::save_draft,
            commands::delete_draft,
            commands::queue_send,
            commands::list_contacts,
            commands::suggest_contacts,
            commands::search,
            commands::list_snippets,
            commands::save_snippet,
            commands::delete_snippet,
            commands::use_snippet,
            commands::list_splits,
            commands::save_split,
            commands::delete_split,
            commands::list_labels,
            commands::save_label,
            commands::delete_label,
            commands::sync_now,
            commands::get_sync_status,
            commands::unread_counts,
            commands::relabel_auto,
            commands::get_settings,
            commands::set_settings,
            commands::list_events,
            commands::events_for_message,
            commands::create_event,
            commands::rsvp_event,
            commands::update_event,
            commands::delete_event,
            commands::connect_calendar,
            commands::create_teams_meeting,
            commands::disconnect_calendar,
            commands::list_calendars,
            commands::set_calendar_enabled,
            commands::calendar_sync_now,
            commands::ai_status,
            commands::ai_list_models,
            commands::set_ai_key,
            commands::ai_command,
            commands::ai_summarize,
            commands::ai_draft,
            commands::ai_proofread,
            commands::ai_learn_voice,
            commands::ai_ask,
            commands::embedding_status,
            commands::semantic_reindex,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, _event| {
            // macOS reactivation (Dock-icon click, and clicking a notification
            // that activates the app) fires Reopen with the window hidden to the
            // tray — re-show it so the app actually appears.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = _event {
                show_main(_app);
            }
        });
}
