use crate::{
    process::{Failure, Result, Runner, Secret},
    store::{Operation, Settings, Store, save},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::sync::Mutex;
use url::Url;
use uuid::Uuid;
use zeroize::Zeroizing;

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    Snapshot {
        passphrase: Option<String>,
    },
    SaveSettings {
        settings: Settings,
    },
    CreateWallet {
        file: Option<PathBuf>,
        mnemonic: Option<String>,
        passphrase: Option<String>,
    },
    CreateAccount {
        file: Option<PathBuf>,
    },
    /// Puts an account key made elsewhere in the app's account key file
    /// (`ghost key import`): from `file`, or from `line`, the pasted
    /// `gigahost-account-seed-v1:…` line, which goes to `ghost` on its
    /// standard input and nowhere else. Exactly one of the two.
    ImportAccount {
        file: Option<PathBuf>,
        line: Option<String>,
        #[serde(default)]
        replace: bool,
    },
    ActivateAccount,
    /// Asks for a GitHub sign-up claim (`ghost account signup --github
    /// --no-wait`); the app opens the claim's link itself.
    GithubSignup,
    /// Asks for a claim that links a GitHub account to this account
    /// (`ghost account link-github --no-wait`); the app opens its link.
    GithubLink,
    /// Unlinks the account's GitHub account (`ghost account unlink-github
    /// --yes`); the window confirms first.
    GithubUnlink,
    /// Reads a GitHub claim once (`ghost account github-status`).
    GithubStatus {
        claim_id: String,
    },
    PreparePayout {
        amount: String,
    },
    PreparePayoutAddress {
        address: String,
    },
    ConfirmPayout {
        id: String,
    },
    PayoutReview {
        id: String,
    },
    DiscardPayout {
        id: String,
    },
    PrepareSend {
        target: String,
        amount: String,
        memo: Option<String>,
        passphrase: Option<String>,
        purpose: String,
    },
    Broadcast {
        id: String,
    },
    PaymentStatus {
        id: String,
    },
    DiscardPayment {
        id: String,
    },
    Login,
    RevokeSessions,
    /// Draws a new website password (`ghost account set-password`), which
    /// replaces the old one and ends the website sessions it began.
    SetWebsitePassword {
        expires_in_days: Option<u32>,
    },
    /// Turns website password login off (`ghost account remove-password`).
    RemoveWebsitePassword,
    InspectRestore {
        reference: String,
    },
    ApproveRestore {
        id: String,
        recovery_seed_file: Option<PathBuf>,
    },
    PrepareRotation {
        file: PathBuf,
    },
    RotateKeys {
        id: String,
    },
    ReconcileRotation {
        id: String,
    },
    ExportKey {
        kind: String,
        destination: PathBuf,
    },
    ExportReplacementKey {
        id: String,
        destination: PathBuf,
    },
    ExportRecoveryKey {
        source: PathBuf,
        destination: PathBuf,
    },
    RevealMnemonic {
        passphrase: Option<String>,
    },
}
pub struct Controller {
    pub store: Store,
    runner: Runner,
    mutation: Mutex<()>,
}
#[derive(Serialize)]
struct Outcome {
    data: Option<Value>,
    error: Option<Failure>,
}
impl Outcome {
    fn from(result: Result<Value>) -> Self {
        match result {
            Ok(v) => Self {
                data: Some(v),
                error: None,
            },
            Err(e) => Self {
                data: None,
                error: Some(e),
            },
        }
    }
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
// Round bytes up to a MiB,
// then round the micro-USD charge up. Zero rates or absent sizes aren't quotes.
pub fn restore_charge(size: u64, rate: u64) -> Option<String> {
    if size == 0 || rate == 0 {
        return None;
    }
    let units = size.div_ceil(1 << 20);
    units
        .checked_mul(rate)
        .map(|v| v.div_ceil(1024).to_string())
}
fn field(v: &Value, name: &str) -> Result<String> {
    v[name].as_str().map(str::to_owned).ok_or_else(|| {
        Failure::new(
            "tool_incompatible",
            format!("The tool did not return {name}."),
        )
    })
}
/// The longest expiry `ghost account set-password --expires-in` takes, in
/// days.
const MAX_WEBSITE_PASSWORD_DAYS: u32 = 3650;
/// `ghost`'s arguments for a new website password, built here from the
/// expiry alone. The JSON answer, not `--print`'s bare line, so the
/// runner reads it, and its refusals, as every other answer.
pub fn set_password_args(expires_in_days: Option<u32>) -> Result<Vec<String>> {
    let mut args = vec!["account".to_owned(), "set-password".to_owned()];
    if let Some(days) = expires_in_days {
        if !(1..=MAX_WEBSITE_PASSWORD_DAYS).contains(&days) {
            return Err(Failure::new(
                "invalid_expiry",
                "Choose an expiry of 1 to 3650 days, or none.",
            ));
        }
        args.extend(["--expires-in".to_owned(), days.to_string()]);
    }
    Ok(args)
}
/// The arguments that ask for a GitHub sign-up claim and print it, without
/// opening its link or waiting for the sign-in.
pub fn github_signup_args() -> Vec<String> {
    vec![
        "account".to_owned(),
        "signup".to_owned(),
        "--github".to_owned(),
        "--no-wait".to_owned(),
    ]
}
/// The arguments that ask for a claim linking a GitHub account to the
/// account, printed without opening its link or waiting.
pub fn github_link_args() -> Vec<String> {
    vec![
        "account".to_owned(),
        "link-github".to_owned(),
        "--no-wait".to_owned(),
    ]
}
/// The arguments that unlink the account's GitHub account.
pub fn github_unlink_args() -> Vec<String> {
    vec![
        "account".to_owned(),
        "unlink-github".to_owned(),
        "--yes".to_owned(),
    ]
}
/// The arguments that read the GitHub claim `claim_id` once. A claim's name
/// is 128 random bits in base64url, which may begin with a hyphen, so the
/// name follows `--` and is checked to be nothing else.
pub fn github_status_args(claim_id: &str) -> Result<Vec<String>> {
    if claim_id.is_empty()
        || claim_id.len() > 64
        || !claim_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(Failure::new(
            "invalid_github_claim",
            "The GitHub claim is not valid. Start again.",
        ));
    }
    Ok(vec![
        "account".to_owned(),
        "github-status".to_owned(),
        "--".to_owned(),
        claim_id.to_owned(),
    ])
}
/// The longest account key line the app hands `ghost key import`; a key
/// line is about 70 characters, and `ghost` refuses more than 256 bytes.
const MAX_ACCOUNT_KEY_LINE: usize = 256;
/// `ghost`'s arguments and standard input for an import of the account key
/// in `file` or in `line`, exactly one of them. A file is an absolute path,
/// which never begins with a hyphen; a line goes on standard input only.
pub fn import_account_args(
    file: Option<PathBuf>,
    line: Option<Zeroizing<String>>,
    replace: bool,
) -> Result<(Vec<String>, Option<Secret>)> {
    let mut args = vec!["key".to_owned(), "import".to_owned()];
    let secret = match (file, line) {
        (Some(file), None) => {
            absolute(&file)?;
            args.extend(["--from".to_owned(), file.to_string_lossy().into_owned()]);
            None
        }
        (None, Some(line)) => {
            if line.trim().is_empty() || line.len() > MAX_ACCOUNT_KEY_LINE {
                return Err(Failure::new(
                    "invalid_input",
                    "Paste the account key line, which begins with gigahost-account-seed-v1:.",
                ));
            }
            Some(Secret::Line(line))
        }
        _ => {
            return Err(Failure::new(
                "invalid_input",
                "Choose an account key file or paste the account key line, one of the two.",
            ));
        }
    };
    if replace {
        args.push("--replace".to_owned());
    }
    Ok((args, secret))
}
/// A claim's link, which the app opens, only when it is on the configured
/// website, as a login link must be.
pub fn claim_link(link: &str, website: &str) -> Result<Url> {
    let claim = Url::parse(link)
        .map_err(|_| Failure::new("invalid_github_claim", "The GitHub link is invalid."))?;
    let trusted = validate_url(website)?;
    if claim.origin() != trusted.origin()
        || !claim.username().is_empty()
        || claim.password().is_some()
    {
        return Err(Failure::new(
            "invalid_github_claim",
            "The GitHub link points away from your configured website.",
        ));
    }
    Ok(claim)
}
/// What the app shows of a new website password, once: the password and
/// its dates. The rest of the tool's answer is left behind.
fn new_password(v: &Value) -> Result<Value> {
    let password = field(v, "password")?;
    Ok(json!({
        "password": password,
        "created_at": v["created_at"],
        "expires_at": v["expires_at"],
    }))
}
fn absolute(path: &std::path::Path) -> Result<PathBuf> {
    if !path.is_absolute() {
        return Err(Failure::new(
            "invalid_path",
            "Choose an absolute file location.",
        ));
    }
    Ok(path.to_owned())
}
pub fn ghost_default() -> Result<PathBuf> {
    if let Some(p) = std::env::var_os("GHOST_SEED_FILE").filter(|p| !p.is_empty()) {
        return absolute(&PathBuf::from(p));
    }
    let config = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute());
    let config = config.or_else(|| {
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .map(|p| p.join(".config"))
    });
    #[cfg(windows)]
    let config = config.or_else(|| {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .or_else(|| {
                std::env::var_os("USERPROFILE")
                    .map(PathBuf::from)
                    .filter(|p| p.is_absolute())
                    .map(|p| p.join(".config"))
            })
    });
    config.map(|p| p.join("ghost/account.seed")).ok_or_else(|| {
        Failure::new(
            "home_unavailable",
            "Your home directory is unavailable. Select a custom account key.",
        )
    })
}
pub fn state_default() -> Result<PathBuf> {
    if let Some(p) = std::env::var_os("XDG_STATE_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
    {
        return Ok(p.join("gigahost"));
    }
    let state = std::env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .map(|p| p.join(".local/state/gigahost"));
    #[cfg(windows)]
    let state = state.or_else(|| {
        std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .map(|p| p.join("gigahost"))
            .or_else(|| {
                std::env::var_os("USERPROFILE")
                    .map(PathBuf::from)
                    .filter(|p| p.is_absolute())
                    .map(|p| p.join(".local/state/gigahost"))
            })
    });
    state.ok_or_else(|| Failure::new("home_unavailable", "Your home directory is unavailable."))
}
pub fn validate_url(text: &str) -> Result<Url> {
    let url =
        Url::parse(text).map_err(|_| Failure::new("invalid_url", "Enter a full HTTPS URL."))?;
    let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if (url.scheme() != "https" && !(url.scheme() == "http" && local))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(Failure::new(
            "invalid_url",
            "Use HTTPS, or HTTP on localhost for development, without credentials, query, or fragment.",
        ));
    }
    Ok(url)
}
pub fn approval_id(reference: &str, website: &str) -> Result<String> {
    let reference = reference.trim();
    if let Ok(id) = Uuid::parse_str(reference) {
        return Ok(id.to_string());
    }
    let url = Url::parse(reference)
        .map_err(|_| Failure::new("invalid_approval", "Paste the approval link from Gigahost."))?;
    let id = if url.scheme() == "gigahost"
        && url.host_str() == Some("approve")
        && url.path().is_empty()
        && url.fragment().is_none()
        && url.username().is_empty()
        && url.password().is_none()
    {
        let pairs: Vec<_> = url.query_pairs().collect();
        if pairs.len() != 1 || pairs[0].0 != "intent" {
            return Err(Failure::new(
                "invalid_approval",
                "This approval link contains unsupported fields.",
            ));
        }
        pairs[0].1.to_string()
    } else {
        let trusted = validate_url(website)?;
        if url.origin() != trusted.origin()
            || url.query().is_some()
            || url.fragment().is_some()
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err(Failure::new(
                "invalid_approval",
                "This approval link is not from your configured Gigahost website.",
            ));
        }
        url.path()
            .strip_prefix("/approvals/")
            .unwrap_or("")
            .to_string()
    };
    Uuid::parse_str(&id).map(|id| id.to_string()).map_err(|_| {
        Failure::new(
            "invalid_approval",
            "The approval link has an invalid request ID.",
        )
    })
}
fn public_money(v: &mut Value) {
    // Keep integer money fields exact across the JavaScript IPC boundary.
    match v {
        Value::Object(object) => {
            for (k, value) in object {
                if (k.contains("microusd") || k.contains("mmx_atomic")) && value.is_number() {
                    *value = Value::String(value.to_string());
                } else {
                    public_money(value);
                }
            }
        }
        Value::Array(values) => {
            for value in values {
                public_money(value);
            }
        }
        _ => (),
    }
}
impl Controller {
    pub fn new(root: PathBuf, runner: Runner) -> Result<Self> {
        Ok(Self {
            store: Store::new(root)?,
            runner,
            mutation: Mutex::new(()),
        })
    }
    fn seed(&self, s: &Settings) -> Result<PathBuf> {
        s.ghost_seed_file.clone().map_or_else(ghost_default, Ok)
    }
    async fn ghost(
        &self,
        s: &Settings,
        args: Vec<String>,
        seed: Option<PathBuf>,
        recovery: Option<PathBuf>,
        long: bool,
    ) -> Result<Value> {
        self.ghost_with_input(s, args, seed, recovery, long, None)
            .await
    }
    /// [`Self::ghost`] with `secret` on `ghost`'s standard input.
    async fn ghost_with_input(
        &self,
        s: &Settings,
        args: Vec<String>,
        seed: Option<PathBuf>,
        recovery: Option<PathBuf>,
        long: bool,
        secret: Option<Secret>,
    ) -> Result<Value> {
        let mut a = vec![
            "--compact".into(),
            "--api-url".into(),
            s.api_url.clone(),
            "--seed-file".into(),
            seed.unwrap_or(self.seed(s)?).to_string_lossy().into_owned(),
        ];
        if let Some(p) = recovery {
            a.extend([
                "--recovery-seed-file".into(),
                p.to_string_lossy().into_owned(),
            ]);
        }
        a.extend(args);
        let mut v = self.runner.run(false, &a, secret, long).await?;
        public_money(&mut v);
        Ok(v)
    }
    async fn wallet(
        &self,
        s: &Settings,
        args: Vec<String>,
        path: Option<PathBuf>,
        pass: Option<String>,
        mnemonic: Option<String>,
    ) -> Result<Value> {
        let mut a = vec![
            "--json".into(),
            "--rpc".into(),
            s.rpc_url.clone(),
            "--account".into(),
            s.account_index.to_string(),
            "--num-addresses".into(),
            s.num_addresses.to_string(),
        ];
        if let Some(path) = path {
            a.extend(["--file".into(), path.to_string_lossy().into_owned()]);
        }
        let secret = if pass.is_some() || mnemonic.is_some() {
            a.push("--input-stdin".into());
            Some(Secret::Json(json!({"passphrase":pass,"mnemonic":mnemonic})))
        } else {
            None
        };
        a.extend(args);
        self.runner.run(true, &a, secret, false).await
    }
    async fn wallet_path(&self, s: &Settings) -> Result<PathBuf> {
        if let Some(p) = &s.wallet_file {
            return absolute(p);
        }
        let list = self
            .wallet(s, vec!["list".into()], None, None, None)
            .await?;
        let wallets = list["wallets"]
            .as_array()
            .ok_or_else(|| Failure::new("tool_incompatible", "Could not discover wallets."))?;
        let chosen = wallets.iter().find(|w| w["active"] == true).or_else(|| {
            if wallets.len() == 1 {
                wallets.first()
            } else {
                None
            }
        });
        chosen
            .map(|w| field(w, "wallet_file").map(PathBuf::from))
            .unwrap_or_else(|| {
                Err(Failure::new(
                    "wallet_missing",
                    "Create a wallet or select your existing wallet in Settings.",
                ))
            })
    }
    fn op(&self, s: &Settings, kind: &str) -> Result<Operation> {
        Ok(Operation {
            id: Uuid::new_v4().to_string(),
            kind: kind.into(),
            state: "prepared".into(),
            created_at: now(),
            wallet_file: s.wallet_file.clone(),
            wallet_account: s.account_index,
            wallet_digest: None,
            wallet_address: None,
            ghost_seed_file: Some(self.seed(s)?),
            rpc_url: s.rpc_url.clone(),
            api_url: s.api_url.clone(),
            transaction_id: None,
            confirmations: None,
            digest: None,
            review: json!({}),
            intent_id: None,
            replacement_seed_file: None,
            account_memo: None,
            account_epoch: None,
            job_id: None,
        })
    }
    pub async fn dispatch(&self, request: Request) -> Result<Value> {
        // Reads can continue during a restore. Every mutation, including settings
        // and journal transitions, is serialized in this single app instance.
        if let Request::Snapshot { passphrase } = request {
            return self.snapshot(passphrase).await;
        }
        let _guard = self.mutation.lock().await;
        let mut s = self.store.settings()?;
        match request {
            Request::Snapshot { .. } => unreachable!(),
            Request::PreparePayout { amount } => self.prepare_payout(&s, &amount, None).await,
            Request::PreparePayoutAddress { address } => self.prepare_payout(&s, "", Some(address)).await,
            Request::ConfirmPayout { id } => self.confirm_payout(&s, &id).await,
            Request::PayoutReview { id } => {
                let op = self.store.get(&id)?;
                if !["payout", "payout_address"].contains(&op.kind.as_str()) {
                    return Err(Failure::new("payout_state", "Select a saved payout review."));
                }
                Ok(json!(op))
            }
            Request::DiscardPayout { id } => {
                let mut op = self.store.get(&id)?;
                if !["payout", "payout_address"].contains(&op.kind.as_str()) || !["prepared", "failed"].contains(&op.state.as_str()) {
                    return Err(Failure::new("payout_state", "Only an unsent or refused payout review can be discarded."));
                }
                op.state = "discarded".into();
                Ok(json!(self.store.put(op)?))
            }
            Request::SaveSettings { settings } => {
                for p in [&settings.wallet_file, &settings.ghost_seed_file]
                    .into_iter()
                    .flatten()
                    .chain(settings.recovery_seed_files.iter())
                {
                    absolute(p)?;
                }
                for u in [&settings.rpc_url, &settings.api_url, &settings.website_url] {
                    validate_url(u)?;
                }
                if !(1..=10).contains(&settings.num_addresses)
                    || !["system", "light", "dark"].contains(&settings.theme.as_str())
                {
                    return Err(Failure::new(
                        "invalid_settings",
                        "Choose a supported theme and 1 to 10 wallet addresses.",
                    ));
                }
                self.store.save_settings(&settings)?;
                Ok(json!(settings))
            }
            Request::CreateWallet {
                file,
                mnemonic,
                passphrase,
            } => {
                let mut args = vec![
                    if mnemonic.is_some() {
                        "import"
                    } else {
                        "create"
                    }
                    .into(),
                ];
                if passphrase.is_some() {
                    args.push("--with-passphrase".into());
                }
                let path = file.or_else(|| s.wallet_file.clone());
                if let Some(p) = &path {
                    absolute(p)?;
                }
                let v = self.wallet(&s, args, path, passphrase, mnemonic).await?;
                s.wallet_file = Some(PathBuf::from(field(&v, "wallet_file")?));
                self.store.save_settings(&s)?;
                Ok(v)
            }
            Request::CreateAccount { file } => {
                let path = file.unwrap_or(self.seed(&s)?);
                absolute(&path)?;
                let v = self
                    .ghost(
                        &s,
                        vec![
                            "key".into(),
                            "generate".into(),
                            "--output".into(),
                            path.to_string_lossy().into_owned(),
                        ],
                        Some(path.clone()),
                        None,
                        false,
                    )
                    .await?;
                s.ghost_seed_file = Some(path);
                self.store.save_settings(&s)?;
                Ok(v)
            }
            Request::ImportAccount {
                file,
                line,
                replace,
            } => {
                // The line is the account key itself: it is moved into a
                // buffer zeroized on drop at once, and no failure here
                // repeats it.
                let line = line.map(Zeroizing::new);
                let (args, secret) = import_account_args(file, line, replace)?;
                let path = self.seed(&s)?;
                absolute(&path)?;
                let v = self
                    .ghost_with_input(&s, args, Some(path.clone()), None, false, secret)
                    .await?;
                s.ghost_seed_file = Some(path);
                self.store.save_settings(&s)?;
                Ok(v)
            }
            Request::ActivateAccount => {
                self.ghost(
                    &s,
                    vec!["account".into(), "activate".into()],
                    None,
                    None,
                    false,
                )
                .await
                .map_err(|e| {
                    if e.code == "invalid_request"
                        && e.message.contains("confirmed MMX deposits total ")
                    {
                        Failure::new(
                            "activation_pending",
                            "The required MMX deposit is not confirmed yet. If you have already sent it, wait for confirmations and choose Check activation again.",
                        )
                    } else {
                        e
                    }
                })
            }
            Request::GithubSignup | Request::GithubLink => {
                let args = if matches!(request, Request::GithubSignup) {
                    github_signup_args()
                } else {
                    github_link_args()
                };
                let v = self.ghost(&s, args, None, None, false).await?;
                claim_link(&field(&v, "claim_url")?, &s.website_url)?;
                Ok(v)
            }
            Request::GithubUnlink => {
                self.ghost(&s, github_unlink_args(), None, None, false)
                    .await
            }
            Request::GithubStatus { claim_id } => {
                self.ghost(&s, github_status_args(&claim_id)?, None, None, false)
                    .await
            }
            Request::PrepareSend {
                target,
                amount,
                memo,
                passphrase,
                purpose,
            } => {
                self.prepare_send(&s, target, amount, memo, passphrase, purpose)
                    .await
            }
            Request::Broadcast { id } => self.broadcast(&s, &id).await,
            Request::PaymentStatus { id } => {
                let mut op = self.store.get(&id)?;
                let txid = op.transaction_id.clone().ok_or_else(|| {
                    Failure::new("invalid_operation", "This operation is not a payment.")
                })?;
                let mut bound = s.clone();
                bound.rpc_url = op.rpc_url.clone();
                let status = self
                    .wallet(&bound, vec!["transaction".into(), txid], None, None, None)
                    .await?;
                if ["pending", "included", "failed", "expired"]
                    .contains(&status["status"].as_str().unwrap_or(""))
                {
                    op.state = field(&status, "status")?;
                }
                op.confirmations = status["confirmations"].as_u64();
                self.store.put(op)?;
                Ok(status)
            }
            Request::DiscardPayment { id } => {
                let mut op = self.store.get(&id)?;
                if op.kind != "send" && op.kind != "top_up" && op.kind != "activation" {
                    return Err(Failure::new("invalid_operation", "This is not a payment."));
                }
                if op.state != "prepared" {
                    return Err(Failure::new(
                        "payment_submitted",
                        "Check the submitted payment status before taking further action.",
                    ));
                }
                op.state = "discarded".into();
                self.store.put(op.clone())?;
                Ok(json!(op))
            }
            Request::Login => {
                let v = self
                    .ghost(
                        &s,
                        vec!["account".into(), "login".into()],
                        None,
                        None,
                        false,
                    )
                    .await?;
                let login = Url::parse(&field(&v, "login_url")?).map_err(|_| {
                    Failure::new("invalid_login", "The website login link is invalid.")
                })?;
                let trusted = validate_url(&s.website_url)?;
                if login.origin() != trusted.origin()
                    || !login.username().is_empty()
                    || login.password().is_some()
                {
                    return Err(Failure::new(
                        "invalid_login",
                        "The login destination differs from your configured website.",
                    ));
                }
                Ok(v)
            }
            Request::RevokeSessions => {
                self.ghost(
                    &s,
                    vec!["account".into(), "revoke-sessions".into()],
                    None,
                    None,
                    false,
                )
                .await
            }
            Request::SetWebsitePassword { expires_in_days } => {
                let v = self
                    .ghost(&s, set_password_args(expires_in_days)?, None, None, false)
                    .await?;
                new_password(&v)
            }
            Request::RemoveWebsitePassword => {
                self.ghost(
                    &s,
                    vec!["account".into(), "remove-password".into()],
                    None,
                    None,
                    false,
                )
                .await
            }
            Request::InspectRestore { reference } => self.inspect_restore(&s, &reference).await,
            Request::ApproveRestore {
                id,
                recovery_seed_file,
            } => self.approve_restore(&s, &id, recovery_seed_file).await,
            Request::PrepareRotation { file } => {
                absolute(&file)?;
                let old = self
                    .ghost(&s, vec!["account".into(), "show".into()], None, None, false)
                    .await?;
                let generated = self
                    .ghost(
                        &s,
                        vec![
                            "key".into(),
                            "generate".into(),
                            "--output".into(),
                            file.to_string_lossy().into_owned(),
                        ],
                        Some(file.clone()),
                        None,
                        false,
                    )
                    .await?;
                let mut op = self.op(&s, "rotation")?;
                op.replacement_seed_file = Some(file);
                op.review = json!({"account":old,"replacement":generated});
                self.store.put(op.clone())?;
                Ok(json!(op))
            }
            Request::RotateKeys { id } => {
                let mut op = self.store.get(&id)?;
                if op.kind != "rotation"
                    || !["prepared", "uncertain", "submitting"].contains(&op.state.as_str())
                {
                    return Err(Failure::new(
                        "rotation_state",
                        "Check this rotation's saved status before retrying.",
                    ));
                }
                self.check_account_binding(&s, &op).await?;
                if op.state != "prepared" {
                    // First check whether a lost response already activated the
                    // replacement. Only an unactivated replacement account permits
                    // another migration, with the same reviewed account key.
                    match self.finish_rotation(&mut s, &mut op).await {
                        Ok(account) => return Ok(account),
                        Err(e) if matches!(e.code.as_str(), "account_not_activated" | "unknown_account") => {}
                        Err(e) => return Err(e),
                    }
                }
                self.check_replacement(&s, &op).await?;
                let current = self
                    .ghost(&s, vec!["account".into(), "show".into()], None, None, false)
                    .await?;
                if current["account_alias"] != op.review["account"]["account_alias"]
                    || current["key_epoch"] != op.review["account"]["key_epoch"]
                {
                    return Err(Failure::new(
                        "account_changed",
                        "The account or its keys changed. Review a new rotation.",
                    ));
                }
                let path = op.replacement_seed_file.clone().ok_or_else(|| {
                    Failure::new("rotation_state", "The replacement key is missing.")
                })?;
                op.state = "submitting".into();
                self.store.put(op.clone())?;
                let result = self
                    .ghost(
                        &s,
                        vec![
                            "account".into(),
                            "migrate-seed".into(),
                            "--new-seed-file".into(),
                            path.to_string_lossy().into_owned(),
                            "--yes".into(),
                        ],
                        op.ghost_seed_file.clone(),
                        None,
                        false,
                    )
                    .await;
                match result {
                    Ok(_) => self.finish_rotation(&mut s, &mut op).await,
                    Err(e) => {
                        op.state = "uncertain".into();
                        self.store.put(op)?;
                        Err(e)
                    }
                }
            }
            Request::ReconcileRotation { id } => {
                let mut op = self.store.get(&id)?;
                if op.kind != "rotation" {
                    return Err(Failure::new(
                        "invalid_operation",
                        "This is not a key rotation.",
                    ));
                }
                if self.seed(&s)? != op.replacement_seed_file.clone().unwrap_or_default() {
                    self.check_account_binding(&s, &op).await?;
                }
                self.finish_rotation(&mut s, &mut op).await
            }
            Request::ExportKey { kind, destination } => {
                absolute(&destination)?;
                let source = match kind.as_str() {
                    "account" => self.seed(&s)?,
                    "wallet" => self.wallet_path(&s).await?,
                    _ => {
                        return Err(Failure::new(
                            "invalid_key",
                            "Select a wallet or account key.",
                        ));
                    }
                };
                self.export(&source, &destination)?;
                Ok(json!({"saved_to":destination}))
            }
            Request::ExportReplacementKey { id, destination } => {
                let op = self.store.get(&id)?;
                if op.kind != "rotation" {
                    return Err(Failure::new("invalid_operation", "Select a key rotation."));
                }
                let source = op.replacement_seed_file.ok_or_else(|| {
                    Failure::new("rotation_state", "The replacement key is missing.")
                })?;
                self.export(&source, &destination)?;
                Ok(json!({"saved_to":destination}))
            }
            Request::ExportRecoveryKey {
                source,
                destination,
            } => {
                if !s.recovery_seed_files.contains(&source) {
                    return Err(Failure::new(
                        "invalid_key",
                        "Select a registered older account key.",
                    ));
                }
                self.export(&source, &destination)?;
                Ok(json!({"saved_to":destination}))
            }
            Request::RevealMnemonic { passphrase } => {
                let path = self.wallet_path(&s).await?;
                self.wallet(
                    &s,
                    vec!["get".into(), "mnemonic".into()],
                    Some(path),
                    passphrase,
                    None,
                )
                .await
            }
        }
    }
    fn export(&self, source: &std::path::Path, destination: &std::path::Path) -> Result<()> {
        absolute(destination)?;
        if fs::metadata(source)?.len() > 65536 {
            return Err(Failure::new(
                "key_file_invalid",
                "The selected key file is too large.",
            ));
        }
        let bytes = Zeroizing::new(fs::read(source)?);
        save(destination, &bytes, true)
    }
    fn signed_sources(&self, op: &Operation) -> Option<Vec<String>> {
        let bytes = fs::read(self.store.transaction(&op.id).ok()?).ok()?;
        if Some(hex::encode(Sha256::digest(&bytes))) != op.digest {
            return None;
        }
        let tx: Value = serde_json::from_slice(&bytes).ok()?;
        let mut owners = vec![tx["sender"].as_str()?.to_owned()];
        for input in tx["inputs"].as_array()? {
            owners.push(input["address"].as_str()?.to_owned());
        }
        Some(owners)
    }
    async fn provider_balance(&self, s: &Settings) -> Result<Value> {
        let balance = self
            .ghost(
                s,
                vec!["provider".into(), "balance".into()],
                None,
                None,
                false,
            )
            .await?;
        if balance.is_null() {
            return Err(Failure::new(
                "provider_missing",
                "There are no provider earnings yet. Rent out a server on Gigahost to start earning.",
            ));
        }
        Ok(balance)
    }
    async fn prepare_payout(
        &self,
        s: &Settings,
        amount: &str,
        address: Option<String>,
    ) -> Result<Value> {
        let requested = crate::payouts::amount_microusd(amount)?;
        let address = address.map(|a| a.trim().to_owned());
        if address
            .as_ref()
            .is_some_and(|a| !crate::payouts::valid_address(a))
        {
            return Err(Failure::new(
                "invalid_payout_address",
                "Enter a valid MMX address. Check the entire address for typing errors.",
            ));
        }
        let (balance, account, keys) = tokio::try_join!(
            self.provider_balance(s),
            self.ghost(s, vec!["account".into(), "show".into()], None, None, false),
            self.ghost(s, vec!["key".into(), "inspect".into()], None, None, false)
        )?;
        let alias = field(&account, "account_alias")?;
        let kind = if address.is_some() {
            "payout_address"
        } else {
            "payout"
        };
        if self.store.operations()?.iter().any(|op| {
            op.kind == kind
                && op.api_url == s.api_url
                && op.review["account_alias"] == alias
                && ["prepared", "submitting", "uncertain"].contains(&op.state.as_str())
        }) {
            return Err(Failure::new(
                "payout_pending",
                "Review the saved request before preparing another. An uncertain request must be retried using the same saved review.",
            ));
        }
        let mut op = self.op(s, kind)?;
        op.account_memo = Some(field(&keys, "deposit_memo")?);
        op.review = json!({"account_alias":alias,"previous_address":balance["payout_address"]});
        if let Some(address) = address {
            op.review["address"] = json!(address);
        } else {
            let destination = balance["payout_address"]
                .as_str()
                .filter(|a| crate::payouts::valid_address(a))
                .ok_or_else(|| {
                    Failure::new(
                        "payout_address_required",
                        "Set your payout address before requesting a payout.",
                    )
                })?;
            if balance["sla_settlement_pending"] == true {
                return Err(Failure::new(
                    "payout_held",
                    "An outage on one of your hosts is not settled yet. A payout becomes available once it is.",
                ));
            }
            let available = field(&balance, "available_payout_microusd")?
                .parse::<i64>()
                .unwrap_or(0)
                .max(0) as u64;
            let amount = requested.unwrap_or(available);
            if amount == 0 || amount > available {
                return Err(Failure::new(
                    "invalid_payout_amount",
                    format!(
                        "Choose an amount above zero and no more than {} available now.",
                        crate::payouts::dollars(available)
                    ),
                ));
            }
            op.review["address"] = json!(destination);
            op.review["amount_microusd"] = json!(amount.to_string());
        }
        Ok(json!(self.store.put(op)?))
    }
    async fn confirm_payout(&self, s: &Settings, id: &str) -> Result<Value> {
        let mut op = self.store.get(id)?;
        if !["payout", "payout_address"].contains(&op.kind.as_str())
            || !["prepared", "submitting", "uncertain", "complete"].contains(&op.state.as_str())
        {
            return Err(Failure::new(
                "payout_state",
                "This saved payout request cannot be submitted.",
            ));
        }
        self.check_account_binding(s, &op).await?;
        let (account, keys) = tokio::try_join!(
            self.ghost(s, vec!["account".into(), "show".into()], None, None, false),
            self.ghost(s, vec!["key".into(), "inspect".into()], None, None, false)
        )?;
        if account["account_alias"] != op.review["account_alias"]
            || Some(field(&keys, "deposit_memo")?) != op.account_memo
        {
            return Err(Failure::new(
                "account_changed",
                "Select the account key used for this payout review before continuing.",
            ));
        }
        if op.state == "complete" {
            return Ok(json!(op));
        }
        let address = field(&op.review, "address")?;
        if op.kind == "payout_address" || op.state == "prepared" {
            let balance = self.provider_balance(s).await?;
            if op.kind == "payout_address" && balance["payout_address"] == address {
                op.state = "complete".into();
                return Ok(json!(self.store.put(op)?));
            }
            if balance["payout_address"] != op.review["previous_address"] {
                if op.kind == "payout_address" {
                    op.state = "failed".into();
                    self.store.put(op)?;
                }
                return Err(Failure::new(
                    "payout_address_changed",
                    "The payout address changed. Close this review, discard it, and review the current address again.",
                ));
            }
            if op.kind == "payout" {
                let amount = field(&op.review, "amount_microusd")?
                    .parse::<u64>()
                    .map_err(|_| {
                        Failure::new("payout_state", "The saved payout amount is invalid.")
                    })?;
                let available = field(&balance, "available_payout_microusd")?
                    .parse::<i64>()
                    .unwrap_or(0)
                    .max(0) as u64;
                if balance["sla_settlement_pending"] == true || amount > available {
                    return Err(Failure::new(
                        "payout_balance_changed",
                        "The reviewed amount is no longer available. Close and discard this review, then refresh your earnings.",
                    ));
                }
            }
        }
        if op.kind == "payout"
            && op.state != "prepared"
            && now().saturating_sub(
                op.review["first_requested_at"]
                    .as_u64()
                    .unwrap_or(op.created_at),
            ) >= 30 * 86400
        {
            return Err(Failure::new(
                "payout_retry_expired",
                "This saved request is too old to retry safely. Check payout history and contact Gigahost support before requesting the amount again.",
            ));
        }
        let args = if op.kind == "payout_address" {
            vec!["provider".into(), "set-payout-address".into(), address]
        } else {
            vec![
                "provider".into(),
                "payout".into(),
                "--amount-microusd".into(),
                field(&op.review, "amount_microusd")?,
                "--idempotency-key".into(),
                op.id.clone(),
            ]
        };
        if op.state == "prepared" {
            op.review["first_requested_at"] = json!(now());
        }
        let retry = op.state != "prepared";
        op.state = "submitting".into();
        self.store.put(op.clone())?;
        let result = self
            .ghost(s, args, None, None, false)
            .await
            .and_then(|value| {
                if op.kind == "payout"
                    && value["payout_id"]
                        .as_str()
                        .is_none_or(|id| Uuid::parse_str(id).is_err())
                {
                    Err(Failure::new(
                        "tool_incompatible",
                        "The payout response is incomplete.",
                    ))
                } else {
                    Ok(value)
                }
            });
        match result {
            Ok(value) => {
                op.review["result"] = value;
                op.state = "complete".into();
                Ok(json!(self.store.put(op)?))
            }
            Err(error) => {
                op.state = if !retry && error.rejected && error.code != "idempotency_key_reused" {
                    "failed"
                } else {
                    "uncertain"
                }
                .into();
                let uncertain = op.state == "uncertain";
                self.store.put(op)?;
                Err(crate::payouts::request_error(error, uncertain))
            }
        }
    }
    async fn snapshot(&self, passphrase: Option<String>) -> Result<Value> {
        let s = self.store.settings()?;
        let wallets = Outcome::from(
            self.wallet(&s, vec!["list".into()], None, passphrase.clone(), None)
                .await,
        );
        let path = self.wallet_path(&s).await.ok();
        let wallet = if let Some(p) = &path {
            let (addresses, balance, history) = tokio::join!(
                self.wallet(
                    &s,
                    vec!["addresses".into()],
                    Some(p.clone()),
                    passphrase.clone(),
                    None
                ),
                self.wallet(
                    &s,
                    vec!["balance".into()],
                    Some(p.clone()),
                    passphrase.clone(),
                    None
                ),
                self.wallet(
                    &s,
                    vec!["history".into()],
                    Some(p.clone()),
                    passphrase,
                    None
                )
            );
            json!({"file":p,"addresses":Outcome::from(addresses),"balance":Outcome::from(balance),"history":Outcome::from(history)})
        } else {
            Value::Null
        };
        let seed = self.seed(&s)?;
        let keys = if seed.exists() {
            Outcome::from(
                self.ghost(&s, vec!["key".into(), "inspect".into()], None, None, false)
                    .await,
            )
        } else {
            Outcome::from(Err(Failure::new(
                "account_key_missing",
                "Create an account key or select an existing one.",
            )))
        };
        let (account, balance, deposits, terms, provider, payouts) = if seed.exists() {
            let (a, b, d, t, p, h) = tokio::join!(
                self.ghost(&s, vec!["account".into(), "show".into()], None, None, false),
                self.ghost(
                    &s,
                    vec!["account".into(), "balance".into()],
                    None,
                    None,
                    false
                ),
                self.ghost(
                    &s,
                    vec!["account".into(), "deposits".into()],
                    None,
                    None,
                    false
                ),
                self.ghost(
                    &s,
                    vec!["account".into(), "activation-terms".into()],
                    None,
                    None,
                    false
                ),
                self.ghost(
                    &s,
                    vec!["provider".into(), "balance".into()],
                    None,
                    None,
                    false
                ),
                self.ghost(
                    &s,
                    vec!["provider".into(), "payouts".into()],
                    None,
                    None,
                    false
                )
            );
            (
                Outcome::from(a),
                Outcome::from(b),
                Outcome::from(d),
                Outcome::from(t),
                Outcome::from(p),
                Outcome::from(h),
            )
        } else {
            let missing = || {
                Outcome::from(Err(Failure::new(
                    "account_key_missing",
                    "Set up your account key to continue.",
                )))
            };
            (
                missing(),
                missing(),
                missing(),
                missing(),
                missing(),
                missing(),
            )
        };
        Ok(
            json!({"settings":s,"wallets":wallets,"wallet":wallet,"keys":keys,"ghost_seed_file":seed,"account":account,"account_balance":balance,"deposits":deposits,"activation_terms":terms,"provider_balance":provider,"payouts":payouts,"operations":self.store.operations()?,"refreshed_at":now()}),
        )
    }
    async fn prepare_send(
        &self,
        s: &Settings,
        mut target: String,
        amount: String,
        mut memo: Option<String>,
        passphrase: Option<String>,
        purpose: String,
    ) -> Result<Value> {
        if !["send", "top_up", "activation"].contains(&purpose.as_str()) {
            return Err(Failure::new(
                "invalid_payment",
                "Unsupported payment purpose.",
            ));
        }
        // Do not create another payment while an earlier submission is ambiguous.
        let path = self.wallet_path(s).await?;
        let digest = hex::encode(Sha256::digest(Zeroizing::new(fs::read(&path)?).as_slice()));
        // The derived address survives copies, symlinks, and key-file re-encoding.
        // It also distinguishes accounts and optional derivation passphrases.
        let address = field(
            &self
                .wallet(
                    s,
                    vec!["address".into()],
                    Some(path.clone()),
                    passphrase.clone(),
                    None,
                )
                .await?,
            "address",
        )?;
        let mut pending = Vec::new();
        for mut prior in self.store.operations()?.into_iter().filter(|op| {
            op.transaction_id.is_some()
                && [
                    "prepared",
                    "submitting",
                    "uncertain",
                    "broadcast",
                    "pending",
                ]
                .contains(&op.state.as_str())
        }) {
            // Upgrade journals written before public wallet identity was saved.
            if prior.wallet_address.is_none() {
                // A filename alone cannot identify an older payment: its file
                // may have been replaced. Only derive from verified original bytes.
                let verified = if prior.wallet_digest.as_ref() == Some(&digest) {
                    Some(path.clone())
                } else {
                    prior.wallet_file.clone().filter(|old_path| {
                        fs::read(old_path).ok().is_some_and(|bytes| {
                            Some(hex::encode(Sha256::digest(
                                Zeroizing::new(bytes).as_slice(),
                            ))) == prior.wallet_digest
                        })
                    })
                };
                let derived = if let Some(verified) = verified {
                    let mut original_settings = s.clone();
                    original_settings.account_index = prior.wallet_account;
                    original_settings.num_addresses = 10;
                    self.wallet(
                        &original_settings,
                        vec!["addresses".into()],
                        Some(verified),
                        passphrase.clone(),
                        None,
                    )
                    .await
                    .ok()
                    .and_then(|v| {
                        let addresses = v["addresses"].as_array()?;
                        let owners = self.signed_sources(&prior)?;
                        if !owners.iter().all(|owner| {
                            addresses
                                .iter()
                                .any(|address| address.as_str() == Some(owner))
                        }) {
                            return None;
                        }
                        addresses.first()?.as_str().map(str::to_owned)
                    })
                } else {
                    None
                };
                if let Some(derived) = derived {
                    prior.wallet_address = Some(derived);
                    self.store.put(prior.clone())?;
                }
                if prior.wallet_address.is_none() {
                    return Err(Failure::new(
                        "payment_identity_unknown",
                        "An older saved payment's wallet cannot be identified. Restore its original wallet and resolve the payment, or discard its draft, before preparing another.",
                    ));
                }
            }
            if prior.wallet_address.as_deref() == Some(&address) {
                pending.push(prior);
            }
        }
        if pending.iter().any(|op| op.state == "prepared") {
            return Err(Failure::new(
                "payment_draft_exists",
                "Review or discard your prepared payment before making another.",
            ));
        }
        if !pending.is_empty() {
            return Err(Failure::new(
                "payment_pending",
                "Check your pending payment before preparing another. This prevents accidental duplicate payments.",
            ));
        }
        let mut op = self.op(s, &purpose)?;
        op.wallet_file = Some(path.clone());
        op.wallet_digest = Some(digest);
        op.wallet_address = Some(address);
        if purpose != "send" {
            let terms = self
                .ghost(
                    s,
                    vec!["account".into(), "activation-terms".into()],
                    None,
                    None,
                    false,
                )
                .await?;
            target = field(&terms, "deposit_address")?;
            let keys = self
                .ghost(s, vec!["key".into(), "inspect".into()], None, None, false)
                .await?;
            memo = Some(field(&keys, "deposit_memo")?);
            op.account_memo = memo.clone();
            if purpose == "top_up" {
                let a = self
                    .ghost(s, vec!["account".into(), "show".into()], None, None, false)
                    .await?;
                if a["deposit_memo"] != keys["deposit_memo"] {
                    return Err(Failure::new(
                        "account_changed",
                        "Refresh account funding details before paying.",
                    ));
                }
                op.account_epoch = Some(a["key_epoch"].to_string());
            }
        }
        if memo.as_ref().is_some_and(|m| m.len() > 64) {
            return Err(Failure::new(
                "memo_too_long",
                "A memo can contain at most 64 UTF-8 bytes.",
            ));
        }
        let tx = self.store.transaction(&op.id)?;
        let mut args = vec![
            "send".into(),
            "--target".into(),
            target,
            "--amount".into(),
            amount,
            "--transaction".into(),
            tx.to_string_lossy().into_owned(),
        ];
        if let Some(m) = memo {
            args.extend(["--memo".into(), m]);
        }
        let review = self.wallet(s, args, Some(path), passphrase, None).await?;
        op.transaction_id = Some(field(&review, "transaction_id")?);
        op.digest = Some(hex::encode(Sha256::digest(fs::read(tx)?)));
        op.review = review;
        self.store.put(op.clone())?;
        Ok(json!(op))
    }
    async fn check_account_binding(&self, s: &Settings, op: &Operation) -> Result<()> {
        if self.seed(s)? != op.ghost_seed_file.clone().unwrap_or_default()
            || s.api_url != op.api_url
        {
            return Err(Failure::new(
                "account_changed",
                "This operation belongs to different account settings. Restore its original settings before continuing.",
            ));
        }
        Ok(())
    }
    async fn broadcast(&self, s: &Settings, id: &str) -> Result<Value> {
        let mut op = self.store.get(id)?;
        if ![
            "prepared",
            "uncertain",
            "submitting",
            "broadcast",
            "pending",
        ]
        .contains(&op.state.as_str())
            || op.transaction_id.is_none()
        {
            return Err(Failure::new(
                "payment_state",
                "This payment cannot be broadcast in its current state.",
            ));
        }
        if s.rpc_url != op.rpc_url
            || s.account_index != op.wallet_account
            || self.wallet_path(s).await? != op.wallet_file.clone().unwrap_or_default()
            || Some(hex::encode(Sha256::digest(fs::read(
                op.wallet_file.as_ref().unwrap(),
            )?)))
                != op.wallet_digest
        {
            return Err(Failure::new(
                "wallet_changed",
                "Select the original wallet and RPC before continuing this payment.",
            ));
        }
        if op.kind != "send" {
            self.check_account_binding(s, &op).await?;
            let keys = self
                .ghost(s, vec!["key".into(), "inspect".into()], None, None, false)
                .await?;
            if Some(field(&keys, "deposit_memo")?) != op.account_memo {
                return Err(Failure::new(
                    "account_changed",
                    "Account keys changed. Prepare and review a new top-up.",
                ));
            }
            if let Some(epoch) = &op.account_epoch {
                let a = self
                    .ghost(s, vec!["account".into(), "show".into()], None, None, false)
                    .await?;
                if a["key_epoch"].as_u64() != epoch.parse::<u64>().ok() {
                    return Err(Failure::new(
                        "account_changed",
                        "Account keys changed. Prepare and review a new top-up.",
                    ));
                }
            }
        }
        let tx = self.store.transaction(id)?;
        if Some(hex::encode(Sha256::digest(fs::read(&tx)?))) != op.digest {
            return Err(Failure::new(
                "payment_changed",
                "The signed payment changed. Prepare and review a new payment.",
            ));
        }
        // Repeated confirmation always submits the same saved bytes, never a
        // newly constructed transfer. Reconcile first after an ambiguous outcome.
        if op.state != "prepared" {
            let status = self
                .wallet(
                    s,
                    vec!["transaction".into(), op.transaction_id.clone().unwrap()],
                    None,
                    None,
                    None,
                )
                .await?;
            if status["status"] != "unknown" {
                op.state = field(&status, "status")?;
                op.confirmations = status["confirmations"].as_u64();
                self.store.put(op)?;
                return Ok(status);
            }
        }
        op.state = "submitting".into();
        self.store.put(op.clone())?;
        let result = self
            .wallet(
                s,
                vec![
                    "broadcast".into(),
                    "--transaction".into(),
                    tx.to_string_lossy().into_owned(),
                ],
                None,
                None,
                None,
            )
            .await;
        match result {
            Ok(v) => {
                op.state = "broadcast".into();
                self.store.put(op)?;
                Ok(v)
            }
            Err(e) => {
                op.state = if e.code == "transaction_expired" {
                    "expired"
                } else {
                    "uncertain"
                }
                .into();
                self.store.put(op)?;
                Err(e)
            }
        }
    }
    async fn inspect_restore(&self, s: &Settings, reference: &str) -> Result<Value> {
        let intent = approval_id(reference, &s.website_url)?;
        let mut request = self
            .ghost(
                s,
                vec!["account".into(), "approve".into(), intent.clone()],
                None,
                None,
                false,
            )
            .await?;
        let authoritative = request.get("request").unwrap_or(&request).clone();
        let kind = authoritative["operation"]["kind"].as_str().unwrap_or("");
        if !["restore_backup", "create_from_backup"].contains(&kind) {
            return Err(Failure::new(
                "unsupported_approval",
                "This request is not a hosted backup restore.",
            ));
        }
        let backup_id = field(&authoritative["operation"], "backup_id")?;
        Uuid::parse_str(&backup_id)
            .map_err(|_| Failure::new("invalid_approval", "The backup ID is invalid."))?;
        let mut backup = self
            .ghost(
                s,
                vec!["backup".into(), "get".into(), backup_id],
                None,
                None,
                false,
            )
            .await?;
        if backup["destination"] != "gigahost_s3"
            || !backup["recipient_key_fingerprint"].is_string()
        {
            return Err(Failure::new(
                "unsupported_approval",
                "Select an encrypted hosted backup restore.",
            ));
        }
        // Wrapped backup keys belong only in Ghost, never in the journal/UI.
        if let Some(o) = backup.as_object_mut() {
            o.remove("wrapped_data_key");
        }
        let destination = if kind == "restore_backup" {
            self.ghost(
                s,
                vec![
                    "instance".into(),
                    "get".into(),
                    field(&authoritative["operation"], "instance_id")?,
                ],
                None,
                None,
                false,
            )
            .await?
        } else {
            self.ghost(
                s,
                vec![
                    "catalog".into(),
                    "offering".into(),
                    field(&authoritative["operation"], "offering_id")?,
                ],
                None,
                None,
                false,
            )
            .await?
        };
        let account = self
            .ghost(s, vec!["account".into(), "show".into()], None, None, false)
            .await?;
        let mut recovery = Vec::new();
        for path in std::iter::once(self.seed(s)?).chain(s.recovery_seed_files.iter().cloned()) {
            if let Ok(keys) = self
                .ghost(
                    s,
                    vec!["key".into(), "inspect".into()],
                    Some(path.clone()),
                    None,
                    false,
                )
                .await
                && keys["recovery_key_fingerprint"] == backup["recipient_key_fingerprint"]
            {
                recovery.push(path);
            }
        }
        let charge = backup["size_bytes"]
            .as_u64()
            .zip(
                backup["restore_charge_microusd_per_gib"]
                    .as_str()
                    .and_then(|s| s.parse().ok()),
            )
            .and_then(|(size, rate)| restore_charge(size, rate));
        if let Some(object) = request.as_object_mut() {
            object.remove("approve_command");
        }
        let mut op = self.op(s, "restore")?;
        op.intent_id = Some(intent);
        op.review = json!({"request":authoritative,"backup":backup,"destination":destination,"account":account,"matching_recovery_files":recovery,"restore_charge_microusd":charge,"charge_already_committed":authoritative["started_job_id"].is_string()});
        if authoritative["completed_job_id"].is_string() {
            op.state = "authorized".into();
            op.job_id = authoritative["completed_job_id"]
                .as_str()
                .map(str::to_owned);
        }
        self.store.put(op.clone())?;
        Ok(json!(op))
    }
    async fn approve_restore(
        &self,
        s: &Settings,
        id: &str,
        recovery_seed_file: Option<PathBuf>,
    ) -> Result<Value> {
        let mut op = self.store.get(id)?;
        if op.kind != "restore" || op.state == "authorized" {
            return Err(Failure::new(
                "approval_state",
                "This restore has already been authorized or is unavailable.",
            ));
        }
        self.check_account_binding(s, &op).await?;
        let account = self
            .ghost(s, vec!["account".into(), "show".into()], None, None, false)
            .await?;
        if account["account_alias"] != op.review["account"]["account_alias"]
            || account["key_epoch"] != op.review["account"]["key_epoch"]
        {
            return Err(Failure::new(
                "account_changed",
                "The account or its keys changed. Review the restore again.",
            ));
        }
        if op.review["restore_charge_microusd"].is_null() {
            return Err(Failure::new(
                "price_unavailable",
                "The restore charge is unavailable. Review the restore again.",
            ));
        }
        let intent = op.intent_id.clone().unwrap();
        let fresh = self
            .ghost(
                s,
                vec!["account".into(), "approve".into(), intent.clone()],
                None,
                None,
                false,
            )
            .await?;
        let view = fresh.get("request").unwrap_or(&fresh);
        if view["operation"] != op.review["request"]["operation"] {
            return Err(Failure::new(
                "approval_changed",
                "The restore changed. Inspect and review it again.",
            ));
        }
        // A resumed job keeps its accepted quote. Before first admission, check
        // the mutable creation/reservation and gateway prices shown in review.
        if view["operation"]["kind"] == "create_from_backup" && !view["started_job_id"].is_string()
        {
            let offering = self
                .ghost(
                    s,
                    vec![
                        "catalog".into(),
                        "offering".into(),
                        field(&view["operation"], "offering_id")?,
                    ],
                    None,
                    None,
                    false,
                )
                .await?;
            let quote = |v: &Value| -> Option<Value> {
                let network = v["network_prices"].as_array().and_then(|rows| {
                    rows.iter()
                        .find(|row| row["gateway_tier"] == view["operation"]["gateway_tier"])
                })?;
                let fields = [
                    "instance_creation_charge_microusd",
                    "balance_reservation_microusd",
                    "base_price_microusd_per_month",
                    "full_utilization_price_microusd_per_month",
                ];
                for value in fields.iter().map(|key| &v[*key]).chain([
                    &network["gateway_base_charge_microusd_per_month"],
                    &network["combined_microusd_per_tib"],
                ]) {
                    value.as_str()?.parse::<u64>().ok()?;
                }
                Some(
                    json!({"creation":v["instance_creation_charge_microusd"],"reservation":v["balance_reservation_microusd"],"base":v["base_price_microusd_per_month"],"cpu":v["full_utilization_price_microusd_per_month"],"network":network}),
                )
            };
            let reviewed = quote(&op.review["destination"]);
            let current = quote(&offering);
            if reviewed.is_none() || current.is_none() {
                return Err(Failure::new(
                    "price_unavailable",
                    "The new instance charges are unavailable. Inspect and review the restore again.",
                ));
            }
            if current != reviewed {
                return Err(Failure::new(
                    "price_changed",
                    "The new instance charges changed. Inspect and review the restore again.",
                ));
            }
        }
        let recovery = recovery_seed_file.or_else(|| {
            op.review["matching_recovery_files"][0]
                .as_str()
                .map(PathBuf::from)
        });
        if recovery.is_none() {
            return Err(Failure::new(
                "recovery_key_missing",
                "Select the account key that protects this hosted backup.",
            ));
        }
        if let Some(path) = &recovery {
            absolute(path)?;
            let keys = self
                .ghost(
                    s,
                    vec!["key".into(), "inspect".into()],
                    Some(path.clone()),
                    None,
                    false,
                )
                .await?;
            if keys["recovery_key_fingerprint"] != op.review["backup"]["recipient_key_fingerprint"]
            {
                return Err(Failure::new(
                    "recovery_key_mismatch",
                    "This account key does not protect the selected backup.",
                ));
            }
            // Persist the validated choice before the long authorization call,
            // so an interrupted restore can resume after restarting the app.
            let mut paths: Vec<PathBuf> =
                serde_json::from_value(op.review["matching_recovery_files"].clone())
                    .unwrap_or_default();
            paths.retain(|p| p != path);
            paths.insert(0, path.clone());
            op.review["matching_recovery_files"] = json!(paths);
            if !s.recovery_seed_files.contains(path) && self.seed(s)? != *path {
                let mut settings = s.clone();
                settings.recovery_seed_files.push(path.clone());
                self.store.save_settings(&settings)?;
            }
        }
        op.state = "authorizing".into();
        self.store.put(op.clone())?;
        let result = self
            .ghost(
                s,
                vec!["account".into(), "approve".into(), intent, "--yes".into()],
                None,
                recovery,
                true,
            )
            .await;
        match result {
            Ok(v) => {
                op.state = "authorized".into();
                op.job_id = v["job_id"]
                    .as_str()
                    .or_else(|| v["completed_job_id"].as_str())
                    .map(str::to_owned);
                self.store.put(op)?;
                Ok(v)
            }
            Err(e) => {
                op.state = "needs_resume".into();
                self.store.put(op)?;
                Err(e)
            }
        }
    }
    async fn finish_rotation(&self, s: &mut Settings, op: &mut Operation) -> Result<Value> {
        self.check_replacement(s, op).await?;
        let path = op
            .replacement_seed_file
            .clone()
            .ok_or_else(|| Failure::new("rotation_state", "The replacement key is missing."))?;
        let mut bound = s.clone();
        bound.api_url = op.api_url.clone();
        let account = self
            .ghost(
                &bound,
                vec!["account".into(), "show".into()],
                Some(path.clone()),
                None,
                false,
            )
            .await?;
        if account["account_alias"] != op.review["account"]["account_alias"]
            || account["deposit_memo"] != op.review["replacement"]["keys"]["deposit_memo"]
        {
            return Err(Failure::new(
                "rotation_unconfirmed",
                "The replacement account key does not yet access the original account. Keep both account keys and check again.",
            ));
        }
        if let Some(old) = &op.ghost_seed_file
            && !s.recovery_seed_files.contains(old)
        {
            s.recovery_seed_files.push(old.clone());
        }
        s.ghost_seed_file = Some(path.clone());
        // A verified rotation keeps the account and payout retry scope. Move
        // saved reviews to its replacement key without changing their request.
        for mut payout in self.store.operations()?.into_iter().filter(|p| {
            ["payout", "payout_address"].contains(&p.kind.as_str())
                && ["prepared", "submitting", "uncertain"].contains(&p.state.as_str())
                && p.api_url == op.api_url
                && p.review["account_alias"] == account["account_alias"]
        }) {
            payout.ghost_seed_file = Some(path.clone());
            payout.account_memo = Some(field(&account, "deposit_memo")?);
            self.store.put(payout)?;
        }
        self.store.save_settings(s)?;
        op.state = "complete".into();
        self.store.put(op.clone())?;
        // Draft top-ups bound to the old memo cannot be submitted after rotation.
        for mut draft in self.store.operations()?.into_iter().filter(|d| {
            d.state == "prepared"
                && ["activation", "top_up"].contains(&d.kind.as_str())
                && d.ghost_seed_file == op.ghost_seed_file
                && d.api_url == op.api_url
                && d.account_memo.as_deref() == op.review["account"]["deposit_memo"].as_str()
        }) {
            draft.state = "discarded".into();
            self.store.put(draft)?;
        }
        Ok(account)
    }
    async fn check_replacement(&self, s: &Settings, op: &Operation) -> Result<()> {
        let keys = self
            .ghost(
                s,
                vec!["key".into(), "inspect".into()],
                op.replacement_seed_file.clone(),
                None,
                false,
            )
            .await?;
        if keys != op.review["replacement"]["keys"] {
            return Err(Failure::new(
                "replacement_changed",
                "The replacement account key changed. Preserve both account keys and review a new rotation.",
            ));
        }
        Ok(())
    }
}
