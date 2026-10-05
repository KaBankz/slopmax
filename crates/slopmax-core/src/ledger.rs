//! The usage ledger: one JSON line per answered request, in monthly files
//! (`~/.slopmax/usage/2026-10.jsonl`). `slopmax usage` reads it back.

use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

use crate::provider::ProviderId;
use crate::time::{SignedDuration, Timestamp};
use crate::{fsx, log};

/// One answered request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Entry {
    pub at: Timestamp,
    pub account: String,
    pub provider: ProviderId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub status: u16,
    #[serde(default)]
    pub input: u64,
    #[serde(default)]
    pub output: u64,
    #[serde(default)]
    pub cache_read: u64,
    #[serde(default)]
    pub cache_write: u64,
    /// Milliseconds from the request arriving to its last byte.
    pub ms: u64,
    /// Milliseconds from the request arriving to the first response byte.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_byte_ms: Option<u64>,
    /// Accounts tried before one answered.
    #[serde(default = "one", skip_serializing_if = "is_one")]
    pub attempts: u32,
}

fn one() -> u32 {
    1
}

fn is_one(n: &u32) -> bool {
    *n == 1
}

/// Appends entries in the background, so requests never wait on the disk.
#[derive(Debug, Clone)]
pub struct Ledger(mpsc::UnboundedSender<Entry>);

impl Ledger {
    /// Starts the writer for `dir`.
    pub fn start(dir: PathBuf) -> Self {
        let (tx, mut rx) = mpsc::unbounded_channel::<Entry>();
        tokio::spawn(async move {
            while let Some(first) = rx.recv().await {
                let mut batch = vec![first];
                while let Ok(entry) = rx.try_recv() {
                    batch.push(entry);
                }
                let dir = dir.clone();
                let written = tokio::task::spawn_blocking(move || append(&dir, &batch)).await;
                if let Ok(Err(e)) = written {
                    log::warn!("writing the usage ledger: {e}");
                }
            }
        });
        Self(tx)
    }

    pub fn record(&self, entry: Entry) {
        let _ = self.0.send(entry);
    }
}

fn file_for(dir: &Path, at: Timestamp) -> PathBuf {
    let (year, month, _) = at.date(SignedDuration::ZERO);
    dir.join(format!("{year:04}-{month:02}.jsonl"))
}

fn append(dir: &Path, entries: &[Entry]) -> std::io::Result<()> {
    fsx::private_dir(dir)?;
    let mut by_file: BTreeMap<PathBuf, Vec<&Entry>> = BTreeMap::new();
    for entry in entries {
        by_file
            .entry(file_for(dir, entry.at))
            .or_default()
            .push(entry);
    }
    for (path, entries) in by_file {
        let mut options = OpenOptions::new();
        options.create(true).append(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&path)?;
        let mut text = String::new();
        for entry in entries {
            text.push_str(&serde_json::to_string(entry).map_err(std::io::Error::other)?);
            text.push('\n');
        }
        file.write_all(text.as_bytes())?;
    }
    Ok(())
}

/// Every entry at or after `since`, oldest first. Unreadable lines (a
/// partial write, a newer format) are skipped.
pub fn read(dir: &Path, since: Timestamp) -> Vec<Entry> {
    let first = file_for(dir, since);
    let Ok(listing) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut files: Vec<PathBuf> = listing
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|ext| ext == "jsonl") && *p >= first)
        .collect();
    files.sort();
    let mut entries = Vec::new();
    for path in files {
        let Ok(file) = fs::File::open(&path) else {
            continue;
        };
        for line in BufReader::new(file).lines().map_while(Result::ok) {
            if let Ok(entry) = serde_json::from_str::<Entry>(&line)
                && entry.at >= since
            {
                entries.push(entry);
            }
        }
    }
    entries.sort_by_key(|e| e.at);
    entries
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(at: &str, model: &str) -> Entry {
        Entry {
            at: at.parse().unwrap(),
            account: "claude-1".into(),
            provider: ProviderId::Claude,
            model: Some(model.into()),
            status: 200,
            input: 10,
            output: 5,
            cache_read: 100,
            cache_write: 0,
            ms: 900,
            first_byte_ms: Some(300),
            attempts: 1,
        }
    }

    #[tokio::test]
    async fn writes_monthly_files_and_reads_them_back() {
        let dir = std::env::temp_dir().join(format!("slopmax-ledger-{}", crate::ids::token()));
        let september = entry("2026-09-30T23:00:00Z", "a");
        let october = entry("2026-10-01T01:00:00Z", "b");
        append(&dir, &[september.clone(), october.clone()]).unwrap();
        assert!(dir.join("2026-09.jsonl").exists());
        assert!(dir.join("2026-10.jsonl").exists());

        let all = read(&dir, "2026-01-01T00:00:00Z".parse().unwrap());
        assert_eq!(all, [september, october.clone()]);
        let recent = read(&dir, "2026-10-01T00:00:00Z".parse().unwrap());
        assert_eq!(recent, [october]);

        // Lines stay compact: defaults are left out.
        let text = fs::read_to_string(dir.join("2026-10.jsonl")).unwrap();
        assert!(!text.contains("attempts"), "{text}");
        fs::remove_dir_all(dir).unwrap();
    }
}
