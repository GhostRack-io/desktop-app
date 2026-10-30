use crate::process::{Failure, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Settings {
    pub wallet_file: Option<PathBuf>,
    pub ghost_seed_file: Option<PathBuf>,
    pub recovery_seed_files: Vec<PathBuf>,
    pub rpc_url: String,
    pub api_url: String,
    pub website_url: String,
    pub theme: String,
    pub account_index: u32,
    pub num_addresses: u32,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            wallet_file: None,
            ghost_seed_file: None,
            recovery_seed_files: vec![],
            rpc_url: "https://rpc.mmx.network".into(),
            api_url: "https://api.ghostrack.io".into(),
            website_url: "https://ghostrack.io".into(),
            theme: "dark".into(),
            account_index: 0,
            num_addresses: 1,
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Operation {
    pub id: String,
    pub kind: String,
    pub state: String,
    pub created_at: u64,
    pub wallet_file: Option<PathBuf>,
    #[serde(default)]
    pub wallet_account: u32,
    #[serde(default)]
    pub wallet_digest: Option<String>,
    #[serde(default)]
    pub wallet_address: Option<String>,
    pub ghost_seed_file: Option<PathBuf>,
    pub rpc_url: String,
    pub api_url: String,
    pub transaction_id: Option<String>,
    #[serde(default)]
    pub confirmations: Option<u64>,
    pub digest: Option<String>,
    pub review: Value,
    pub intent_id: Option<String>,
    pub replacement_seed_file: Option<PathBuf>,
    pub account_memo: Option<String>,
    pub account_epoch: Option<String>,
    pub job_id: Option<String>,
}
pub struct Store {
    pub root: PathBuf,
}
impl Store {
    pub fn new(root: PathBuf) -> Result<Self> {
        private_directory(&root)?;
        private_directory(&root.join("transactions"))?;
        Ok(Self { root })
    }
    pub fn settings(&self) -> Result<Settings> {
        let path = self.root.join("settings.json");
        if !path.exists() {
            return Ok(Settings::default());
        }
        serde_json::from_slice(&fs::read(path)?)
            .map_err(|_| Failure::new("settings_invalid", "The app settings could not be read."))
    }
    pub fn save_settings(&self, s: &Settings) -> Result<()> {
        save(
            &self.root.join("settings.json"),
            &serde_json::to_vec(s).unwrap(),
            false,
        )
    }
    pub fn operations(&self) -> Result<Vec<Operation>> {
        let path = self.root.join("operations.json");
        if !path.exists() {
            return Ok(vec![]);
        }
        serde_json::from_slice(&fs::read(path)?).map_err(|_| {
            Failure::new(
                "journal_invalid",
                "The saved operations could not be read. Preserve the app data before repair.",
            )
        })
    }
    pub fn put(&self, op: Operation) -> Result<Operation> {
        let mut ops = self.operations()?;
        if let Some(old) = ops.iter_mut().find(|old| old.id == op.id) {
            *old = op.clone();
        } else {
            ops.push(op.clone());
        }
        save(
            &self.root.join("operations.json"),
            &serde_json::to_vec(&ops).unwrap(),
            false,
        )?;
        Ok(op)
    }
    pub fn get(&self, id: &str) -> Result<Operation> {
        self.operations()?
            .into_iter()
            .find(|op| op.id == id)
            .ok_or_else(|| {
                Failure::new("operation_missing", "This saved operation is unavailable.")
            })
    }
    pub fn transaction(&self, id: &str) -> Result<PathBuf> {
        uuid::Uuid::parse_str(id)
            .map_err(|_| Failure::new("invalid_operation", "Invalid operation ID."))?;
        Ok(self.root.join("transactions").join(format!("{id}.json")))
    }
}
pub fn private_directory(path: &Path) -> Result<()> {
    let mut b = fs::DirBuilder::new();
    b.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        b.mode(0o700);
    }
    b.create(path)?;
    Ok(())
}
pub fn save(path: &Path, bytes: &[u8], no_clobber: bool) -> Result<()> {
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let mut file = tempfile::NamedTempFile::new_in(parent)?;
    file.write_all(bytes)?;
    file.as_file().sync_all()?;
    if no_clobber {
        file.persist_noclobber(path).map_err(|_| {
            Failure::new(
                "file_exists",
                "Choose a new backup file; existing files are never replaced.",
            )
        })?;
    } else {
        file.persist(path).map_err(|e| Failure::from(e.error))?;
    }
    #[cfg(unix)]
    fs::File::open(parent)?.sync_all()?;
    Ok(())
}
