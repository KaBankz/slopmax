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
    println!("cargo:rerun-if-env-changed=SLOPMAX_UI_REQUIRED");
    let made = winresource::WindowsResource::new()
        .set_icon(&icon.to_string_lossy())
        .set("ProductName", "slopmax")
        .compile();
    if let Err(err) = made {
        // Off Windows, a check or lint of the Windows code may have no
        // llvm-rc; only a release (which sets SLOPMAX_UI_REQUIRED) must
        // carry the icon.
        if cfg!(windows) || std::env::var_os("SLOPMAX_UI_REQUIRED").is_some() {
            panic!("embedding the icon in slopmax.exe: {err}");
        }
        println!("cargo:warning=slopmax.exe has no icon: {err}");
    }
}
