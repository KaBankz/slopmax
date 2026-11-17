//! On Windows, `slopmax.exe` carries slopmax's icon, the glass Option key
//! of `assets/icon`, and its version, for Explorer and the taskbar to show.

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    // The target's OS, not this build script's: release builds for Windows
    // are cross-compiled on Linux.
    let target = |key| std::env::var(key).unwrap_or_default();
    if target("CARGO_CFG_TARGET_OS") == "windows" && target("CARGO_CFG_TARGET_ENV") == "msvc" {
        windows();
    }
}

/// The icon and version resource, made with a resource compiler: the
/// Windows SDK's `rc.exe` on Windows, LLVM's `llvm-rc` elsewhere (or the one
/// `RC_PATH` names).
fn windows() {
    let icon = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../assets/icon/icon.ico");
    println!("cargo:rerun-if-changed={}", icon.display());
    println!("cargo:rerun-if-env-changed=RC_PATH");
    winresource::WindowsResource::new()
        .set_icon(&icon.to_string_lossy())
        .set("ProductName", "slopmax")
        .compile()
        .expect("embedding the icon in slopmax.exe");
}
