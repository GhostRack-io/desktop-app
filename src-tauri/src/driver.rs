//! Headless integration-test harness for the exact native controller. Never bundled.
use gigahost_desktop::{Controller, Request, process::Runner};
use std::path::PathBuf;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
#[tokio::main]
async fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
    assert_eq!(args.len(), 3, "desktop-driver STATE_DIR GHOST MMXWALLET");
    let controller = Controller::new(
        PathBuf::from(&args[0]),
        Runner {
            ghost: PathBuf::from(&args[1]),
            wallet: PathBuf::from(&args[2]),
        },
    )
    .unwrap();
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Some(line) = lines.next_line().await.unwrap() {
        let result = match serde_json::from_str::<Request>(&line) {
            Ok(request) => controller.dispatch(request).await,
            Err(_) => Err(gigahost_desktop::Failure::new(
                "invalid_request",
                "Invalid test request.",
            )),
        };
        let output = match result {
            Ok(v) => serde_json::json!({"data":v}),
            Err(e) => serde_json::json!({"error":e}),
        };
        let mut stdout = tokio::io::stdout();
        stdout
            .write_all(format!("{output}\n").as_bytes())
            .await
            .unwrap();
        stdout.flush().await.unwrap();
    }
}
