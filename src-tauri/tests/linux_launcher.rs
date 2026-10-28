#![cfg(target_os = "linux")]
use gigahost_desktop::linux::{APP_ID, DESKTOP_FILE, install_launcher};
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
    let first = Path::new("/home/new user/Downloads/Gigahost.AppImage");
    install_launcher(home.path(), &[], first, true, b"icon").unwrap();
    let launcher = home.path().join("applications").join(DESKTOP_FILE);
    let entry = fs::read_to_string(&launcher).unwrap();
    assert!(entry.contains("Exec=\"/home/new user/Downloads/Gigahost.AppImage\" %u"));
    assert!(!entry.contains("NoDisplay=true"));
    let icon = entry
        .lines()
        .find_map(|line| line.strip_prefix("Icon="))
        .unwrap();
    assert_eq!(fs::read(icon).unwrap(), b"icon");
    let moved = Path::new("/home/new user/Applications/Gigahost.AppImage");
    install_launcher(home.path(), &[], moved, true, b"new icon").unwrap();
    assert!(
        fs::read_to_string(launcher)
            .unwrap()
            .contains("/Applications/Gigahost.AppImage")
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
        Path::new("/usr/bin/gigahost-desktop"),
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
            Path::new("/tmp/Gigahost.AppImage"),
            true,
            b"icon",
        )
        .unwrap();
        if legacy {
            let text = fs::read_to_string(&launcher)
                .unwrap()
                .replace("X-Gigahost-Managed=true\n", "");
            fs::write(&launcher, text).unwrap();
        }
        install_launcher(
            home.path(),
            &dirs,
            Path::new("/usr/bin/gigahost-desktop"),
            false,
            b"icon",
        )
        .unwrap();
        assert!(!launcher.exists());
    }
    fs::write(
        &launcher,
        "[Desktop Entry]\nName=My custom Gigahost\nExec=/custom/location\n",
    )
    .unwrap();
    install_launcher(
        home.path(),
        &dirs,
        Path::new("/usr/bin/gigahost-desktop"),
        false,
        b"icon",
    )
    .unwrap();
    assert!(
        fs::read_to_string(launcher)
            .unwrap()
            .contains("My custom Gigahost")
    );
}

#[test]
fn deb_preserves_unmarked_override_with_only_custom_exec() {
    let home = tempfile::tempdir().unwrap();
    let system = tempfile::tempdir().unwrap();
    install_launcher(
        home.path(),
        &[],
        Path::new("/tmp/Gigahost.AppImage"),
        true,
        b"icon",
    )
    .unwrap();
    let launcher = home.path().join("applications").join(DESKTOP_FILE);
    let entry = fs::read_to_string(&launcher)
        .unwrap()
        .replace("X-Gigahost-Managed=true\n", "")
        .replace(
            "Exec=\"/tmp/Gigahost.AppImage\" %u",
            "Exec=/my/custom/gigahost %u",
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
        Path::new("/usr/bin/gigahost-desktop"),
        false,
        b"icon",
    )
    .unwrap();
    assert_eq!(fs::read_to_string(&launcher).unwrap(), entry);
}
