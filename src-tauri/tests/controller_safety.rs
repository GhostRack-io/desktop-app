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

const FORCED: &str = "Keeps a backup first: up to $1.50, locked until 2026-11-20.";

/// A restore over an older instance keeps a backup of it first (item 267):
/// the review names it as Ghost does, and a different one is not
/// authorized.
#[tokio::test]
async fn the_backup_kept_first_is_reviewed_and_must_not_change() {
    let f = Fixture::new();
    let intent = uuid::Uuid::new_v4().to_string();
    let backup_id = uuid::Uuid::new_v4().to_string();
    let operation =
        json!({"kind":"restore_backup","instance_id":"destination","backup_id":backup_id});
    let backup = json!({"backup_id":backup_id,"instance_id":"source","destination":"gigahost_s3","recipient_key_fingerprint":"older-key","size_bytes":1073741824_u64,"restore_charge_microusd_per_gib":"1000","locked_until":"2026-11-20T00:00:00Z","wrapped_data_key":"secret"});
    f.scenario(json!({"operation":operation,"backup":backup,"instance":{"instance_id":"destination"},"forced_backup":FORCED}));
    let op = f
        .call(json!({"action":"inspect_restore","reference":intent}))
        .await
        .unwrap();
    assert_eq!(op["review"]["forced_backup"], FORCED);
    assert_eq!(
        op["review"]["backup"]["locked_until"],
        "2026-11-20T00:00:00Z"
    );
    assert!(op["review"]["backup"]["wrapped_data_key"].is_null());
    let id = op["id"].as_str().unwrap();
    let recovery = f.root.path().join("older.seed");
    fs::write(&recovery, "disposable").unwrap();
    // The quote now keeps another backup: review it again.
    f.scenario(json!({"operation":operation,"backup":backup,"instance":{"instance_id":"destination"},"forced_backup":"Keeps a backup first: up to $9.00, locked until 2026-11-20."}));
    assert_eq!(
        f.call(json!({"action":"approve_restore","id":id,"recovery_seed_file":recovery}))
            .await
            .unwrap_err()
            .code,
        "approval_changed"
    );
    f.scenario(json!({"operation":operation,"backup":backup,"instance":{"instance_id":"destination"},"forced_backup":FORCED}));
    let result = f
        .call(json!({"action":"approve_restore","id":id,"recovery_seed_file":recovery}))
        .await
        .unwrap();
    assert_eq!(result["job_id"], "job-one");
    // A new instance keeps none.
    let unforced = f.restore(false);
    let operation =
        f.controller.store.get(&unforced).unwrap().review["request"]["operation"].clone();
    f.scenario(json!({"operation":operation,"forced_backup":FORCED}));
    assert_eq!(
        f.call(json!({"action":"approve_restore","id":unforced,"recovery_seed_file":recovery}))
            .await
            .unwrap_err()
            .code,
        "approval_changed"
    );
}

/// A destination whose deletion waits is kept from the review, which is
/// then read again (item 267).
#[tokio::test]
async fn keep_it_keeps_the_destination_and_reviews_the_restore_again() {
    let f = Fixture::new();
    let intent = uuid::Uuid::new_v4().to_string();
    let backup_id = uuid::Uuid::new_v4().to_string();
    let operation =
        json!({"kind":"restore_backup","instance_id":"destination","backup_id":backup_id});
    let backup = json!({"backup_id":backup_id,"instance_id":"source","destination":"gigahost_s3","recipient_key_fingerprint":"older-key","size_bytes":1073741824_u64,"restore_charge_microusd_per_gib":"1000"});
    f.scenario(json!({"operation":operation,"backup":backup,"instance":{"instance_id":"destination","delete_at":"2026-11-13T12:00:00Z"}}));
    let op = f
        .call(json!({"action":"inspect_restore","reference":intent}))
        .await
        .unwrap();
    assert_eq!(
        op["review"]["destination"]["delete_at"],
        "2026-11-13T12:00:00Z"
    );
    assert!(op["review"]["forced_backup"].is_null());
    let id = op["id"].as_str().unwrap();
    let fresh = f
        .call(json!({"action":"keep_restore_destination","id":id}))
        .await
        .unwrap();
    let args: Vec<String> =
        serde_json::from_slice(&fs::read(f.root.path().join("ghost-args.json")).unwrap()).unwrap();
    assert!(args.ends_with(&["instance".into(), "keep".into(), "destination".into()]));
    assert!(fresh["review"]["destination"]["delete_at"].is_null());
    assert_eq!(fresh["state"], "prepared");
    assert_eq!(f.controller.store.get(id).unwrap().state, "discarded");
    // Kept, there is nothing more to keep.
    assert_eq!(
        f.call(json!({"action":"keep_restore_destination","id":fresh["id"]}))
            .await
            .unwrap_err()
            .code,
        "approval_state"
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
    let line = "ghostrack-account-seed-v1:BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc";
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

/// A payout request carries the reviewed MMX atoms as an exact decimal and
/// the review's own idempotency key; a review saved in dollars by the earlier
/// app is never sent, can always be discarded and never blocks a new review.
#[tokio::test]
async fn payouts_are_requested_in_mmx_and_dollar_reviews_are_never_sent() {
    let f = Fixture::new();
    let address = "mmx1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqdgytev";
    f.scenario(json!({"provider_balance":{
        "pending_payout_microusd":"0","available_payout_microusd":"0","held_microusd":"0",
        "on_the_way_microusd":"0","sla_settlement_pending":true,
        "available_payout_mmx_atomic":"20000000","on_the_way_mmx_atomic":"0",
        "waiting_for_exchange_rate":false,"payout_address":address}}));
    let dollar = |state: &str| {
        let id = uuid::Uuid::new_v4().to_string();
        let op = serde_json::from_value(json!({"id":id,"kind":"payout","state":state,"created_at":1,"wallet_file":null,"ghost_seed_file":f.settings.ghost_seed_file,"rpc_url":f.settings.rpc_url,"api_url":f.settings.api_url,"transaction_id":null,"digest":null,"review":{"account_alias":"gh-test","previous_address":address,"address":address,"amount_microusd":"40010000"},"intent_id":null,"replacement_seed_file":null,"account_memo":"old-memo","account_epoch":null,"job_id":null})).unwrap();
        f.controller.store.put(op).unwrap();
        id
    };
    let old = dollar("prepared");
    let sent = dollar("uncertain");
    let refused = f
        .call(json!({"action":"confirm_payout","id":old}))
        .await
        .unwrap_err();
    assert_eq!(refused.code, "payout_review_outdated");
    assert!(refused.message.starts_with("This review is in dollars."));
    let refused = f
        .call(json!({"action":"confirm_payout","id":sent}))
        .await
        .unwrap_err();
    assert_eq!(refused.code, "payout_review_outdated");
    assert!(
        refused
            .message
            .starts_with("This saved request is in dollars.")
    );
    assert!(!f.root.path().join("ghost-args.json").exists());
    // They never block a new review in MMX, which an outage does not hold.
    let over = f
        .call(json!({"action":"prepare_payout","amount":"20.000001"}))
        .await
        .unwrap_err();
    assert_eq!(over.code, "invalid_payout_amount");
    assert!(over.message.contains("no more than 20 MMX"));
    let review = f
        .call(json!({"action":"prepare_payout","amount":"12.5"}))
        .await
        .unwrap();
    assert_eq!(review["review"]["amount_mmx_atomic"], "12500000");
    assert!(review["review"]["amount_microusd"].is_null());
    f.call(json!({"action":"confirm_payout","id":review["id"]}))
        .await
        .unwrap();
    let args: Vec<String> =
        serde_json::from_slice(&fs::read(f.root.path().join("ghost-args.json")).unwrap()).unwrap();
    let at = args.iter().position(|a| a == "provider").unwrap();
    assert_eq!(
        args[at..at + 6],
        [
            "provider",
            "payout",
            "--amount",
            "12.5",
            "--idempotency-key",
            review["id"].as_str().unwrap()
        ]
    );
    // A dollar review is discarded in every state.
    for id in [old, sent] {
        let discarded = f
            .call(json!({"action":"discard_payout","id":id}))
            .await
            .unwrap();
        assert_eq!(discarded["state"], "discarded");
    }
    // An MMX review that may have been sent keeps today's rule.
    let mut mmx = f
        .controller
        .store
        .get(review["id"].as_str().unwrap())
        .unwrap();
    mmx.state = "uncertain".into();
    f.controller.store.put(mmx.clone()).unwrap();
    let kept = f
        .call(json!({"action":"discard_payout","id":mmx.id}))
        .await
        .unwrap_err();
    assert_eq!(kept.code, "payout_state");
}

/// Ghost's answer to `account approve` for an instance action of `kind`:
/// the request, with a pasted key, and the approval screen's rows.
fn instance_action(kind: &str) -> (Value, Value) {
    let operation = json!({"kind":kind,"instance_id":"web-id","request":{"ssh_public_keys":["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4f laptop"]}});
    let shown = json!({
        "review":[
            {"label":"Instance","value":"running, 2 vCPU, 4 GiB RAM, 20 GiB disk, Singapore"},
            {"label":"SSH keys","value":"work"},
            {"label":"","value":"ssh-ed25519 SHA256:ZkAslGjFiUHdGf/WUL8rQvkib4PTvQatUV0OUQSncCA laptop"},
        ],
        "review_effects":["Reinstall destroys the current root filesystem and starts the instance if it is stopped."],
        "instance_name":"web",
        "review_notice":"Approving reinstalls the instance as shown above.",
        "notice":"Approving reinstalls the instance, which destroys its root filesystem, and may keep a backup of an older instance first, which is charged. Inspect the request before approving.",
    });
    (operation, shown)
}

/// The SHA-256 of `operation` as JSON, as an instance action's review
/// keeps it.
fn digest(operation: &Value) -> String {
    use sha2::Digest;
    hex::encode(sha2::Sha256::digest(serde_json::to_vec(operation).unwrap()))
}

fn ghost_args(f: &Fixture) -> Option<Vec<String>> {
    fs::read(f.root.path().join("ghost-args.json"))
        .ok()
        .map(|bytes| serde_json::from_slice(&bytes).unwrap())
}

/// A reinstall, an SSH access reset and a rescue boot are reviewed from
/// Ghost's screen and approved with `--yes` and no recovery key (item
/// 296b); a restore still needs one.
#[tokio::test]
async fn instance_actions_are_reviewed_as_ghost_shows_them_and_approved_without_a_recovery_key() {
    for kind in [
        "reinstall_instance",
        "reset_instance_access",
        "rescue_instance",
    ] {
        let f = Fixture::new();
        let intent = uuid::Uuid::new_v4().to_string();
        let (operation, shown) = instance_action(kind);
        f.scenario(json!({"operation":operation,"shown":shown}));
        let op = f
            .call(json!({"action":"inspect_restore","reference":format!("ghostrack://approve?intent={intent}")}))
            .await
            .unwrap();
        assert_eq!(op["kind"], "instance_action");
        assert_eq!(op["state"], "prepared");
        // Ghost's screen, with the notice that points at it, and the
        // operation by its digest alone.
        assert_eq!(
            op["review"],
            json!({
                "intent_id": intent,
                "kind": kind,
                "instance_id": "web-id",
                "instance_name": "web",
                "review": shown["review"],
                "review_effects": shown["review_effects"],
                "notice": shown["review_notice"],
                "expires_at": "2099-01-01T00:00:00Z",
                "operation_sha256": digest(&operation),
            })
        );
        // The restore's approval is not this one's.
        assert_eq!(
            f.call(json!({"action":"approve_restore","id":op["id"],"recovery_seed_file":null}))
                .await
                .unwrap_err()
                .code,
            "approval_state"
        );
        assert!(ghost_args(&f).is_none());
        let approved = f
            .call(json!({"action":"approve_instance_action","id":op["id"]}))
            .await
            .unwrap();
        assert_eq!(approved["job_id"], "job-two");
        let args = ghost_args(&f).unwrap();
        let at = args.iter().position(|a| a == "account").unwrap();
        assert_eq!(args[at..], ["account", "approve", &intent, "--yes"]);
        assert!(
            !args.iter().any(|a| a == "--recovery-seed-file"),
            "{args:?}"
        );
        let saved = f.controller.store.get(op["id"].as_str().unwrap()).unwrap();
        assert_eq!(saved.state, "authorized");
        assert_eq!(saved.job_id.as_deref(), Some("job-two"));
        // Approved once.
        assert_eq!(
            f.call(json!({"action":"approve_instance_action","id":op["id"]}))
                .await
                .unwrap_err()
                .code,
            "approval_state"
        );
    }
    // A restore is not approved as an instance action.
    let f = Fixture::new();
    let restore = f.restore(false);
    assert_eq!(
        f.call(json!({"action":"approve_instance_action","id":restore}))
            .await
            .unwrap_err()
            .code,
        "approval_state"
    );
    // A Ghost that gives no notice for below the review shows the one that
    // says what approving does itself.
    let f = Fixture::new();
    let (operation, mut shown) = instance_action("rescue_instance");
    shown.as_object_mut().unwrap().remove("review_notice");
    f.scenario(json!({"operation":operation,"shown":shown}));
    let op = f
        .call(json!({"action":"inspect_restore","reference":uuid::Uuid::new_v4().to_string()}))
        .await
        .unwrap();
    assert_eq!(op["review"]["notice"], shown["notice"]);
}

/// A kind this app does not know, or a Ghost that gives no screen for an
/// instance action, is refused at the review, never approved; so is one
/// whose instance Ghost could not read, which its review would leave out.
#[tokio::test]
async fn an_unknown_kind_or_a_ghost_without_the_screen_needs_a_newer_desktop() {
    let f = Fixture::new();
    let intent = uuid::Uuid::new_v4().to_string();
    let (operation, shown) = instance_action("reinstall_instance");
    let refusals = [
        json!({"operation":{"kind":"rotate_gateway_keys","instance_id":"web-id"}}),
        json!({"operation":operation}),
        json!({"operation":operation,"shown":{"notice":shown["notice"]}}),
        json!({"operation":operation,"shown":{"review":[],"review_effects":[],"notice":shown["notice"]}}),
        json!({"operation":operation,"shown":{"review":shown["review"],"notice":shown["notice"]}}),
        json!({"operation":operation,"shown":{"review":[{"label":"Instance","value":1}],"review_effects":[],"notice":shown["notice"]}}),
        json!({"operation":operation,"shown":{"review":shown["review"],"review_effects":[],"instance_name":"web"}}),
    ];
    for scenario in refusals {
        f.scenario(scenario.clone());
        let refused = f
            .call(json!({"action":"inspect_restore","reference":intent}))
            .await
            .unwrap_err();
        assert_eq!(refused.code, "unsupported_approval", "{scenario}");
        assert_eq!(
            refused.message, "This approval needs a newer GhostRack desktop.",
            "{scenario}"
        );
    }
    // Ghost names the instance only when it could read it.
    let mut unread = shown.clone();
    unread["instance_name"] = Value::Null;
    unread["review"] = json!([{"label":"SSH keys","value":"work"}]);
    f.scenario(json!({"operation":operation,"shown":unread}));
    let refused = f
        .call(json!({"action":"inspect_restore","reference":intent}))
        .await
        .unwrap_err();
    assert_eq!(refused.code, "instance_unavailable");
    assert_eq!(
        refused.message,
        "The instance could not be read. Try again."
    );
    assert!(f.controller.store.operations().unwrap().is_empty());
    assert!(ghost_args(&f).is_none());
}

/// The request approved is the one last shown: a changed operation, a
/// changed row (another saved key, or the instance's state), a changed
/// effect (a backup kept first, or its lock's day) or an instance Ghost
/// could not read is refused before `--yes`. A changed review replaces the
/// saved one, so that is the one approved.
#[tokio::test]
async fn an_instance_action_that_changed_since_its_review_is_not_approved() {
    let f = Fixture::new();
    let intent = uuid::Uuid::new_v4().to_string();
    let (operation, shown) = instance_action("reinstall_instance");
    f.scenario(json!({"operation":operation,"shown":shown}));
    let op = f
        .call(json!({"action":"inspect_restore","reference":intent}))
        .await
        .unwrap();
    let id = op["id"].as_str().unwrap();
    let mut other_key = operation.clone();
    other_key["request"]["ssh_public_keys"][0] = json!(
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB8eHRwbGhkYFxYVFBMSERAPDg0MCwoJCAcGBQQDAgEA other"
    );
    let mut other_row = shown.clone();
    other_row["review"][1]["value"] = json!("work, added");
    let mut stopped = shown.clone();
    stopped["review"][0]["value"] = json!("stopped, 2 vCPU, 4 GiB RAM, 20 GiB disk, Singapore");
    let mut other_effect = shown.clone();
    other_effect["review_effects"]
        .as_array_mut()
        .unwrap()
        .push(json!(
            "Keeps a backup first: up to $9.00, locked until 2026-11-27."
        ));
    let mut next_day = other_effect.clone();
    next_day["review_effects"][1] =
        json!("Keeps a backup first: up to $9.00, locked until 2026-11-28.");
    for (operation, shown) in [
        (&other_key, &shown),
        (&operation, &other_row),
        (&operation, &stopped),
        (&operation, &other_effect),
        (&operation, &next_day),
    ] {
        f.scenario(json!({"operation":operation,"shown":shown}));
        let refused = f
            .call(json!({"action":"approve_instance_action","id":id}))
            .await
            .unwrap_err();
        assert_eq!(refused.code, "approval_changed", "{shown}");
        assert_eq!(refused.message, "The request changed. Review it again.");
        assert!(ghost_args(&f).is_none(), "{shown}");
        // Saved as it is now, for the dialog and the saved operation's
        // Review to show.
        let kept = f.controller.store.get(id).unwrap();
        assert_eq!(kept.state, "prepared");
        assert_eq!(kept.review["review"], shown["review"]);
        assert_eq!(kept.review["review_effects"], shown["review_effects"]);
        assert_eq!(kept.review["operation_sha256"], digest(operation));
    }
    assert_eq!(f.controller.store.operations().unwrap().len(), 1);
    // A Ghost that stopped giving the screen, or could not read the
    // instance, is refused too, and the review shown is kept.
    let mut unread = next_day.clone();
    unread["instance_name"] = Value::Null;
    for (scenario, code) in [
        (json!({"operation":operation}), "unsupported_approval"),
        (
            json!({"operation":operation,"shown":unread}),
            "instance_unavailable",
        ),
    ] {
        f.scenario(scenario.clone());
        assert_eq!(
            f.call(json!({"action":"approve_instance_action","id":id}))
                .await
                .unwrap_err()
                .code,
            code,
            "{scenario}"
        );
        assert_eq!(
            f.controller.store.get(id).unwrap().review["review_effects"],
            next_day["review_effects"]
        );
    }
    assert!(ghost_args(&f).is_none());
    // The request as first reviewed is not the one last shown.
    f.scenario(json!({"operation":operation,"shown":shown}));
    assert_eq!(
        f.call(json!({"action":"approve_instance_action","id":id}))
            .await
            .unwrap_err()
            .code,
        "approval_changed"
    );
    assert!(ghost_args(&f).is_none());
    // Unchanged since it was last shown, it is approved.
    let approved = f
        .call(json!({"action":"approve_instance_action","id":id}))
        .await
        .unwrap();
    assert_eq!(approved["job_id"], "job-two");
}

/// An approval whose answer was lost while its job started is finished
/// when it is approved again: the job accepted it, and the instance now
/// reinstalling is not a change to review.
#[tokio::test]
async fn an_instance_action_whose_answer_was_lost_is_finished_once_its_job_started() {
    let f = Fixture::new();
    let intent = uuid::Uuid::new_v4().to_string();
    let (operation, shown) = instance_action("reinstall_instance");
    f.scenario(json!({"operation":operation,"shown":shown}));
    let op = f
        .call(json!({"action":"inspect_restore","reference":intent}))
        .await
        .unwrap();
    let id = op["id"].as_str().unwrap();
    f.scenario(json!({"operation":operation,"shown":shown,"fail_approval":true}));
    f.call(json!({"action":"approve_instance_action","id":id}))
        .await
        .unwrap_err();
    assert_eq!(f.controller.store.get(id).unwrap().state, "needs_resume");
    let mut reinstalling = shown.clone();
    reinstalling["review"][0]["value"] =
        json!("reinstalling, 2 vCPU, 4 GiB RAM, 20 GiB disk, Singapore");
    reinstalling["review_effects"] = json!([]);
    fs::write(f.root.path().join("ghost-args.json"), b"[]").unwrap();
    f.scenario(json!({"operation":operation,"shown":reinstalling,"started_job_id":"job-two"}));
    let finished = f
        .call(json!({"action":"approve_instance_action","id":id}))
        .await
        .unwrap();
    assert_eq!(finished["job_id"], "job-two");
    let args = ghost_args(&f).unwrap();
    assert!(args.iter().any(|a| a == "--yes"), "{args:?}");
    let saved = f.controller.store.get(id).unwrap();
    assert_eq!(saved.state, "authorized");
    // A job started for another operation is not this approval's.
    let f = Fixture::new();
    f.scenario(json!({"operation":operation,"shown":shown}));
    let op = f
        .call(json!({"action":"inspect_restore","reference":intent}))
        .await
        .unwrap();
    let mut other = operation.clone();
    other["request"]["ssh_public_keys"] = json!([]);
    f.scenario(json!({"operation":other,"shown":reinstalling,"started_job_id":"job-two"}));
    assert_eq!(
        f.call(json!({"action":"approve_instance_action","id":op["id"]}))
            .await
            .unwrap_err()
            .code,
        "approval_changed"
    );
    assert!(ghost_args(&f).is_none());
}

/// A review keeps the operation by its digest, not its data (a cloud-init
/// can be about a megabyte); a request reviewed again keeps one saved
/// review; and one that expired unsent is no longer approved and ends.
#[tokio::test]
async fn instance_action_reviews_are_small_one_per_request_and_expire() {
    let f = Fixture::new();
    let intent = uuid::Uuid::new_v4().to_string();
    let (mut operation, shown) = instance_action("reinstall_instance");
    let cloud_init = format!("#cloud-config\n{}", "x".repeat(512 * 1024));
    operation["request"]["cloud_init"] = json!(cloud_init);
    f.scenario(json!({"operation":operation,"shown":shown}));
    let first = f
        .call(json!({"action":"inspect_restore","reference":intent}))
        .await
        .unwrap();
    let again = f
        .call(json!({"action":"inspect_restore","reference":format!("ghostrack://approve?intent={intent}")}))
        .await
        .unwrap();
    assert_eq!(again["id"], first["id"]);
    assert_eq!(again["review"]["operation_sha256"], digest(&operation));
    let journal = fs::read(f.root.path().join("state/operations.json")).unwrap();
    assert!(journal.len() < 8 * 1024, "{} bytes", journal.len());
    assert!(!String::from_utf8_lossy(&journal).contains("xxxxxxxx"));
    // After a lost answer, reviewing it again keeps its state.
    f.scenario(json!({"operation":operation,"shown":shown,"fail_approval":true}));
    f.call(json!({"action":"approve_instance_action","id":first["id"]}))
        .await
        .unwrap_err();
    f.scenario(json!({"operation":operation,"shown":shown}));
    let resumed = f
        .call(json!({"action":"inspect_restore","reference":intent}))
        .await
        .unwrap();
    assert_eq!(resumed["id"], first["id"]);
    assert_eq!(resumed["state"], "needs_resume");
    assert_eq!(f.controller.store.operations().unwrap().len(), 1);

    // Expired unsent: refused without asking Ghost, and ended.
    let f = Fixture::new();
    let expired = uuid::Uuid::new_v4().to_string();
    f.scenario(json!({"operation":operation,"shown":shown,"expires_at":"2026-01-01T00:00:00.5Z"}));
    let old = f
        .call(json!({"action":"inspect_restore","reference":expired}))
        .await
        .unwrap();
    let other = f
        .call(json!({"action":"inspect_restore","reference":uuid::Uuid::new_v4().to_string()}))
        .await
        .unwrap();
    assert_eq!(
        f.controller
            .store
            .get(old["id"].as_str().unwrap())
            .unwrap()
            .state,
        "expired",
        "another review ends it"
    );
    let refused = f
        .call(json!({"action":"approve_instance_action","id":other["id"]}))
        .await
        .unwrap_err();
    assert_eq!(refused.code, "approval_expired");
    assert_eq!(
        refused.message,
        "This request has expired. Create a new one on the website."
    );
    assert_eq!(
        f.controller
            .store
            .get(other["id"].as_str().unwrap())
            .unwrap()
            .state,
        "expired"
    );
    assert!(ghost_args(&f).is_none());
    assert_eq!(
        f.call(json!({"action":"approve_instance_action","id":other["id"]}))
            .await
            .unwrap_err()
            .code,
        "approval_state"
    );
    // Reviewed again, an expired request gets a new saved review.
    f.scenario(json!({"operation":operation,"shown":shown}));
    let renewed = f
        .call(json!({"action":"inspect_restore","reference":expired}))
        .await
        .unwrap();
    assert_ne!(renewed["id"], old["id"]);
    assert_eq!(renewed["state"], "prepared");
}

/// A request carried out already is not reviewed again; one carried out
/// while its approval was interrupted is recorded as approved.
#[tokio::test]
async fn an_instance_action_carried_out_already_is_not_approved_again() {
    let f = Fixture::new();
    let intent = uuid::Uuid::new_v4().to_string();
    let (operation, shown) = instance_action("rescue_instance");
    f.scenario(json!({"operation":operation,"shown":shown}));
    let op = f
        .call(json!({"action":"inspect_restore","reference":intent}))
        .await
        .unwrap();
    f.scenario(json!({"operation":operation,"shown":shown,"completed_job_id":"job-one"}));
    assert_eq!(
        f.call(json!({"action":"inspect_restore","reference":intent}))
            .await
            .unwrap_err()
            .code,
        "approval_state"
    );
    let done = f
        .call(json!({"action":"approve_instance_action","id":op["id"]}))
        .await
        .unwrap();
    assert_eq!(done["completed_job_id"], "job-one");
    assert!(ghost_args(&f).is_none());
    let saved = f.controller.store.get(op["id"].as_str().unwrap()).unwrap();
    assert_eq!(saved.state, "authorized");
    assert_eq!(saved.job_id.as_deref(), Some("job-one"));
}
