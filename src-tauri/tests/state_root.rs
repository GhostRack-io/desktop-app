//! The state root rule after the rename: one root per machine, never both.
use ghostrack_desktop::{
    controller::{state_default, state_root},
    store::Store,
};
use std::{fs, path::Path, process::Command};

const PENDING: &str = r#"[{"id":"7f2d1c4e-1b9a-4f0e-9c1d-2a3b4c5d6e7f","kind":"payment","state":"uncertain","created_at":1,"wallet_file":null,"ghost_seed_file":null,"rpc_url":"https://rpc.mmx.network","api_url":"https://api.ghostrack.io","transaction_id":null,"digest":null,"review":{},"intent_id":null,"replacement_seed_file":null,"account_memo":null,"account_epoch":null,"job_id":null}]"#;

fn journal(root: &Path) {
    fs::create_dir_all(root.join("transactions")).unwrap();
    fs::write(root.join("operations.json"), PENDING).unwrap();
}

#[test]
fn a_fresh_machine_uses_the_new_root() {
    let parent = tempfile::tempdir().unwrap();
    let root = state_root(parent.path()).unwrap();
    assert_eq!(root, parent.path().join("ghostrack"));
    // Choosing creates nothing; the store creates only the chosen root.
    assert!(fs::read_dir(parent.path()).unwrap().next().is_none());
    Store::new(root).unwrap();
    assert!(!parent.path().join("gigahost").exists());
}

#[test]
fn an_upgraded_machine_keeps_its_old_root_and_pending_payment() {
    let parent = tempfile::tempdir().unwrap();
    let old = parent.path().join("gigahost");
    journal(&old);
    let root = state_root(parent.path()).unwrap();
    assert_eq!(root, old);
    let store = Store::new(root).unwrap();
    assert_eq!(store.operations().unwrap()[0].state, "uncertain");
    // Nothing moves, copies or appears under the new name, start after start.
    assert_eq!(state_root(parent.path()).unwrap(), old);
    assert!(!parent.path().join("ghostrack").exists());
    // An old root without journals (settings only) is still kept.
    let parent = tempfile::tempdir().unwrap();
    fs::create_dir(parent.path().join("gigahost")).unwrap();
    fs::write(parent.path().join("gigahost/settings.json"), "{}").unwrap();
    assert_eq!(
        state_root(parent.path()).unwrap(),
        parent.path().join("gigahost")
    );
}

#[test]
fn the_new_root_alone_is_used() {
    let parent = tempfile::tempdir().unwrap();
    journal(&parent.path().join("ghostrack"));
    assert_eq!(
        state_root(parent.path()).unwrap(),
        parent.path().join("ghostrack")
    );
}

#[test]
fn with_both_roots_the_one_holding_journals_wins() {
    for (journals_in, expected) in [
        ("gigahost", "gigahost"),
        ("ghostrack", "ghostrack"),
        ("", "ghostrack"),
    ] {
        let parent = tempfile::tempdir().unwrap();
        for name in ["ghostrack", "gigahost"] {
            fs::create_dir_all(parent.path().join(name).join("transactions")).unwrap();
            fs::write(parent.path().join(name).join("settings.json"), "{}").unwrap();
        }
        if !journals_in.is_empty() {
            journal(&parent.path().join(journals_in));
        }
        assert_eq!(
            state_root(parent.path()).unwrap(),
            parent.path().join(expected),
            "journals in {journals_in:?}"
        );
    }
    // A reviewed transaction file alone is a journal too.
    let parent = tempfile::tempdir().unwrap();
    fs::create_dir_all(parent.path().join("ghostrack")).unwrap();
    fs::create_dir_all(parent.path().join("gigahost/transactions")).unwrap();
    fs::write(
        parent
            .path()
            .join("gigahost/transactions/7f2d1c4e-1b9a-4f0e-9c1d-2a3b4c5d6e7f.json"),
        "{}",
    )
    .unwrap();
    assert_eq!(
        state_root(parent.path()).unwrap(),
        parent.path().join("gigahost")
    );
}

#[test]
fn with_journals_in_both_roots_the_app_refuses_to_start() {
    let parent = tempfile::tempdir().unwrap();
    journal(&parent.path().join("ghostrack"));
    journal(&parent.path().join("gigahost"));
    let error = state_root(parent.path()).unwrap_err();
    assert_eq!(error.code, "state_conflict");
    for name in ["ghostrack", "gigahost"] {
        let path = parent.path().join(name).display().to_string();
        assert!(error.message.contains(&path), "{}", error.message);
    }
}

#[test]
fn the_platform_default_applies_the_rule() {
    // The child runs with its own environment; the parallel test process
    // keeps its own.
    if let Ok(parent) = std::env::var("GHOSTRACK_TEST_STATE_PARENT") {
        let expected = std::env::var("GHOSTRACK_TEST_STATE_EXPECTED").unwrap();
        assert_eq!(state_default().unwrap(), Path::new(&parent).join(expected));
        return;
    }
    for legacy in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let mut child = Command::new(std::env::current_exe().unwrap());
        child.args(["--exact", "the_platform_default_applies_the_rule"]);
        for name in ["HOME", "XDG_STATE_HOME", "LOCALAPPDATA", "USERPROFILE"] {
            child.env_remove(name);
        }
        let parent = if cfg!(windows) {
            child.env("LOCALAPPDATA", root.path().join("local"));
            root.path().join("local")
        } else {
            child.env("HOME", &home);
            home.join(".local/state")
        };
        if legacy {
            journal(&parent.join("gigahost"));
        }
        child.env("GHOSTRACK_TEST_STATE_PARENT", &parent).env(
            "GHOSTRACK_TEST_STATE_EXPECTED",
            if legacy { "gigahost" } else { "ghostrack" },
        );
        assert!(child.status().unwrap().success(), "legacy {legacy}");
    }
}
