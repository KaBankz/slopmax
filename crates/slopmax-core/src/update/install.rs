//! How this slopmax was installed, which decides how it updates, and the
//! link the login service runs it through.
//!
//! The install is read from where the binary is: mise keeps each version in
//! a directory of its own under `installs/<tool>/`, Homebrew under
//! `Cellar/`, cargo in `~/.cargo/bin`, Nix in the read-only store. Anything
//! else is a file slopmax may replace itself, as the install script puts it.
//!
//! The service runs `~/.slopmax/bin/slopmax`, a link to the installed
//! binary: mise's path changes with each version and drops old ones a day
//! after an upgrade, so a service that named a version's path would run a
//! removed binary at its next start.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use crate::paths::Home;

/// How the running slopmax was installed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Install {
    /// By mise, as `tool` (`github:KaBankz/slopmax`), each version in a
    /// directory under `root`.
    Mise { tool: String, root: PathBuf },
    /// By Homebrew, whose `prefix/bin/slopmax` links the current version.
    Homebrew { prefix: PathBuf },
    /// By `cargo install`.
    Cargo,
    /// From the Nix store, which only Nix changes.
    Nix,
    /// A file slopmax may replace: the install script's, or a copy.
    File,
}

impl Install {
    /// The install `exe` (a path with its links resolved) belongs to.
    pub fn of(exe: &Path) -> Self {
        let has = |name: &str| exe.components().any(|c| c.as_os_str() == name);
        if exe.starts_with("/nix/store") {
            return Self::Nix;
        }
        if let Some(found) = mise_install(exe) {
            return found;
        }
        if has("Cellar") || has("Caskroom") {
            let prefix = exe
                .ancestors()
                .find(|a| {
                    a.file_name()
                        .is_some_and(|n| n == "Cellar" || n == "Caskroom")
                })
                .and_then(Path::parent)
                .map(Path::to_path_buf)
                .unwrap_or_default();
            return Self::Homebrew { prefix };
        }
        let cargo_bin = std::env::var_os("CARGO_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::home_dir().map(|h| h.join(".cargo")))
            .map(|c| c.join("bin"));
        if cargo_bin.is_some_and(|bin| exe.parent() == Some(bin.as_path())) {
            return Self::Cargo;
        }
        Self::File
    }

    /// What the service link should name for `exe`: Homebrew's link, which
    /// it moves to each new version, else `exe`.
    pub fn entry(&self, exe: &Path) -> PathBuf {
        match self {
            Self::Homebrew { prefix } => Some(prefix.join("bin").join(binary_name()))
                .filter(|p| p.is_file())
                .unwrap_or_else(|| exe.to_path_buf()),
            _ => exe.to_path_buf(),
        }
    }

    /// The binary this install runs now, which the service link should
    /// name: for mise, the version mise would run; for Homebrew, its link;
    /// otherwise `exe` itself, which an update replaces in place.
    pub fn current(&self, exe: &Path) -> Option<PathBuf> {
        match self {
            Self::Mise { tool, root } => mise_where(tool)
                .map(|dir| dir.join(binary_name()))
                .filter(|p| p.is_file())
                .or_else(|| newest_in(root)),
            Self::Homebrew { prefix } => Some(prefix.join("bin").join(binary_name())),
            _ => Some(exe.to_path_buf()),
        }
    }

    /// The command that updates this install when slopmax may not do it
    /// itself.
    pub fn update_command(&self) -> Option<String> {
        match self {
            Self::Homebrew { .. } => Some("brew upgrade slopmax".to_owned()),
            Self::Cargo => Some(
                "cargo install --locked --git https://github.com/KaBankz/slopmax slopmax"
                    .to_owned(),
            ),
            Self::Nix => Some("update it through Nix, as it was installed".to_owned()),
            Self::Mise { .. } | Self::File => None,
        }
    }
}

fn binary_name() -> String {
    format!("slopmax{}", std::env::consts::EXE_SUFFIX)
}

/// `exe` as mise installed it: `<root>/<version>/slopmax`, where `root`
/// holds `.mise.backend.toml` naming the tool.
fn mise_install(exe: &Path) -> Option<Install> {
    let root = exe.parent()?.parent()?;
    let backend = std::fs::read_to_string(root.join(".mise.backend.toml")).ok()?;
    let tool = backend.lines().find_map(|line| {
        let (key, value) = line.split_once('=')?;
        (key.trim() == "full").then(|| value.trim().trim_matches('"').to_owned())
    })?;
    Some(Install::Mise {
        tool,
        root: root.to_path_buf(),
    })
}

/// The newest version's binary under a mise tool's `root`, for when mise
/// itself cannot be asked.
fn newest_in(root: &Path) -> Option<PathBuf> {
    std::fs::read_dir(root)
        .ok()?
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .filter_map(|e| {
            let version = super::Version::parse(&e.file_name().to_string_lossy())?;
            let binary = e.path().join(binary_name());
            binary.is_file().then_some((version, binary))
        })
        .max_by_key(|(version, _)| *version)
        .map(|(_, binary)| binary)
}

/// The mise program: on the PATH, else where its installer puts it. A
/// login service's PATH often leaves out `~/.local/bin`.
pub fn mise() -> Option<PathBuf> {
    let name = format!("mise{}", std::env::consts::EXE_SUFFIX);
    let on_path = std::env::var_os("PATH")
        .into_iter()
        .flat_map(|path| std::env::split_paths(&path).collect::<Vec<_>>())
        .map(|dir| dir.join(&name));
    let home = std::env::home_dir().unwrap_or_default();
    let usual = [
        home.join(".local/bin").join(&name),
        home.join(".local/share/mise/bin").join(&name),
        PathBuf::from("/opt/homebrew/bin").join(&name),
        PathBuf::from("/usr/local/bin").join(&name),
        PathBuf::from("/usr/bin").join(&name),
    ];
    on_path.chain(usual).find(|p| p.is_file())
}

/// Runs mise with `args` from the user's home, so the global config
/// decides the version rather than a project's. Its standard output, if it
/// succeeded.
fn run_mise(args: &[&str]) -> Option<String> {
    let output = Command::new(mise()?)
        .args(args)
        .current_dir(std::env::home_dir()?)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

/// The directory of the version of `tool` mise runs now.
pub fn mise_where(tool: &str) -> Option<PathBuf> {
    run_mise(&["where", tool])
        .filter(|p| !p.is_empty())
        .map(PathBuf::from)
}

/// What mise's config asks of `tool`: the version as written (`latest`,
/// `0.10.1`, …) and the file that says so.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MiseRequest {
    pub version: String,
    pub source: Option<PathBuf>,
}

pub fn mise_request(tool: &str) -> Option<MiseRequest> {
    let listed: serde_json::Value =
        serde_json::from_str(&run_mise(&["ls", "--json", tool])?).ok()?;
    let active = listed.as_array()?.iter().find(|v| v["active"] == true)?;
    Some(MiseRequest {
        version: active["requested_version"].as_str()?.to_owned(),
        source: active["source"]["path"].as_str().map(PathBuf::from),
    })
}

/// Whether `path` is mise's global config, which `slopmax update` may move
/// to a new version: a project's config pins what that project asks for.
pub fn is_global_mise_config(path: &Path) -> bool {
    let mut global = Vec::new();
    if let Some(file) = std::env::var_os("MISE_GLOBAL_CONFIG_FILE") {
        global.push(PathBuf::from(file));
    }
    let config = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::home_dir().map(|h| h.join(".config")));
    if let Some(config) = config {
        global.push(config.join("mise").join("config.toml"));
    }
    global.iter().any(|g| same_file(g, path))
}

fn same_file(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

/// Runs mise to install the newest release for `request`, its progress on
/// the terminal: `mise upgrade` keeps to what the config asks, so a pinned
/// version is moved with `--bump`, which rewrites the pin.
///
/// `slopmax update` has already found the newest release, so mise is told
/// to see it too: its list of versions is fetched fresh rather than read
/// from a cache up to an hour old, and its minimum release age (a day by
/// default) doesn't hold back a release made today.
pub fn mise_upgrade(tool: &str, bump: bool) -> anyhow::Result<()> {
    use anyhow::Context;
    let mise = mise().context("mise installed slopmax, but the mise program can't be found")?;
    let status = upgrade_command(&mise, tool, bump)
        .status()
        .with_context(|| format!("running {}", mise.display()))?;
    if !status.success() {
        anyhow::bail!("`mise upgrade {tool}` failed");
    }
    Ok(())
}

fn upgrade_command(mise: &Path, tool: &str, bump: bool) -> Command {
    let mut command = Command::new(mise);
    command
        .env("MISE_FETCH_REMOTE_VERSIONS_CACHE", "0")
        .env("MISE_MINIMUM_RELEASE_AGE", "0s")
        .arg("upgrade");
    if bump {
        command.arg("--bump");
    }
    command.arg(tool);
    if let Some(home) = std::env::home_dir() {
        command.current_dir(home);
    }
    command
}

/// Where the login service's link points, if it is there.
pub fn linked(home: &Home) -> Option<PathBuf> {
    std::fs::read_link(home.service_exe()).ok()
}

/// Points the service's link at `target`, replacing what it named in one
/// step: the service never finds it missing.
#[cfg(unix)]
pub fn link(home: &Home, target: &Path) -> std::io::Result<()> {
    let link = home.service_exe();
    if linked(home).as_deref() == Some(target) {
        return Ok(());
    }
    let dir = link.parent().expect("the link is in a directory");
    crate::fsx::private_dir(home.dir())?;
    std::fs::create_dir_all(dir)?;
    let staged = dir.join(format!(".slopmax.{}.link", std::process::id()));
    let _ = std::fs::remove_file(&staged);
    std::os::unix::fs::symlink(target, &staged)?;
    std::fs::rename(&staged, &link).inspect_err(|_| {
        let _ = std::fs::remove_file(&staged);
    })
}

/// Windows' service names the binary itself, which updates in place.
#[cfg(not(unix))]
pub fn link(_home: &Home, _target: &Path) -> std::io::Result<()> {
    Ok(())
}

/// What a file is, to tell when one was replaced at the same path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileId {
    #[cfg(unix)]
    dev: u64,
    #[cfg(unix)]
    ino: u64,
    #[cfg(not(unix))]
    len: u64,
    #[cfg(not(unix))]
    modified: Option<std::time::SystemTime>,
}

impl FileId {
    /// `path`'s identity, following links.
    pub fn of(path: &Path) -> Option<Self> {
        let meta = std::fs::metadata(path).ok()?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            Some(Self {
                dev: meta.dev(),
                ino: meta.ino(),
            })
        }
        #[cfg(not(unix))]
        {
            Some(Self {
                len: meta.len(),
                modified: meta.modified().ok(),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::temp_dir;

    #[test]
    fn mise_upgrades_to_a_release_made_today() {
        let command = upgrade_command(Path::new("mise"), "github:KaBankz/slopmax", true);
        let envs: Vec<_> = command.get_envs().collect();
        assert!(envs.contains(&(
            "MISE_FETCH_REMOTE_VERSIONS_CACHE".as_ref(),
            Some("0".as_ref())
        )));
        assert!(envs.contains(&("MISE_MINIMUM_RELEASE_AGE".as_ref(), Some("0s".as_ref()))));
        let args: Vec<_> = command.get_args().collect();
        assert_eq!(args, ["upgrade", "--bump", "github:KaBankz/slopmax"]);
    }

    #[test]
    fn installs_are_told_by_where_the_binary_is() {
        let dir = temp_dir("install-kinds");
        let root = dir.join("mise/installs/github-ka-bankz-slopmax");
        std::fs::create_dir_all(root.join("0.10.1")).unwrap();
        std::fs::write(
            root.join(".mise.backend.toml"),
            "short = \"github:KaBankz/slopmax\"\nfull = \"github:KaBankz/slopmax\"\n",
        )
        .unwrap();
        assert_eq!(
            Install::of(&root.join("0.10.1/slopmax")),
            Install::Mise {
                tool: "github:KaBankz/slopmax".into(),
                root: root.clone()
            }
        );
        assert_eq!(
            Install::of(Path::new("/opt/homebrew/Cellar/slopmax/1.0.0/bin/slopmax")),
            Install::Homebrew {
                prefix: "/opt/homebrew".into()
            }
        );
        assert_eq!(
            Install::of(Path::new("/nix/store/abc-slopmax/bin/slopmax")),
            Install::Nix
        );
        assert_eq!(Install::of(&dir.join("bin/slopmax")), Install::File);
        assert!(
            Install::Cargo
                .update_command()
                .unwrap()
                .starts_with("cargo install")
        );
        assert_eq!(Install::File.update_command(), None);
    }

    #[test]
    fn without_mise_at_hand_the_newest_installed_version_is_current() {
        let dir = temp_dir("mise-newest");
        for version in ["0.9.0", "0.10.1", "0.10.0"] {
            std::fs::create_dir_all(dir.join(version)).unwrap();
            std::fs::write(dir.join(version).join(binary_name()), "").unwrap();
        }
        // A version mise has not finished installing has no binary yet.
        std::fs::create_dir_all(dir.join("0.11.0")).unwrap();
        assert_eq!(
            newest_in(&dir),
            Some(dir.join("0.10.1").join(binary_name()))
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_service_link_moves_in_one_step() {
        let dir = temp_dir("service-link");
        let home = Home::sandbox(dir.to_path_buf());
        assert_eq!(linked(&home), None);
        link(&home, Path::new("/opt/a/slopmax")).unwrap();
        assert_eq!(linked(&home).unwrap(), Path::new("/opt/a/slopmax"));
        link(&home, Path::new("/opt/b/slopmax")).unwrap();
        assert_eq!(linked(&home).unwrap(), Path::new("/opt/b/slopmax"));
        let left: Vec<_> = std::fs::read_dir(home.service_exe().parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(left, ["slopmax"]);
    }
}
