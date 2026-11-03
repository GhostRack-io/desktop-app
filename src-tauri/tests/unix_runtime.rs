#![cfg(unix)]
//! Unix CLI defaults and real offline controller behavior in disposable homes.
use ghostrack_desktop::{
    Controller, Request,
    controller::{ghost_default, state_default},
    process::Runner,
    store::{Settings, Store},
};
use std::{fs, path::PathBuf, process::Command};

#[test]
fn home_defaults_and_offline_key_creation() {
    if let Ok(case) = std::env::var("GHOSTRACK_TEST_UNIX_DEFAULT_CASE") {
        let root = PathBuf::from(std::env::var_os("GHOSTRACK_TEST_HOME").unwrap());
        let home = root.join("home");
        let (seed, state) = match case.as_str() {
            "xdg" => (
                root.join("config/ghost/account.seed"),
                root.join("state/gigahost"),
            ),
            "explicit" => (
                root.join("explicit.seed"),
                home.join(".local/state/gigahost"),
            ),
            _ => (
                home.join(".config/ghost/account.seed"),
                home.join(".local/state/gigahost"),
            ),
        };
        assert_eq!(ghost_default().unwrap(), seed);
        assert_eq!(state_default().unwrap(), state);
        let runner = Runner {
            ghost: PathBuf::from(std::env::var_os("GHOSTRACK_TEST_GHOST").unwrap()),
            wallet: PathBuf::from(std::env::var_os("GHOSTRACK_TEST_WALLET").unwrap()),
        };
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let expected_wallets = if case == "explicit" {
                root.join("wallets")
            } else {
                home.join(".mmx")
            };
            let listed = runner
                .run(true, &["--json".into(), "list".into()], None, false)
                .await
                .unwrap();
            assert_eq!(listed["wallets"], serde_json::json!([]));
            assert_eq!(
                PathBuf::from(listed["wallet_directory"].as_str().unwrap()),
                expected_wallets
            );
            let controller = Controller::new(state.clone(), runner.clone()).unwrap();
            assert!(!seed.exists());
            controller
                .dispatch(Request::SaveSettings {
                    settings: Settings {
                        rpc_url: "http://127.0.0.1:9".into(),
                        api_url: "http://127.0.0.1:9".into(),
                        website_url: "http://127.0.0.1:9".into(),
                        ..Settings::default()
                    },
                })
                .await
                .unwrap();
            controller
                .dispatch(Request::CreateAccount { file: None })
                .await
                .unwrap();
            let original = fs::read(&seed).unwrap();
            assert!(
                controller
                    .dispatch(Request::CreateAccount { file: None })
                    .await
                    .is_err()
            );
            assert_eq!(fs::read(&seed).unwrap(), original);
            // Standalone Ghost discovers the account file selected by desktop.
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
            let wallet_file = PathBuf::from(wallet["wallet_file"].as_str().unwrap());
            assert!(wallet_file.starts_with(expected_wallets));
            assert!(wallet_file.is_file());
            assert!(wallet["address"].as_str().unwrap().starts_with("mmx1"));
            let settings = Store::new(state).unwrap().settings().unwrap();
            assert_eq!(settings.ghost_seed_file, Some(seed));
            assert_eq!(settings.wallet_file, Some(wallet_file));
        });
        return;
    }
    // Ordinary portable test runs need no compiled real sidecars. Native CI
    // supplies both paths and therefore exercises this full integration test.
    if std::env::var_os("GHOSTRACK_TEST_GHOST").is_none()
        || std::env::var_os("GHOSTRACK_TEST_WALLET").is_none()
    {
        return;
    }
    for case in ["home", "xdg", "relative-xdg", "explicit"] {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("home")).unwrap();
        let mut child = Command::new(std::env::current_exe().unwrap());
        child
            .args(["--exact", "home_defaults_and_offline_key_creation"])
            .env("GHOSTRACK_TEST_UNIX_DEFAULT_CASE", case)
            .env("GHOSTRACK_TEST_HOME", root.path())
            .env("HOME", root.path().join("home"));
        for name in [
            "XDG_CONFIG_HOME",
            "XDG_STATE_HOME",
            "GHOST_SEED_FILE",
            "GHOST_RECOVERY_SEED_FILE",
            "MMX_HOME",
        ] {
            child.env_remove(name);
        }
        match case {
            "xdg" => {
                child
                    .env("XDG_CONFIG_HOME", root.path().join("config"))
                    .env("XDG_STATE_HOME", root.path().join("state"));
            }
            "relative-xdg" => {
                child
                    .env("XDG_CONFIG_HOME", "relative")
                    .env("XDG_STATE_HOME", "relative");
            }
            "explicit" => {
                child
                    .env("GHOST_SEED_FILE", root.path().join("explicit.seed"))
                    .env("MMX_HOME", root.path().join("wallets"));
            }
            _ => (),
        }
        assert!(
            child.status().unwrap().success(),
            "Unix defaults case {case}"
        );
    }
}
