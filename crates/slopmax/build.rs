//! On Windows, `slopmax.exe` carries slopmax's icon, the glass Option key
//! of `assets/icon`, and its version, for Explorer and the taskbar to show.

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    #[cfg(windows)]
    windows();
}

/// The icon and version resource, made with the Windows SDK's resource
/// compiler, which only an MSVC build on Windows has.
#[cfg(windows)]
fn windows() {
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() != Ok("msvc") {
        return;
    }
    let icon = std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap())
        .join(r"..\..\assets\icon\icon.ico");
    println!("cargo:rerun-if-changed={}", icon.display());
    winresource::WindowsResource::new()
        .set_icon(&icon.to_string_lossy())
        .set("ProductName", "slopmax")
        .compile()
        .expect("embedding the icon in slopmax.exe");
}
