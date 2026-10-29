#![cfg(windows)]
//! Real Windows process/storage behavior, with disposable keys and no network.
use gigahost_desktop::{
    Controller, Request,
    controller::{ghost_default, state_default},
    process::{Runner, Secret},
    store::{Settings, Store},
};
use serde_json::{Value, json};
use std::{fs, path::PathBuf, process::Command};

#[test]
fn explorer_defaults_and_offline_key_creation() {
    if let Ok(case) = std::env::var("GIGAHOST_TEST_DEFAULT_CASE") {
        let root = PathBuf::from(std::env::var_os("GIGAHOST_TEST_HOME").unwrap());
        let (seed, state) = match case.as_str() {
            "profile" => (
                root.join("profile/.config/ghost/account.seed"),
                root.join("profile/.local/state/gigahost"),
            ),
            "xdg" => (
                root.join("config/ghost/account.seed"),
                root.join("state/gigahost"),
            ),
            "home" => (
                root.join("home/.config/ghost/account.seed"),
                root.join("home/.local/state/gigahost"),
            ),
            _ => (
                root.join("roaming/ghost/account.seed"),
                root.join("local/gigahost"),
            ),
        };
        assert_eq!(ghost_default().unwrap(), seed);
        assert_eq!(state_default().unwrap(), state);
        if case != "explorer" {
            return;
        }
        let runner = Runner {
            ghost: PathBuf::from(
                std::env::var_os("GIGAHOST_TEST_GHOST")
                    .expect("Set GIGAHOST_TEST_GHOST to the built Ghost exe"),
            ),
            wallet: PathBuf::from(
                std::env::var_os("GIGAHOST_TEST_WALLET")
                    .expect("Set GIGAHOST_TEST_WALLET to the built mmxwallet exe"),
            ),
        };
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let controller = Controller::new(state.clone(), runner.clone()).unwrap();
            let offline = Settings {
                rpc_url: "http://127.0.0.1:9".into(),
                api_url: "http://127.0.0.1:9".into(),
                website_url: "http://127.0.0.1:9".into(),
                ..Settings::default()
            };
            controller
                .dispatch(Request::SaveSettings { settings: offline })
                .await
                .unwrap();
            controller
                .dispatch(Request::CreateAccount { file: None })
                .await
                .unwrap();
            assert!(seed.is_file());
            let original_seed = fs::read(&seed).unwrap();
            assert!(
                controller
                    .dispatch(Request::CreateAccount { file: None })
                    .await
                    .is_err()
            );
            assert_eq!(fs::read(&seed).unwrap(), original_seed);
            // Standalone Ghost must discover the very same default key.
            runner
                .run(
                    false,
                    &["--compact".into(), "key".into(), "inspect".into()],
                    None,
                    false,
                )
                .await
                .unwrap();
            let wallet = controller
                .dispatch(Request::CreateWallet {
                    file: None,
                    mnemonic: None,
                    passphrase: None,
                })
                .await
                .unwrap();
            let wallet_path = PathBuf::from(wallet["wallet_file"].as_str().unwrap());
            assert!(wallet_path.starts_with(root.join("profile/.mmx")));
            assert!(wallet_path.is_file());
            assert!(wallet["address"].as_str().unwrap().starts_with("mmx1"));
            let mut settings = controller.store.settings().unwrap();
            settings.theme = "dark".into();
            controller
                .dispatch(Request::SaveSettings { settings })
                .await
                .unwrap();
            let reopened = Store::new(state).unwrap().settings().unwrap();
            assert_eq!(reopened.theme, "dark");
            assert_eq!(reopened.ghost_seed_file, Some(seed));
            assert_eq!(reopened.wallet_file, Some(wallet_path));
        });
        return;
    }
    // Environment changes belong to child processes, never the parallel test
    // process. HOME/XDG are absent just as they are for an Explorer launch.
    for case in ["explorer", "profile", "xdg", "home"] {
        let root = tempfile::tempdir().unwrap();
        let mut child = Command::new(std::env::current_exe().unwrap());
        child
            .args(["--exact", "explorer_defaults_and_offline_key_creation"])
            .env("GIGAHOST_TEST_DEFAULT_CASE", case)
            .env("GIGAHOST_TEST_HOME", root.path())
            .env("USERPROFILE", root.path().join("profile"))
            .env("APPDATA", root.path().join("roaming"))
            .env("LOCALAPPDATA", root.path().join("local"));
        for name in [
            "HOME",
            "XDG_CONFIG_HOME",
            "XDG_STATE_HOME",
            "GHOST_SEED_FILE",
            "GHOST_RECOVERY_SEED_FILE",
            "MMX_HOME",
        ] {
            child.env_remove(name);
        }
        match case {
            "profile" => {
                child
                    .env("APPDATA", "relative")
                    .env("LOCALAPPDATA", "relative");
            }
            "xdg" => {
                child
                    .env("XDG_CONFIG_HOME", root.path().join("config"))
                    .env("XDG_STATE_HOME", root.path().join("state"));
            }
            "home" => {
                child.env("HOME", root.path().join("home"));
            }
            _ => (),
        }
        assert!(
            child.status().unwrap().success(),
            "Windows defaults case {case}"
        );
    }
}

#[tokio::test]
async fn sidecars_keep_json_pipes_without_creating_a_console() {
    let powershell = PathBuf::from(std::env::var_os("SystemRoot").unwrap())
        .join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let runner = Runner {
        ghost: powershell.clone(),
        wallet: powershell,
    };
    let script = r#"Add-Type 'using System; using System.Runtime.InteropServices; public class ConsoleProbe { [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow(); }'; @{console=[ConsoleProbe]::GetConsoleWindow().ToInt64(); input=[Console]::In.ReadLine()} | ConvertTo-Json -Compress"#;
    let result = runner
        .run(
            false,
            &[
                "-NoProfile".into(),
                "-NonInteractive".into(),
                "-Command".into(),
                script.into(),
            ],
            Some(Secret::Json(json!({"disposable":"pipe-check"}))),
            false,
        )
        .await
        .unwrap();
    assert_eq!(result["console"], 0);
    let input: Value = serde_json::from_str(result["input"].as_str().unwrap()).unwrap();
    assert_eq!(input, json!({"disposable":"pipe-check"}));
}

#[test]
fn atomic_settings_replacement_preserves_no_clobber_exports() {
    let root = tempfile::tempdir().unwrap();
    let store = Store::new(root.path().join("state")).unwrap();
    let mut settings = Settings::default();
    for theme in ["dark", "light", "system"] {
        settings.theme = theme.into();
        store.save_settings(&settings).unwrap();
        assert_eq!(store.settings().unwrap().theme, theme);
    }
    let export = root.path().join("key-backup");
    gigahost_desktop::store::save(&export, b"original", true).unwrap();
    assert_eq!(
        gigahost_desktop::store::save(&export, b"replacement", true)
            .unwrap_err()
            .code,
        "file_exists"
    );
    assert_eq!(fs::read(export).unwrap(), b"original");
}
