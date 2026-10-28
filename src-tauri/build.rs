fn main() {
    println!(
        "cargo:rustc-env=DESKTOP_TARGET={}",
        std::env::var("TARGET").unwrap()
    );
    #[cfg(feature = "desktop")]
    tauri_build::build();
}
