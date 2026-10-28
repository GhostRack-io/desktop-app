use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::Command,
};
use zeroize::Zeroizing;

pub type Result<T> = std::result::Result<T, Failure>;
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Failure {
    pub code: String,
    pub message: String,
    #[serde(skip)]
    pub rejected: bool,
}
impl Failure {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            rejected: false,
        }
    }
}
impl From<std::io::Error> for Failure {
    fn from(_: std::io::Error) -> Self {
        Self::new(
            "io_error",
            "Could not read or save a private app file. Check the location and permissions.",
        )
    }
}

/// What a tool reads on its standard input: a JSON value (the wallet's
/// `--input-stdin`), or one line of text as it is (an account key line for
/// `ghost key import`). Either is written with a line feed and zeroized.
pub enum Secret {
    Json(Value),
    Line(Zeroizing<String>),
}

#[derive(Clone)]
pub struct Runner {
    pub ghost: PathBuf,
    pub wallet: PathBuf,
}
impl Runner {
    pub fn bundled() -> Result<Self> {
        let executable = std::env::current_exe()?;
        Self::beside(&executable)
    }
    fn beside(executable: &Path) -> Result<Self> {
        let directory = executable
            .parent()
            .ok_or_else(|| Failure::new("bundle_missing", "Could not locate bundled tools."))?;
        let resolve = |name: &str| {
            let installed = directory.join(format!("{name}{}", std::env::consts::EXE_SUFFIX));
            if installed.is_file() {
                return installed;
            }
            #[cfg(debug_assertions)]
            {
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("binaries")
                    .join(format!(
                        "{name}-{}{}",
                        env!("DESKTOP_TARGET"),
                        std::env::consts::EXE_SUFFIX
                    ))
            }
            #[cfg(not(debug_assertions))]
            installed
        };
        let runner = Self {
            ghost: resolve("gigahost-ghost"),
            wallet: resolve("gigahost-mmxwallet"),
        };
        if !runner.ghost.is_file() || !runner.wallet.is_file() {
            return Err(Failure::new(
                "bundle_missing",
                "The bundled wallet or account tool is missing. Reinstall Gigahost.",
            ));
        }
        Ok(runner)
    }
    pub async fn run(
        &self,
        wallet: bool,
        args: &[String],
        secret: Option<Secret>,
        long: bool,
    ) -> Result<Value> {
        let mut command = Command::new(if wallet { &self.wallet } else { &self.ghost });
        // The sidecars are console programs; keep their piped JSON interface
        // without opening a console window each time the GUI refreshes.
        #[cfg(windows)]
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        command.env_remove("GHOST_RECOVERY_SEED_FILE");
        command
            .args(args)
            .stdin(if secret.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = command.spawn().map_err(|_| {
            Failure::new(
                "bundle_unavailable",
                "Could not start the bundled tool. Reinstall Gigahost.",
            )
        })?;
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        let task = async {
            if let Some(secret) = secret {
                let mut bytes = Zeroizing::new(match &secret {
                    Secret::Json(value) => serde_json::to_vec(value)
                        .map_err(|_| Failure::new("invalid_input", "Invalid private input."))?,
                    Secret::Line(line) => {
                        let mut bytes = Vec::with_capacity(line.len() + 1);
                        bytes.extend_from_slice(line.as_bytes());
                        bytes
                    }
                });
                drop(secret);
                bytes.push(b'\n');
                let mut input = child.stdin.take().unwrap();
                input.write_all(&bytes).await?;
                input.shutdown().await?;
            }
            let (out, err, status) = tokio::try_join!(bounded(stdout), bounded(stderr), async {
                child.wait().await.map_err(Failure::from)
            })?;
            // Ghost prints structured errors on stdout; mmxwallet uses stderr.
            let value = serde_json::from_slice::<Value>(if !status.success() && wallet {
                &err
            } else {
                &out
            })
            .ok();
            if !status.success() {
                if let Some(v) = value {
                    let v = if !wallet && v["error"].is_object() {
                        &v["error"]
                    } else {
                        &v
                    };
                    let code = v["code"].as_str().unwrap_or("operation_failed");
                    let message = v["message"]
                        .as_str()
                        .or_else(|| v["error"].as_str())
                        .unwrap_or(
                            "The operation failed. Check account access and try refreshing.",
                        );
                    let mut failure =
                        Failure::new(code, message.chars().take(800).collect::<String>());
                    failure.rejected = v["status"]
                        .as_u64()
                        .is_some_and(|status| (400..500).contains(&status) && status != 408);
                    return Err(failure);
                }
                return Err(Failure::new(
                    "operation_failed",
                    "The bundled tool could not complete the operation. Check your keys and network connection.",
                ));
            }
            let v = value.ok_or_else(|| {
                Failure::new(
                    "tool_incompatible",
                    "The bundled tool returned an unsupported response.",
                )
            })?;
            if wallet && v["schema_version"] != 1 {
                return Err(Failure::new(
                    "tool_incompatible",
                    "The wallet interface is incompatible. Reinstall Gigahost.",
                ));
            }
            Ok(v)
        };
        match tokio::time::timeout(Duration::from_secs(if long { 360 } else { 90 }), task).await {
            Ok(result) => {
                if result.is_err() {
                    let _ = child.kill().await;
                }
                result
            }
            Err(_) => {
                let _ = child.kill().await;
                Err(Failure::new(
                    "operation_timeout",
                    "The response did not arrive. A submitted operation may have succeeded; check its saved status before retrying.",
                ))
            }
        }
    }
}

async fn bounded(stream: impl AsyncRead + Unpin) -> Result<Zeroizing<Vec<u8>>> {
    let mut bytes = Zeroizing::new(Vec::new());
    stream
        .take(16 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .await?;
    if bytes.len() > 16 * 1024 * 1024 {
        return Err(Failure::new(
            "tool_output_limit",
            "The bundled tool response exceeded its size limit.",
        ));
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_tools_resolve_next_to_the_application() {
        let root = tempfile::tempdir().unwrap();
        let ghost = root
            .path()
            .join(format!("gigahost-ghost{}", std::env::consts::EXE_SUFFIX));
        let wallet = root.path().join(format!(
            "gigahost-mmxwallet{}",
            std::env::consts::EXE_SUFFIX
        ));
        std::fs::write(&ghost, []).unwrap();
        std::fs::write(&wallet, []).unwrap();
        let runner = Runner::beside(&root.path().join("gigahost-desktop.exe")).unwrap();
        assert_eq!(runner.ghost, ghost);
        assert_eq!(runner.wallet, wallet);
    }
}
