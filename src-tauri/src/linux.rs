//! Linux launchers share the GTK application ID, including portable AppImages.
use crate::{Failure, Result, store};
use std::{
    fs,
    path::{Path, PathBuf},
};

pub const DESKTOP_FILE: &str = "io.ghostrack.desktop.desktop";
pub const APP_ID: &str = "io.ghostrack.desktop";
const MANAGED: &str = "X-Gigahost-Managed=true";

fn managed_launcher(path: &Path, icon_file: &Path) -> bool {
    // Do not remove a user-created override or follow a symlink.
    if !fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_file()) {
        return false;
    }
    let Ok(entry) = fs::read_to_string(path) else {
        return false;
    };
    if entry.lines().any(|line| line == MANAGED) {
        return true;
    }
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
    Ok(())
}
