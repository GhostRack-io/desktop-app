#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use ghostrack_desktop::{
    Controller, Failure, Request,
    controller::{approval_id, state_default},
    process::Runner,
};
use serde_json::Value;
use tauri::{Emitter, Manager, State};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_opener::OpenerExt;

#[tauri::command]
async fn desktop(
    app: tauri::AppHandle,
    controller: State<'_, Controller>,
    request: Request,
) -> Result<Value, Failure> {
    let login = matches!(request, Request::Login);
    let claim = matches!(request, Request::GithubSignup | Request::GithubLink);
    let result = controller.dispatch(request).await?;
    if claim {
        // The controller checked the link is on the configured website.
        let url = result["claim_url"]
            .as_str()
            .ok_or_else(|| Failure::new("invalid_github_claim", "The GitHub link is invalid."))?;
        app.opener().open_url(url, None::<&str>).map_err(|_| {
            Failure::new("browser_unavailable", "Your browser could not be opened.")
        })?;
        return Ok(serde_json::json!({
            "claim_id": result["claim_id"],
            "expires_at": result["expires_at"],
        }));
    }
    if login {
        let url = result["login_url"]
            .as_str()
            .ok_or_else(|| Failure::new("invalid_login", "The login link is invalid."))?;
        app.opener().open_url(url, None::<&str>).map_err(|_| {
            Failure::new("browser_unavailable", "Your browser could not be opened.")
        })?;
        // The login token never crosses into the webview or operation journal.
        return Ok(serde_json::json!({"opened":true,"expires_at":result["expires_at"]}));
    }
    Ok(result)
}
fn accept_link(app: &tauri::AppHandle, text: &str) {
    let controller = app.state::<Controller>();
    if let Ok(settings) = controller.store.settings()
        && let Ok(id) = approval_id(text, &settings.website_url)
    {
        let _ = app.emit("restore-link", id);
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}
#[tauri::command]
fn startup_approval(app: tauri::AppHandle, controller: State<'_, Controller>) -> Option<String> {
    let settings = controller.store.settings().ok()?;
    app.deep_link()
        .get_current()
        .ok()
        .flatten()?
        .iter()
        .find_map(|url| approval_id(url.as_str(), &settings.website_url).ok())
}
#[cfg(target_os = "linux")]
fn register_linux(app: &tauri::App) -> std::result::Result<(), Box<dyn std::error::Error>> {
    use ghostrack_desktop::linux::{DESKTOP_FILE, install_launcher};
    use std::{path::PathBuf, process::Command};
    let data_home = app.path().data_dir()?;
    let portable = app.env().appimage.map(PathBuf::from);
    let exe = portable.clone().unwrap_or(std::env::current_exe()?);
    let system_data = std::env::var_os("XDG_DATA_DIRS")
        .map(|dirs| std::env::split_paths(&dirs).collect())
        .unwrap_or_else(|| {
            vec![
                PathBuf::from("/usr/local/share"),
                PathBuf::from("/usr/share"),
            ]
        });
    install_launcher(
        &data_home,
        &system_data,
        &exe,
        portable.is_some(),
        include_bytes!("../icons/128x128.png"),
    )
    .map_err(|e| e.message)?;
    // Updating the MIME cache is optional; xdg-mime writes the scheme binding.
    if data_home.join("applications").exists() {
        let _ = Command::new("update-desktop-database")
            .arg(data_home.join("applications"))
            .status();
    }
    if !Command::new("xdg-mime")
        .args(["default", DESKTOP_FILE, "x-scheme-handler/ghostrack"])
        .status()?
        .success()
    {
        return Err("could not register GhostRack approval links".into());
    }
    Ok(())
}
/// A start that cannot open its state shows why in a dialog: a release build
/// launched from a menu, Finder or the Start menu has no terminal for it.
fn refuse_start(failure: &Failure) -> ! {
    eprintln!("{}", failure.message);
    // rfd waits for a GTK thread that never starts without a display.
    #[cfg(target_os = "linux")]
    let display = ["DISPLAY", "WAYLAND_DISPLAY"]
        .iter()
        .any(|name| std::env::var_os(name).is_some_and(|v| !v.is_empty()));
    #[cfg(not(target_os = "linux"))]
    let display = true;
    if display {
        rfd::MessageDialog::new()
            .set_level(rfd::MessageLevel::Error)
            .set_title("GhostRack")
            .set_description(&failure.message)
            .set_buttons(rfd::MessageButtons::Ok)
            .show();
    }
    std::process::exit(1);
}
fn main() {
    #[cfg(target_os = "linux")]
    {
        // GTK's Wayland app_id follows the process name even when its
        // GApplication ID is set. Both must match the installed launcher.
        glib::set_prgname(Some(ghostrack_desktop::linux::APP_ID));
        glib::set_application_name("GhostRack");
    }
    // The state root is decided before the window exists, so a refusal
    // (journals under both names) reaches the user.
    let controller = state_default()
        .and_then(|root| Controller::new(root, Runner::bundled()?))
        .unwrap_or_else(|failure| refuse_start(&failure));
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            // The plugin's deep-link feature forwards URLs to on_open_url.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED,
                )
                .build(),
        )
        .setup(|app| {
            app.manage(controller);
            #[cfg(target_os = "linux")]
            if register_linux(app).is_err() {
                // Minimal desktops may lack xdg-utils. Pasting an approval link
                // still works; optional link registration must not prevent launch.
                eprintln!(
                    "Desktop approval-link registration unavailable; paste links in Account."
                );
            }
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    accept_link(&handle, url.as_str());
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![desktop, startup_approval])
        .run(tauri::generate_context!())
        .expect("could not start GhostRack desktop");
}
