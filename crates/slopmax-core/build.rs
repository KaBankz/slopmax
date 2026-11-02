//! Embeds the web UI (`ts/apps/ui`, built with `bun build.ts --rust`) as a
//! table of files, so `slopmax serve` serves it at `/slopmax/`.
//!
//! `SLOPMAX_UI_DIST` names the built files (by default `ts/apps/ui/dist/rust`
//! in this checkout). A file with a smaller `.gz` beside it is embedded as
//! that, and sent with `content-encoding: gzip`. Without a build, one page
//! says how to make one, so building slopmax never needs Bun.

use std::fmt::Write as _;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};

fn main() {
    println!("cargo:rerun-if-env-changed=SLOPMAX_UI_DIST");
    println!("cargo:rerun-if-env-changed=SLOPMAX_UI_REQUIRED");
    let dist = match std::env::var_os("SLOPMAX_UI_DIST") {
        Some(dir) => PathBuf::from(dir),
        None => Path::new(env!("CARGO_MANIFEST_DIR")).join("../../ts/apps/ui/dist/rust"),
    };
    println!("cargo:rerun-if-changed={}", dist.display());
    let mut table = String::from("&[\n");
    let mut names: Vec<PathBuf> = std::fs::read_dir(&dist)
        .map(|entries| entries.filter_map(|e| Some(e.ok()?.path())).collect())
        .unwrap_or_default();
    names.sort();
    let mut built = false;
    for path in names
        .iter()
        .filter(|p| p.is_file() && p.extension().is_none_or(|x| x != "gz"))
    {
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        let gz = PathBuf::from(format!("{}.gz", path.display()));
        let size = |p: &Path| std::fs::metadata(p).map_or(u64::MAX, |m| m.len());
        let (file, gzip) = match size(&gz) < size(path) {
            true => (gz, true),
            false => (path.clone(), false),
        };
        let bytes = std::fs::read(&file).expect("reading a built UI file");
        let mut hasher = std::hash::DefaultHasher::new();
        bytes.hash(&mut hasher);
        let path_text = file.canonicalize().unwrap().display().to_string();
        writeln!(
            table,
            "    Asset {{ name: {name:?}, gzip: {gzip}, etag: \"\\\"{:016x}\\\"\", body: include_bytes!({path_text:?}) }},",
            hasher.finish()
        )
        .unwrap();
        built |= name == "index.html";
    }
    table.push(']');
    if !built {
        // Release builds set this, so none ships without its UI.
        if std::env::var_os("SLOPMAX_UI_REQUIRED").is_some() {
            panic!("no web UI in {}; `mise run ui` builds it", dist.display());
        }
        println!(
            "cargo:warning=the web UI is not built into this slopmax; `mise run ui` builds it"
        );
        table = "&[]".into();
    }
    let out = PathBuf::from(std::env::var_os("OUT_DIR").unwrap()).join("ui.rs");
    std::fs::write(
        out,
        format!("pub(crate) static ASSETS: &[Asset] = {table};\n"),
    )
    .unwrap();
}
