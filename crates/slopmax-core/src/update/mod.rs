//! Updates: which release is the newest, how this slopmax was installed,
//! and putting a newer one in place the way it was installed.
//!
//! The running proxy moves to a newer binary on its own once one is
//! installed (`slopmax-daemon`'s handoff); this is everything before that.

pub mod archive;
pub mod install;

use std::fmt;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow, bail};
use serde::{Deserialize, Serialize};

use crate::fsx;
use crate::net::Client;
use crate::paths::Home;
use crate::time::{SignedDuration, Timestamp};

/// Where releases are published.
pub const RELEASES: &str = "https://github.com/KaBankz/slopmax/releases";
/// How long a lookup of the newest release is good for.
pub const CHECK_EVERY: SignedDuration = SignedDuration::from_hours(24);
/// The most a release archive or the binary in it may weigh.
const MAX_DOWNLOAD: usize = 256 * 1024 * 1024;

/// A release's version, `major.minor.patch`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Version {
    major: u64,
    minor: u64,
    patch: u64,
}

impl Version {
    /// `0.10.1` from `0.10.1`, `v0.10.1`, or `slopmax 0.10.1`; a
    /// pre-release or build suffix is dropped.
    pub fn parse(text: &str) -> Option<Self> {
        let word = text.split_whitespace().last()?;
        let word = word.strip_prefix('v').unwrap_or(word);
        let core = word.split(['-', '+']).next()?;
        let mut parts = core.split('.').map(|p| p.parse::<u64>().ok());
        let version = Self {
            major: parts.next()??,
            minor: parts.next()??,
            patch: parts.next()??,
        };
        parts.next().is_none().then_some(version)
    }

    /// This binary's version.
    pub fn current() -> Self {
        Self::parse(env!("CARGO_PKG_VERSION")).expect("the crate version is major.minor.patch")
    }
}

impl fmt::Display for Version {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)
    }
}

/// The newest release's version, from where `releases/latest` redirects:
/// a plain page, so not held to the 60 lookups an hour GitHub's API allows
/// without a token.
pub async fn latest(http: &Client) -> Result<Version> {
    let url = format!("{RELEASES}/latest");
    let response = http
        .get(&url)
        .send()
        .await
        .context("looking up the newest slopmax release")?;
    let location = response
        .headers()
        .get(http::header::LOCATION)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| {
            anyhow!(
                "looking up the newest slopmax release: {url} answered {} without a redirect",
                response.status()
            )
        })?;
    location
        .rsplit_once("/tag/")
        .and_then(|(_, tag)| Version::parse(tag))
        .ok_or_else(|| anyhow!("the newest release's address names no version: {location}"))
}

/// The newest release as last looked up, kept in the home so a look costs
/// one request a day.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Checked {
    pub checked_at: Timestamp,
    pub latest: String,
}

impl Checked {
    pub fn read(home: &Home) -> Option<Self> {
        fsx::read_toml(&home.update_check()).ok().flatten()
    }

    pub fn write(&self, home: &Home) -> std::io::Result<()> {
        fsx::write_toml(&home.update_check(), self)
    }

    /// Whether it is time to look again.
    pub fn stale(&self, now: Timestamp) -> bool {
        now.duration_since(self.checked_at) >= CHECK_EVERY
    }

    /// The release newer than this binary, if one was found.
    pub fn newer(&self) -> Option<Version> {
        Version::parse(&self.latest).filter(|v| *v > Version::current())
    }
}

/// Whether the daemon looks for releases: `check_updates`, unless
/// `SLOPMAX_NO_UPDATE_CHECK` is set.
pub fn checks(config: &crate::config::Config) -> bool {
    config.check_updates && std::env::var_os("SLOPMAX_NO_UPDATE_CHECK").is_none_or(|v| v.is_empty())
}

/// The release target this binary was built for, as release files name it.
pub fn target() -> Option<&'static str> {
    use std::env::consts::{ARCH, OS};
    Some(match (ARCH, OS) {
        ("x86_64", "linux") => "x86_64-unknown-linux-musl",
        ("aarch64", "linux") => "aarch64-unknown-linux-musl",
        ("x86_64", "macos") => "x86_64-apple-darwin",
        ("aarch64", "macos") => "aarch64-apple-darwin",
        ("x86_64", "windows") => "x86_64-pc-windows-msvc",
        ("aarch64", "windows") => "aarch64-pc-windows-msvc",
        _ => return None,
    })
}

/// The binaries a release ships for this machine, by file name, checked
/// against the release's SHA-256.
pub async fn download(http: &Client, version: Version) -> Result<Vec<(String, Vec<u8>)>> {
    let target = target().context("no prebuilt slopmax for this machine")?;
    let ext = if cfg!(windows) { "zip" } else { "tar.gz" };
    let base = format!("{RELEASES}/download/v{version}");
    let name = format!("slopmax-{target}.{ext}");
    let archive = fetch(http, &format!("{base}/{name}")).await?;
    let sums = fetch(http, &format!("{base}/slopmax-{target}.sha256")).await?;
    let sums = String::from_utf8_lossy(&sums);
    let expected = sums
        .split_whitespace()
        .next()
        .filter(|hex| hex.len() == 64)
        .with_context(|| format!("slopmax-{target}.sha256 holds no SHA-256"))?;
    let actual = sha256_hex(&archive);
    if !actual.eq_ignore_ascii_case(expected) {
        bail!(
            "{name} does not match its SHA-256 (got {actual}, expected {expected}); nothing was changed"
        );
    }
    if cfg!(windows) {
        archive::from_zip(&archive, &["slopmax.exe", "slopmaxw.exe"], MAX_DOWNLOAD)
    } else {
        let binary = archive::from_tar_gz(&archive, "slopmax", MAX_DOWNLOAD)?;
        Ok(vec![("slopmax".to_owned(), binary)])
    }
}

/// `url`'s body, following redirects: release files are served from
/// another host.
async fn fetch(http: &Client, url: &str) -> Result<Vec<u8>> {
    let mut url = url.to_owned();
    for _ in 0..5 {
        let response = http
            .get(&url)
            .timeout(Duration::from_secs(300))
            .send()
            .await
            .with_context(|| format!("downloading {url}"))?;
        if response.status().is_redirection() {
            let next = response
                .headers()
                .get(http::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .with_context(|| format!("{url} redirected nowhere"))?;
            url = resolve(&url, next);
            continue;
        }
        let response = response
            .error_for_status()
            .with_context(|| format!("downloading {url}"))?;
        let bytes = response
            .bytes()
            .await
            .with_context(|| format!("downloading {url}"))?;
        if bytes.len() > MAX_DOWNLOAD {
            bail!("{url} is larger than any release");
        }
        return Ok(bytes.to_vec());
    }
    bail!("downloading {url}: too many redirects")
}

/// `location` as an absolute URL, relative to `base`.
fn resolve(base: &str, location: &str) -> String {
    if location.contains("://") {
        return location.to_owned();
    }
    let origin_end = base
        .find("://")
        .and_then(|at| base[at + 3..].find('/').map(|slash| at + 3 + slash))
        .unwrap_or(base.len());
    if location.starts_with('/') {
        format!("{}{location}", &base[..origin_end])
    } else {
        let dir_end = base
            .rfind('/')
            .filter(|&i| i >= origin_end)
            .unwrap_or(base.len());
        format!("{}/{location}", &base[..dir_end])
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = ring::digest::digest(&ring::digest::SHA256, bytes);
    digest.as_ref().iter().map(|b| format!("{b:02x}")).collect()
}

/// Puts `files` in `dir` in place of the ones there, each written beside
/// its old self first and renamed over it, so a binary that runs keeps its
/// file and a failure leaves the old one whole. `slopmax` (or
/// `slopmax.exe`) must say it is `version` before anything is replaced.
///
/// Windows does not let a running program's file go, but lets it be
/// renamed: the old one becomes `<name>.old`, removed at the next update.
pub fn put_in_place(dir: &Path, files: &[(String, Vec<u8>)], version: Version) -> Result<()> {
    let mut staged = Vec::new();
    let result = (|| {
        for (name, bytes) in files {
            let new = dir.join(format!(".{name}.new"));
            write_executable(&new, bytes).with_context(|| {
                format!(
                    "writing {} (is {} writable? an install there needs its owner to update it)",
                    new.display(),
                    dir.display()
                )
            })?;
            staged.push(new.clone());
            if name.trim_end_matches(".exe") == "slopmax" {
                let says = binary_version(&new);
                if says != Some(version) {
                    bail!(
                        "the downloaded slopmax says it is {}, not {version}; nothing was changed",
                        says.map_or("nothing".to_owned(), |v| v.to_string())
                    );
                }
            }
        }
        Ok(())
    })();
    if let Err(e) = result {
        for new in &staged {
            let _ = std::fs::remove_file(new);
        }
        return Err(e);
    }
    for (name, _) in files {
        let path = dir.join(name);
        let new = dir.join(format!(".{name}.new"));
        if cfg!(windows) && path.exists() {
            let old = dir.join(format!("{name}.old"));
            let _ = std::fs::remove_file(&old);
            std::fs::rename(&path, &old)
                .with_context(|| format!("moving {} aside", path.display()))?;
        }
        std::fs::rename(&new, &path).with_context(|| format!("replacing {}", path.display()))?;
    }
    Ok(())
}

fn write_executable(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let _ = std::fs::remove_file(path);
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o755);
    }
    let mut file = options.open(path)?;
    std::io::Write::write_all(&mut file, bytes)?;
    file.sync_all()
}

/// What the slopmax at `path` says its version is, if it runs and answers
/// within a few seconds.
pub fn binary_version(path: &Path) -> Option<Version> {
    let mut child = Command::new(path)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break,
            Ok(Some(_)) | Err(_) => return None,
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
        }
    }
    let mut out = String::new();
    std::io::Read::read_to_string(&mut child.stdout.take()?, &mut out).ok()?;
    let line = out.lines().next()?;
    line.starts_with("slopmax ")
        .then(|| Version::parse(line))
        .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::{self, Mock};

    #[test]
    fn versions_read_from_tags_and_version_lines_and_order_numerically() {
        let v = |s| Version::parse(s).unwrap();
        assert_eq!(v("0.10.1").to_string(), "0.10.1");
        assert_eq!(v("v0.10.1"), v("0.10.1"));
        assert_eq!(v("slopmax 0.10.1"), v("0.10.1"));
        assert_eq!(v("1.2.3-rc.1"), v("1.2.3"));
        assert!(v("0.10.0") > v("0.9.9"));
        assert!(v("1.0.0") > v("0.99.99"));
        for bad in ["", "0.10", "0.10.1.2", "x.y.z", "slopmax"] {
            assert_eq!(Version::parse(bad), None, "{bad}");
        }
    }

    #[test]
    fn redirects_resolve_against_the_page_that_sent_them() {
        let base = "https://github.com/o/r/releases/download/v1/a.tar.gz";
        assert_eq!(
            resolve(base, "https://cdn.example/x"),
            "https://cdn.example/x"
        );
        assert_eq!(resolve(base, "/o/r/x"), "https://github.com/o/r/x");
        assert_eq!(
            resolve(base, "b.tar.gz"),
            "https://github.com/o/r/releases/download/v1/b.tar.gz"
        );
    }

    #[test]
    fn a_lookup_is_stale_after_a_day_and_tells_only_newer_releases() {
        let now = Timestamp::now();
        let checked = Checked {
            checked_at: now - SignedDuration::from_hours(23),
            latest: "999.0.0".into(),
        };
        assert!(!checked.stale(now));
        assert!(checked.stale(now + SignedDuration::from_hours(2)));
        assert_eq!(checked.newer(), Version::parse("999.0.0"));
        let same = Checked {
            latest: env!("CARGO_PKG_VERSION").into(),
            ..checked
        };
        assert_eq!(same.newer(), None);
    }

    fn github(mock: &Mock) -> Client {
        crate::auth::http_client(crate::net::Origins::new([(
            "https://github.com",
            mock.url.as_str(),
        )]))
    }

    #[tokio::test]
    async fn the_newest_release_is_read_from_the_latest_redirect() {
        let mock = Mock::start(|seen| match seen.route() {
            "/KaBankz/slopmax/releases/latest" => {
                let mut found = testkit::reply(302, "");
                found.headers_mut().insert(
                    "location",
                    "https://github.com/KaBankz/slopmax/releases/tag/v7.8.9"
                        .parse()
                        .unwrap(),
                );
                found
            }
            _ => testkit::reply(404, ""),
        })
        .await;
        assert_eq!(
            latest(&github(&mock)).await.unwrap(),
            Version::parse("7.8.9").unwrap()
        );

        let broken = Mock::start(|_| testkit::reply(200, "a page")).await;
        let error = latest(&github(&broken)).await.unwrap_err().to_string();
        assert!(error.contains("without a redirect"), "{error}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_release_is_downloaded_checked_and_put_in_place() {
        let binary = b"#!/bin/sh\necho slopmax 7.8.9\n".to_vec();
        let archive = archive::tests::release(&binary);
        let target = target().unwrap();
        let sums = format!("{}  slopmax-{target}.tar.gz\n", sha256_hex(&archive));
        let base = format!("/KaBankz/slopmax/releases/download/v7.8.9/slopmax-{target}");
        let (served, listed) = (archive.clone(), sums.clone());
        let mock = Mock::start(move |seen| {
            let path = seen.route();
            if path == format!("{base}.tar.gz") {
                // Release files come from another host.
                let mut moved = testkit::reply(302, "");
                moved
                    .headers_mut()
                    .insert("location", "/cdn/archive".parse().unwrap());
                moved
            } else if path == "/cdn/archive" {
                testkit::reply(200, served.clone())
            } else if path == format!("{base}.sha256") {
                testkit::reply(200, listed.clone())
            } else {
                testkit::reply(404, "")
            }
        })
        .await;
        let version = Version::parse("7.8.9").unwrap();
        let files = download(&github(&mock), version).await.unwrap();
        assert_eq!(files, vec![("slopmax".to_owned(), binary.clone())]);

        let dir = crate::testkit::temp_dir("put-in-place");
        let exe = dir.join("slopmax");
        std::fs::write(&exe, "old").unwrap();
        // A binary that is not the version asked for changes nothing.
        let wrong = put_in_place(&dir, &files, Version::parse("7.8.10").unwrap()).unwrap_err();
        assert!(wrong.to_string().contains("says it is 7.8.9"), "{wrong}");
        assert_eq!(std::fs::read(&exe).unwrap(), b"old");
        put_in_place(&dir, &files, version).unwrap();
        assert_eq!(std::fs::read(&exe).unwrap(), binary);
        assert_eq!(binary_version(&exe), Some(version));
        let left: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(left, ["slopmax"]);
    }

    #[tokio::test]
    async fn a_download_that_does_not_match_its_checksum_is_refused() {
        let target = target().unwrap();
        let base = format!("/KaBankz/slopmax/releases/download/v1.2.3/slopmax-{target}");
        let mock = Mock::start(move |seen| {
            if seen.route().ends_with(".sha256") {
                testkit::reply(200, format!("{}  x\n", "0".repeat(64)))
            } else if seen.route().starts_with(&base) {
                testkit::reply(200, "tampered")
            } else {
                testkit::reply(404, "")
            }
        })
        .await;
        let error = download(&github(&mock), Version::parse("1.2.3").unwrap())
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains("does not match its SHA-256"), "{error}");
    }
}
