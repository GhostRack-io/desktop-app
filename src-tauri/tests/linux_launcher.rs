#![cfg(target_os = "linux")]
use ghostrack_desktop::linux::{APP_ID, DESKTOP_FILE, install_launcher};
use std::{fs, path::Path};

#[test]
fn window_identity_and_package_launcher_match() {
    let config: serde_json::Value =
        serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
    assert_eq!(config["identifier"], APP_ID);
    assert_eq!(config["app"]["enableGTKAppId"], true);
    assert_eq!(DESKTOP_FILE, format!("{APP_ID}.desktop"));
    for target in ["deb", "appimage"] {
        assert!(
            config["bundle"]["linux"][target]["files"]
                .get(format!("/usr/share/applications/{DESKTOP_FILE}"))
                .is_some()
        );
    }
}

#[test]
fn portable_launcher_survives_unmount_and_updates_after_move() {
    let home = tempfile::tempdir().unwrap();
    let first = Path::new("/home/new user/Downloads/GhostRack.AppImage");
    install_launcher(home.path(), &[], first, true, b"icon").unwrap();
    let launcher = home.path().join("applications").join(DESKTOP_FILE);
    let entry = fs::read_to_string(&launcher).unwrap();
    assert!(entry.contains("Exec=\"/home/new user/Downloads/GhostRack.AppImage\" %u"));
    assert!(!entry.contains("NoDisplay=true"));
    let icon = entry
        .lines()
        .find_map(|line| line.strip_prefix("Icon="))
        .unwrap();
    assert_eq!(fs::read(icon).unwrap(), b"icon");
    let moved = Path::new("/home/new user/Applications/GhostRack.AppImage");
    install_launcher(home.path(), &[], moved, true, b"new icon").unwrap();
    assert!(
        fs::read_to_string(launcher)
            .unwrap()
            .contains("/Applications/GhostRack.AppImage")
    );
    assert_eq!(fs::read(icon).unwrap(), b"new icon");
}

#[test]
fn installed_deb_uses_system_launcher_without_user_duplicate() {
    let home = tempfile::tempdir().unwrap();
    let system = tempfile::tempdir().unwrap();
    fs::create_dir(system.path().join("applications")).unwrap();
    fs::write(
        system.path().join("applications").join(DESKTOP_FILE),
        b"packaged launcher",
    )
    .unwrap();
    install_launcher(
        home.path(),
        &[system.path().into()],
        Path::new("/usr/bin/ghostrack-desktop"),
        false,
        b"icon",
    )
    .unwrap();
    assert!(!home.path().join("applications").exists());
}

#[test]
fn appimage_to_deb_removes_only_generated_user_override() {
    let home = tempfile::tempdir().unwrap();
    let system = tempfile::tempdir().unwrap();
    let launcher = home.path().join("applications").join(DESKTOP_FILE);
    fs::create_dir(system.path().join("applications")).unwrap();
    fs::write(
        system.path().join("applications").join(DESKTOP_FILE),
        b"packaged launcher",
    )
    .unwrap();
    let dirs = [system.path().into()];
    for legacy in [false, true] {
        install_launcher(
            home.path(),
            &dirs,
            Path::new("/tmp/GhostRack.AppImage"),
            true,
            b"icon",
        )
        .unwrap();
        if legacy {
            let text = fs::read_to_string(&launcher)
                .unwrap()
                .replace("X-Ghostrack-Managed=true\n", "");
            fs::write(&launcher, text).unwrap();
        }
        install_launcher(
            home.path(),
            &dirs,
            Path::new("/usr/bin/ghostrack-desktop"),
            false,
            b"icon",
        )
        .unwrap();
        assert!(!launcher.exists());
    }
    fs::write(
        &launcher,
        "[Desktop Entry]\nName=My custom GhostRack\nExec=/custom/location\n",
    )
    .unwrap();
    install_launcher(
        home.path(),
        &dirs,
        Path::new("/usr/bin/ghostrack-desktop"),
        false,
        b"icon",
    )
    .unwrap();
    assert!(
        fs::read_to_string(launcher)
            .unwrap()
            .contains("My custom GhostRack")
    );
}

#[test]
fn deb_preserves_unmarked_override_with_only_custom_exec() {
    let home = tempfile::tempdir().unwrap();
    let system = tempfile::tempdir().unwrap();
    install_launcher(
        home.path(),
        &[],
        Path::new("/tmp/GhostRack.AppImage"),
        true,
        b"icon",
    )
    .unwrap();
    let launcher = home.path().join("applications").join(DESKTOP_FILE);
    let entry = fs::read_to_string(&launcher)
        .unwrap()
        .replace("X-Ghostrack-Managed=true\n", "")
        .replace(
            "Exec=\"/tmp/GhostRack.AppImage\" %u",
            "Exec=/my/custom/ghostrack %u",
        );
    fs::write(&launcher, &entry).unwrap();
    fs::create_dir(system.path().join("applications")).unwrap();
    fs::write(
        system.path().join("applications").join(DESKTOP_FILE),
        b"packaged launcher",
    )
    .unwrap();
    install_launcher(
        home.path(),
        &[system.path().into()],
        Path::new("/usr/bin/ghostrack-desktop"),
        false,
        b"icon",
    )
    .unwrap();
    assert_eq!(fs::read_to_string(&launcher).unwrap(), entry);
}

/// The launcher and icon an AppImage of 0.1.7 wrote, under the former names.
fn legacy_launcher(home: &Path) -> (std::path::PathBuf, std::path::PathBuf) {
    let apps = home.join("applications");
    let icons = home.join("icons/hicolor/128x128/apps");
    fs::create_dir_all(&apps).unwrap();
    fs::create_dir_all(&icons).unwrap();
    let icon = icons.join("gigahost-desktop.png");
    fs::write(&icon, b"old icon").unwrap();
    let launcher = apps.join("cloud.gigahost.desktop.desktop");
    fs::write(
        &launcher,
        format!(
            "[Desktop Entry]\nType=Application\nName=Gigahost\nExec=\"/tmp/Gigahost.AppImage\" %u\nIcon={}\nMimeType=x-scheme-handler/gigahost;\nX-Gigahost-Managed=true\n",
            icon.display()
        ),
    )
    .unwrap();
    (launcher, icon)
}

#[test]
fn new_launcher_carries_the_ghostrack_marker() {
    let home = tempfile::tempdir().unwrap();
    install_launcher(
        home.path(),
        &[],
        Path::new("/tmp/GhostRack.AppImage"),
        true,
        b"icon",
    )
    .unwrap();
    let entry = fs::read_to_string(home.path().join("applications").join(DESKTOP_FILE)).unwrap();
    assert!(entry.lines().any(|line| line == "X-Ghostrack-Managed=true"));
    assert!(!entry.contains("Gigahost"));
}

#[test]
fn appimage_replaces_the_old_named_launcher_instead_of_duplicating_it() {
    let home = tempfile::tempdir().unwrap();
    let (old, old_icon) = legacy_launcher(home.path());
    install_launcher(
        home.path(),
        &[],
        Path::new("/tmp/GhostRack.AppImage"),
        true,
        b"icon",
    )
    .unwrap();
    assert!(!old.exists());
    assert!(!old_icon.exists());
    let apps: Vec<_> = fs::read_dir(home.path().join("applications"))
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert_eq!(apps, [DESKTOP_FILE]);
}

#[test]
fn deb_removes_launchers_with_either_marker() {
    let home = tempfile::tempdir().unwrap();
    let system = tempfile::tempdir().unwrap();
    fs::create_dir(system.path().join("applications")).unwrap();
    fs::write(
        system.path().join("applications").join(DESKTOP_FILE),
        b"packaged launcher",
    )
    .unwrap();
    let dirs = [system.path().into()];
    let (old, old_icon) = legacy_launcher(home.path());
    // A preview after the rename wrote the current name with the old marker.
    let current = home.path().join("applications").join(DESKTOP_FILE);
    fs::write(
        &current,
        "[Desktop Entry]\nName=GhostRack\nExec=/custom %u\nX-Gigahost-Managed=true\n",
    )
    .unwrap();
    install_launcher(
        home.path(),
        &dirs,
        Path::new("/usr/bin/ghostrack-desktop"),
        false,
        b"icon",
    )
    .unwrap();
    assert!(!current.exists());
    assert!(!old.exists());
    assert!(!old_icon.exists());
}

#[test]
fn unmarked_or_linked_old_named_launchers_are_kept() {
    let home = tempfile::tempdir().unwrap();
    let (old, old_icon) = legacy_launcher(home.path());
    let custom = "[Desktop Entry]\nName=My Gigahost\nExec=/custom %u\n";
    fs::write(&old, custom).unwrap();
    install_launcher(
        home.path(),
        &[],
        Path::new("/tmp/GhostRack.AppImage"),
        true,
        b"icon",
    )
    .unwrap();
    assert_eq!(fs::read_to_string(&old).unwrap(), custom);
    assert!(old_icon.exists());
    // A symlink is the user's, even when its target carries the marker.
    let target = home.path().join("elsewhere.desktop");
    fs::write(&target, "X-Gigahost-Managed=true\n").unwrap();
    fs::remove_file(&old).unwrap();
    std::os::unix::fs::symlink(&target, &old).unwrap();
    install_launcher(
        home.path(),
        &[],
        Path::new("/tmp/GhostRack.AppImage"),
        true,
        b"icon",
    )
    .unwrap();
    assert!(fs::symlink_metadata(&old).unwrap().file_type().is_symlink());
}
