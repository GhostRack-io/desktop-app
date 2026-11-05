//! Linux launchers share the GTK application ID, including portable AppImages.
use crate::{Failure, Result, store};
use std::{
    fs,
    path::{Path, PathBuf},
};

pub const DESKTOP_FILE: &str = "io.ghostrack.desktop.desktop";
pub const APP_ID: &str = "io.ghostrack.desktop";
const MANAGED: &str = "X-Ghostrack-Managed=true";
/// Releases up to 0.1.7 marked their launcher this way, under the former
/// application ID; both stay the app's own.
const LEGACY_MANAGED: &str = "X-Gigahost-Managed=true";
const LEGACY_DESKTOP_FILE: &str = "cloud.gigahost.desktop.desktop";
const LEGACY_ICON_FILE: &str = "gigahost-desktop.png";

fn marked(path: &Path) -> Option<String> {
    // Do not remove a user-created override or follow a symlink.
    if !fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_file()) {
        return None;
    }
    fs::read_to_string(path).ok().filter(|entry| {
        entry
            .lines()
            .any(|line| line == MANAGED || line == LEGACY_MANAGED)
    })
}

/// An AppImage of 0.1.7 or earlier left its launcher and icon under the former
/// names; the current launcher replaces them rather than appearing twice.
/// Called once the current launcher is in place; a failure leaves both.
fn remove_legacy_launcher(apps: &Path, icons: &Path) {
    let launcher = apps.join(LEGACY_DESKTOP_FILE);
    let Some(entry) = marked(&launcher) else {
        return;
    };
    if fs::remove_file(&launcher).is_err() {
        return;
    }
    let icon = icons.join(LEGACY_ICON_FILE);
    if let Ok(text) = path_text(&icon)
        && entry
            .lines()
            .any(|line| line == format!("Icon={}", value(text)))
        && fs::symlink_metadata(&icon).is_ok_and(|m| m.file_type().is_file())
    {
        let _ = fs::remove_file(&icon);
    }
}

fn managed_launcher(path: &Path, icon_file: &Path) -> bool {
    if marked(path).is_some() {
        return true;
    }
    // Do not remove a user-created override or follow a symlink.
    if !fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_file()) {
        return false;
    }
    let Ok(entry) = fs::read_to_string(path) else {
        return false;
    };
    // Recognize the exact unmarked template produced by earlier previews.
    let Ok(icon) = path_text(icon_file) else {
        return false;
    };
    if !entry
        .lines()
        .any(|line| line.starts_with("Exec=\"/") && line.ends_with(".AppImage\" %u"))
    {
        return false;
    }
    let normalized = entry
        .lines()
        .map(|line| {
            if line.starts_with("Exec=") {
                "Exec=ghostrack-desktop %u"
            } else if line == format!("Icon={}", value(icon)) {
                "Icon=ghostrack-desktop"
            } else {
                line
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    normalized == include_str!("../io.ghostrack.desktop.desktop").trim_end()
}

fn value(text: &str) -> String {
    text.replace('\\', "\\\\")
}

fn path_text(path: &Path) -> Result<&str> {
    path.to_str()
        .filter(|s| !s.chars().any(char::is_control))
        .ok_or_else(|| {
            Failure::new(
                "launcher_path_invalid",
                "The application location cannot be used in a desktop launcher.",
            )
        })
}

fn executable(path: &Path) -> Result<String> {
    let mut quoted = String::from("\"");
    for c in path_text(path)?.chars() {
        match c {
            '\\' | '"' | '`' | '$' => {
                quoted.push('\\');
                quoted.push(c);
            }
            '%' => quoted.push_str("%%"),
            _ => quoted.push(c),
        }
    }
    quoted.push_str("\" %u");
    Ok(value(&quoted))
}

/// Packaged debs use the system entry. AppImages keep an icon and launcher in
/// the user's data directory, so neither refers to a temporary AppImage mount.
pub fn install_launcher(
    data_home: &Path,
    system_data: &[PathBuf],
    exe: &Path,
    portable: bool,
    icon: &[u8],
) -> Result<()> {
    let apps = data_home.join("applications");
    let icons = data_home.join("icons/hicolor/128x128/apps");
    let icon_file = icons.join("ghostrack-desktop.png");
    let launcher = apps.join(DESKTOP_FILE);
    if !portable
        && system_data
            .iter()
            .any(|dir| dir.join("applications").join(DESKTOP_FILE).is_file())
    {
        if managed_launcher(&launcher, &icon_file) {
            fs::remove_file(&launcher)?;
        }
        remove_legacy_launcher(&apps, &icons);
        return Ok(());
    }
    fs::create_dir_all(&apps)?;
    fs::create_dir_all(&icons)?;
    let entry = format!(
        "{}\n{MANAGED}\n",
        include_str!("../io.ghostrack.desktop.desktop").trim_end()
    )
    .replace(
        "Exec=ghostrack-desktop %u",
        &format!("Exec={}", executable(exe)?),
    )
    .replace(
        "Icon=ghostrack-desktop",
        &format!("Icon={}", value(path_text(&icon_file)?)),
    );
    if fs::read(&icon_file).ok().as_deref() != Some(icon) {
        store::save(&icon_file, icon, false)?;
    }
    if fs::read(&launcher).ok().as_deref() != Some(entry.as_bytes()) {
        store::save(&launcher, entry.as_bytes(), false)?;
    }
    remove_legacy_launcher(&apps, &icons);
    Ok(())
}
