#![cfg(unix)]
//! Exercise the real controller with local sidecar doubles, without sockets.
use ghostrack_desktop::{Controller, Request, process::Runner, store::Settings};
use serde_json::{Value, json};
use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
    path::PathBuf,
};

struct Fixture {
    root: tempfile::TempDir,
    controller: Controller,
    settings: Settings,
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let tool = root.path().join("tool.py");
        fs::write(&tool, include_str!("fixtures/sidecar.py")).unwrap();
        fs::set_permissions(&tool, fs::Permissions::from_mode(0o700)).unwrap();
        let wallet = root.path().join("wallet.dat");
        fs::write(&wallet, br#"{"identity":"wallet-one"}"#).unwrap();
        let seed = root.path().join("account.seed");
        fs::write(&seed, "disposable").unwrap();
        let settings = Settings {
            wallet_file: Some(wallet),
            ghost_seed_file: Some(seed),
            ..Settings::default()
        };
        let controller = Controller::new(
            root.path().join("state"),
            Runner {
                ghost: tool.clone(),
                wallet: tool,
            },
        )
        .unwrap();
        controller.store.save_settings(&settings).unwrap();
        Self {
            root,
            controller,
            settings,
        }
    }
    async fn call(&self, request: Value) -> ghostrack_desktop::Result<Value> {
        self.controller
            .dispatch(serde_json::from_value::<Request>(request).unwrap())
            .await
    }
    fn scenario(&self, value: Value) {
        fs::write(
            self.root.path().join("scenario.json"),
            serde_json::to_vec(&value).unwrap(),
        )
        .unwrap();
    }
    async fn payment(&self) -> ghostrack_desktop::Result<Value> {
        self.call(json!({"action":"prepare_send","purpose":"send","target":"disposable-recipient","amount":"1","memo":null,"passphrase":null})).await
    }
    fn restore(&self, new_instance: bool) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        let operation = if new_instance {
            json!({"kind":"create_from_backup","offering_id":"offering-one","gateway_tier":null})
        } else {
            json!({"kind":"restore_backup","instance_id":"destination"})
        };
        let review = json!({"request":{"operation":operation},"account":{"account_alias":"gh-test","key_epoch":1},"backup":{"recipient_key_fingerprint":"older-key"},"destination":offering(),"matching_recovery_files":[],"restore_charge_microusd":"1954"});
        let op=serde_json::from_value(json!({"id":id,"kind":"restore","state":"prepared","created_at":1,"wallet_file":null,"ghost_seed_file":self.settings.ghost_seed_file,"rpc_url":self.settings.rpc_url,"api_url":self.settings.api_url,"transaction_id":null,"digest":null,"review":review,"intent_id":id,"replacement_seed_file":null,"account_memo":null,"account_epoch":null,"job_id":null})).unwrap();
        self.controller.store.put(op).unwrap();
        id
    }
}
fn offering() -> Value {
    json!({"instance_creation_charge_microusd":"1000000","balance_reservation_microusd":"2000000","base_price_microusd_per_month":"10000000","full_utilization_price_microusd_per_month":"20000000","network_prices":[{"gateway_tier":null,"gateway_base_charge_microusd_per_month":"0","combined_microusd_per_tib":"3000000"}]})
}

#[tokio::test]
async fn payment_confirmations_survive_restart_and_old_journals_remain_readable() {
    let f = Fixture::new();
    let payment = f.payment().await.unwrap();
    let id = payment["id"].as_str().unwrap();
    // An older app never recorded confirmation counts.
    let journal = f.controller.store.root.join("operations.json");
    let mut saved: Value = serde_json::from_slice(&fs::read(&journal).unwrap()).unwrap();
    saved[0].as_object_mut().unwrap().remove("confirmations");
    fs::write(&journal, serde_json::to_vec(&saved).unwrap()).unwrap();
    assert_eq!(f.controller.store.get(id).unwrap().confirmations, None);
    for confirmations in [2, 10] {
        f.scenario(json!({"transaction":{"status":"included","confirmations":confirmations}}));
        f.call(json!({"action":"payment_status","id":id}))
            .await
            .unwrap();
        let saved = f.controller.store.get(id).unwrap();
        assert_eq!(saved.state, "included");
        assert_eq!(saved.confirmations, Some(confirmations));
    }
    let reopened = ghostrack_desktop::store::Store::new(f.controller.store.root.clone()).unwrap();
    assert_eq!(reopened.get(id).unwrap().confirmations, Some(10));
    // Further manual checks can observe a changed confirmation count.
    f.scenario(json!({"transaction":{"status":"included","confirmations":12}}));
    let status = f
        .call(json!({"action":"payment_status","id":id}))
        .await
        .unwrap();
    assert_eq!(status["confirmations"], 12);
    assert_eq!(reopened.get(id).unwrap().confirmations, Some(12));
}

#[tokio::test]
async fn pending_payment_blocks_copies_aliases_and_reencoded_wallets() {
    let mut f = Fixture::new();
    let op = f.payment().await.unwrap();
    assert_eq!(f.payment().await.unwrap_err().code, "payment_draft_exists");
    assert_eq!(
        f.call(json!({"action":"broadcast","id":op["id"]}))
            .await
            .unwrap_err()
            .code,
        "rpc_transport_error"
    );
    let original = f.settings.wallet_file.clone().unwrap();
    let copy = f.root.path().join("backup.dat");
    fs::copy(&original, &copy).unwrap();
    let alias = f.root.path().join("alias.dat");
    symlink(&original, &alias).unwrap();
    let encoded = f.root.path().join("backup.json");
    fs::write(&encoded, "{\n  \"identity\": \"wallet-one\"\n}\n").unwrap();
    for path in [original.clone(), copy, alias, encoded] {
        f.settings.wallet_file = Some(path);
        f.call(json!({"action":"save_settings","settings":f.settings}))
            .await
            .unwrap();
        assert_eq!(f.payment().await.unwrap_err().code, "payment_pending");
    }
    // A distinct derivation account is a different source of funds.
    f.settings.account_index = 1;
    f.call(json!({"action":"save_settings","settings":f.settings}))
        .await
        .unwrap();
    assert!(f.payment().await.is_ok());
}

#[tokio::test]
async fn old_journal_payment_is_upgraded_when_selecting_a_copy() {
    let mut f = Fixture::new();
    let value = f.payment().await.unwrap();
    let mut op = f
        .controller
        .store
        .get(value["id"].as_str().unwrap())
        .unwrap();
    op.state = "uncertain".into();
    op.wallet_address = None;
    f.controller.store.put(op).unwrap();
    let copy = f.root.path().join("backup.dat");
    fs::copy(f.settings.wallet_file.as_ref().unwrap(), &copy).unwrap();
    f.settings.wallet_file = Some(copy);
    f.controller.store.save_settings(&f.settings).unwrap();
    assert_eq!(f.payment().await.unwrap_err().code, "payment_pending");
    assert!(
        f.controller.store.operations().unwrap()[0]
            .wallet_address
            .is_some()
    );
}

#[tokio::test]
async fn replacing_a_legacy_wallet_cannot_poison_its_saved_identity() {
    let mut f = Fixture::new();
    let value = f.payment().await.unwrap();
    let mut op = f
        .controller
        .store
        .get(value["id"].as_str().unwrap())
        .unwrap();
    op.state = "uncertain".into();
    op.wallet_address = None;
    f.controller.store.put(op.clone()).unwrap();
    let original = f.settings.wallet_file.clone().unwrap();
    let backup = f.root.path().join("original-backup.dat");
    fs::copy(&original, &backup).unwrap();
    fs::write(&original, br#"{"identity":"wallet-two"}"#).unwrap();
    assert_eq!(
        f.payment().await.unwrap_err().code,
        "payment_identity_unknown"
    );
    assert!(
        f.controller
            .store
            .get(&op.id)
            .unwrap()
            .wallet_address
            .is_none()
    );
    f.settings.wallet_file = Some(backup);
    f.controller.store.save_settings(&f.settings).unwrap();
    assert_eq!(f.payment().await.unwrap_err().code, "payment_pending");
    assert_eq!(
        f.controller
            .store
            .get(&op.id)
            .unwrap()
            .wallet_address
            .as_deref(),
        Some("wallet-one-account-0")
    );
}

#[tokio::test]
async fn different_passphrase_cannot_poison_a_legacy_payment_identity() {
    let f = Fixture::new();
    let value = f.payment().await.unwrap();
    let mut op = f
        .controller
        .store
        .get(value["id"].as_str().unwrap())
        .unwrap();
    op.state = "uncertain".into();
    op.wallet_address = None;
    f.controller.store.put(op.clone()).unwrap();
    let result=f.call(json!({"action":"prepare_send","purpose":"send","target":"disposable-recipient","amount":"1","memo":null,"passphrase":"different derivation"})).await;
    assert_eq!(result.unwrap_err().code, "payment_identity_unknown");
    assert!(
        f.controller
            .store
            .get(&op.id)
            .unwrap()
            .wallet_address
            .is_none()
    );
    assert_eq!(f.payment().await.unwrap_err().code, "payment_pending");
    assert_eq!(
        f.controller
            .store
            .get(&op.id)
            .unwrap()
            .wallet_address
            .as_deref(),
        Some("wallet-one-account-0")
    );
}

#[tokio::test]
async fn validated_restore_seed_survives_failure_and_restart_and_is_exportable() {
    let f = Fixture::new();
    let id = f.restore(false);
    let recovery = f.root.path().join("older.seed");
    fs::write(&recovery, "disposable older seed").unwrap();
    let operation = f.controller.store.get(&id).unwrap().review["request"]["operation"].clone();
    f.scenario(json!({"operation":operation,"fail_authorization":true}));
    assert_eq!(
        f.call(json!({"action":"approve_restore","id":id,"recovery_seed_file":recovery}))
            .await
            .unwrap_err()
            .code,
        "destination_unavailable"
    );
    let op = f.controller.store.get(&id).unwrap();
    assert_eq!(op.state, "needs_resume");
    assert_eq!(
        op.review["matching_recovery_files"][0],
        recovery.to_str().unwrap()
    );
    assert!(
        f.controller
            .store
            .settings()
            .unwrap()
            .recovery_seed_files
            .contains(&recovery)
    );
    // Construct another controller over the same persisted journal.
    let tool = f.root.path().join("tool.py");
    let restarted = Controller::new(
        f.controller.store.root.clone(),
        Runner {
            ghost: tool.clone(),
            wallet: tool,
        },
    )
    .unwrap();
    f.scenario(json!({"operation":operation}));
    let result = restarted
        .dispatch(
            serde_json::from_value(
                json!({"action":"approve_restore","id":id,"recovery_seed_file":null}),
            )
            .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(result["job_id"], "job-one");
    let backup = f.root.path().join("recovery-backup.seed");
    f.call(json!({"action":"export_recovery_key","source":recovery,"destination":backup}))
        .await
        .unwrap();
    assert_eq!(fs::read(&backup).unwrap(), b"disposable older seed");
    assert_eq!(
        fs::metadata(&backup).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(f.call(json!({"action":"export_recovery_key","source":f.settings.ghost_seed_file,"destination":f.root.path().join("unregistered.seed")})).await.unwrap_err().code,"invalid_key");
}

#[tokio::test]
async fn wrong_recovery_seed_is_not_registered_and_changed_quote_is_not_authorized() {
    let f = Fixture::new();
    let id = f.restore(true);
    let recovery = f.root.path().join("older.seed");
    fs::write(&recovery, "disposable").unwrap();
    let operation = f.controller.store.get(&id).unwrap().review["request"]["operation"].clone();
    let mut changed = offering();
    changed["instance_creation_charge_microusd"] = json!("9999999");
    f.scenario(json!({"operation":operation,"offering":changed}));
    assert_eq!(
        f.call(json!({"action":"approve_restore","id":id,"recovery_seed_file":recovery}))
            .await
            .unwrap_err()
            .code,
        "price_changed"
    );
    assert_eq!(f.controller.store.get(&id).unwrap().state, "prepared");
    let mut unavailable = offering();
    unavailable["network_prices"] = json!([]);
    f.scenario(json!({"operation":operation,"offering":unavailable}));
    assert_eq!(
        f.call(json!({"action":"approve_restore","id":id,"recovery_seed_file":recovery}))
            .await
            .unwrap_err()
            .code,
        "price_unavailable"
    );
    f.scenario(
        json!({"operation":operation,"offering":offering(),"recovery_fingerprint":"wrong-key"}),
    );
    assert_eq!(
        f.call(json!({"action":"approve_restore","id":id,"recovery_seed_file":recovery}))
            .await
            .unwrap_err()
            .code,
        "recovery_key_mismatch"
    );
    assert!(
        f.controller
            .store
            .settings()
            .unwrap()
            .recovery_seed_files
            .is_empty()
    );
    // Already-admitted jobs resume against their accepted quote.
    f.scenario(json!({"operation":operation,"offering":changed,"started_job_id":"job-one"}));
    assert!(
        f.call(json!({"action":"approve_restore","id":id,"recovery_seed_file":recovery}))
            .await
            .is_ok()
    );
}

#[tokio::test]
async fn rotation_discards_only_drafts_for_the_rotated_account() {
    let f = Fixture::new();
    let base = f.payment().await.unwrap();
    let mut matching = f
        .controller
        .store
        .get(base["id"].as_str().unwrap())
        .unwrap();
    matching.kind = "top_up".into();
    matching.account_memo = Some("old-memo".into());
    f.controller.store.put(matching.clone()).unwrap();
    let mut other_seed = matching.clone();
    other_seed.id = uuid::Uuid::new_v4().to_string();
    other_seed.ghost_seed_file = Some(PathBuf::from("/tmp/other-account.seed"));
    f.controller.store.put(other_seed.clone()).unwrap();
    let mut other_api = matching.clone();
    other_api.id = uuid::Uuid::new_v4().to_string();
    other_api.api_url = "https://other.example".into();
    f.controller.store.put(other_api.clone()).unwrap();
    let replacement = f.root.path().join("replacement.seed");
    fs::write(&replacement, "disposable replacement").unwrap();
    let mut rotation = matching.clone();
    rotation.id = uuid::Uuid::new_v4().to_string();
    rotation.kind = "rotation".into();
    rotation.transaction_id = None;
    rotation.replacement_seed_file = Some(replacement.clone());
    rotation.review = json!({"account":{"account_alias":"gh-test","deposit_memo":"old-memo","key_epoch":1},"replacement":{"keys":{"recovery_key_fingerprint":"older-key","deposit_memo":"new-memo"}}});
    f.controller.store.put(rotation.clone()).unwrap();
    f.scenario(json!({"replacement_seed":replacement,"new_memo":"new-memo"}));
    f.call(json!({"action":"reconcile_rotation","id":rotation.id}))
        .await
        .unwrap();
    assert_eq!(
        f.controller.store.get(&matching.id).unwrap().state,
        "discarded"
    );
    assert_eq!(
        f.controller.store.get(&other_seed.id).unwrap().state,
        "prepared"
    );
    assert_eq!(
        f.controller.store.get(&other_api.id).unwrap().state,
        "prepared"
    );
}

/// The website password's requests build `ghost`'s arguments themselves
/// from the expiry alone, and hand the UI only the password and its dates.
#[tokio::test]
async fn website_password_requests_build_their_own_arguments() {
    let f = Fixture::new();
    let args = || -> Vec<String> {
        serde_json::from_slice(&fs::read(f.root.path().join("ghost-args.json")).unwrap()).unwrap()
    };
    let tail =
        |args: Vec<String>| args[args.iter().position(|a| a == "account").unwrap()..].to_vec();
    let set = f
        .call(json!({"action":"set_website_password","expires_in_days":null}))
        .await
        .unwrap();
    assert_eq!(
        set,
        json!({"password":"Abcd-2345.efgh!?","created_at":"2026-10-13T09:00:00Z","expires_at":null})
    );
    assert_eq!(tail(args()), ["account", "set-password"]);
    assert!(args().contains(&"--compact".to_owned()));
    let set = f
        .call(json!({"action":"set_website_password","expires_in_days":90}))
        .await
        .unwrap();
    assert_eq!(set["expires_at"], "2027-01-11T09:00:00Z");
    assert_eq!(
        tail(args()),
        ["account", "set-password", "--expires-in", "90"]
    );
    for days in [0, 3651] {
        let refused = f
            .call(json!({"action":"set_website_password","expires_in_days":days}))
            .await
            .unwrap_err();
        assert_eq!(refused.code, "invalid_expiry");
    }
    // Free text never reaches the arguments.
    assert!(
        serde_json::from_value::<Request>(
            json!({"action":"set_website_password","expires_in_days":"90 --print"})
        )
        .is_err()
    );
    assert!(
        serde_json::from_value::<Request>(
            json!({"action":"set_website_password","expires_in_days":null,"args":["--print"]})
        )
        .is_err()
    );
    let removed = f
        .call(json!({"action":"remove_website_password"}))
        .await
        .unwrap();
    assert_eq!(removed, json!({"removed":true}));
    assert_eq!(tail(args()), ["account", "remove-password"]);
    f.scenario(json!({"fail_password":true}));
    let refused = f
        .call(json!({"action":"set_website_password","expires_in_days":null}))
        .await
        .unwrap_err();
    assert_eq!(refused.code, "signed_request_required");
}

#[tokio::test]
async fn github_claims_are_started_and_read_with_arguments_the_app_builds() {
    let f = Fixture::new();
    let args = || -> Vec<String> {
        let text = fs::read(f.root.path().join("ghost-args.json")).unwrap();
        serde_json::from_slice(&text).unwrap()
    };
    let tail =
        |args: Vec<String>| args[args.iter().position(|a| a == "account").unwrap()..].to_vec();
    let claim = f.call(json!({"action":"github_signup"})).await.unwrap();
    assert_eq!(claim["claim_id"], "claim-one");
    assert_eq!(tail(args()), ["account", "signup", "--github", "--no-wait"]);
    let claim = f.call(json!({"action":"github_link"})).await.unwrap();
    assert_eq!(claim["claim_id"], "claim-one");
    assert_eq!(tail(args()), ["account", "link-github", "--no-wait"]);
    let unlinked = f.call(json!({"action":"github_unlink"})).await.unwrap();
    assert_eq!(unlinked["unlinked"], true);
    assert_eq!(tail(args()), ["account", "unlink-github", "--yes"]);
    let status = f
        .call(json!({"action":"github_status","claim_id":"claim-one"}))
        .await
        .unwrap();
    assert_eq!(status["status"], "pending");
    assert_eq!(
        tail(args()),
        ["account", "github-status", "--", "claim-one"]
    );
    let refused = f
        .call(json!({"action":"github_status","claim_id":"--compact x"}))
        .await
        .unwrap_err();
    assert_eq!(refused.code, "invalid_github_claim");
    // A link away from the configured website is never handed to the app.
    f.scenario(json!({"claim_url":"https://evil.example/trial/start?claim=claim-one"}));
    for action in ["github_signup", "github_link"] {
        let refused = f.call(json!({"action":action})).await.unwrap_err();
        assert_eq!(refused.code, "invalid_github_claim");
    }
}

/// An import runs `ghost key import` on the app's account key file, with a
/// pasted line on its standard input as it is, never in its arguments, and
/// selects that file; a request with both or neither of a file and a line
/// is refused without repeating the line.
#[tokio::test]
async fn account_keys_are_imported_through_ghost() {
    let f = Fixture::new();
    let args = || -> Vec<String> {
        serde_json::from_slice(&fs::read(f.root.path().join("ghost-args.json")).unwrap()).unwrap()
    };
    let stdin = || fs::read(f.root.path().join("ghost-stdin.txt")).unwrap();
    let tail = |args: Vec<String>| args[args.iter().position(|a| a == "key").unwrap()..].to_vec();
    let seed = f.settings.ghost_seed_file.clone().unwrap();
    let line = "gigahost-account-seed-v1:BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc";
    let imported = f
        .call(json!({"action":"import_account","file":null,"line":line}))
        .await
        .unwrap();
    assert_eq!(imported["result"], "imported");
    assert_eq!(tail(args()), ["key", "import"]);
    let called = args();
    let at = called.iter().position(|a| a == "--seed-file").unwrap();
    assert_eq!(called[at + 1], seed.to_string_lossy());
    assert!(!called.iter().any(|a| a.contains(line)));
    assert_eq!(stdin(), format!("{line}\n").into_bytes());
    assert_eq!(
        f.controller.store.settings().unwrap().ghost_seed_file,
        Some(seed.clone())
    );

    let download = f.root.path().join("account.seed.download");
    fs::write(&download, line).unwrap();
    f.call(json!({"action":"import_account","file":download,"line":null}))
        .await
        .unwrap();
    assert_eq!(
        tail(args()),
        ["key", "import", "--from", &*download.to_string_lossy()]
    );
    assert!(stdin().is_empty());

    f.scenario(json!({"import_exists":true}));
    let refused = f
        .call(json!({"action":"import_account","file":null,"line":line}))
        .await
        .unwrap_err();
    assert_eq!(refused.code, "account_key_exists");
    let replaced = f
        .call(json!({"action":"import_account","file":null,"line":line,"replace":true}))
        .await
        .unwrap();
    assert_eq!(replaced["result"], "replaced");
    assert_eq!(tail(args()), ["key", "import", "--replace"]);

    for request in [
        json!({"action":"import_account","file":download,"line":line}),
        json!({"action":"import_account","file":null,"line":null}),
        json!({"action":"import_account","file":null,"line":"   "}),
        json!({"action":"import_account","file":null,"line":format!("{line}{}", "A".repeat(300))}),
        json!({"action":"import_account","file":"relative.seed","line":null}),
    ] {
        let refused = f.call(request).await.unwrap_err();
        assert!(
            ["invalid_input", "invalid_path"].contains(&refused.code.as_str()),
            "{}",
            refused.code
        );
        assert!(!refused.message.contains("BwcHBwcH"), "{}", refused.message);
    }
    // Nothing but the file, the line and `replace` reaches the request.
    assert!(
        serde_json::from_value::<Request>(
            json!({"action":"import_account","file":null,"line":line,"args":["--print"]})
        )
        .is_err()
    );
}
