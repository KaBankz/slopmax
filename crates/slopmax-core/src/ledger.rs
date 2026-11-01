//! The usage ledger: one JSON line per request that reached the accounts,
//! answered or failed, in monthly files (`~/.slopmax/usage/2026-10.jsonl`).
//! `slopmax usage` reads it back.

use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::provider::ProviderId;
use crate::time::{SignedDuration, Timestamp};
use crate::{fsx, log};

/// One request: answered, or failed with the status the agent got.
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
    /// Accounts tried: the last one answered, or none did.
    #[serde(default = "one", skip_serializing_if = "is_one")]
    pub attempts: u32,
    /// The agent that sent it (`claude`, `codex`), or `slopmax` for the
    /// requests slopmax sends itself to start a window.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    /// The agent's session (its conversation), when it names one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
}

impl Entry {
    /// Every token the request moved: input, output, and both kinds of cache.
    pub fn tokens(&self) -> u64 {
        self.input + self.output + self.cache_read + self.cache_write
    }

    /// Whether it ended in an error instead of an answer.
    pub fn failed(&self) -> bool {
        self.status >= 400
    }

    /// Whether it is a request someone made: an answer that moved tokens,
    /// unlike a failure or an agent's housekeeping (listing models,
    /// counting tokens).
    pub fn answered(&self) -> bool {
        !self.failed() && self.tokens() > 0
    }
}

fn one() -> u32 {
    1
}

fn is_one(n: &u32) -> bool {
    *n == 1
}

/// Appends entries to the month file it keeps open. Each entry is one
/// `write` on a file opened for appending, which the kernel lands whole and
/// in order beside other processes' appends; nothing is queued, so nothing
/// is lost when the daemon stops.
#[derive(Debug)]
pub struct Ledger {
    dir: PathBuf,
    open: Mutex<Writer>,
}

#[derive(Debug, Default)]
struct Writer {
    /// The month file, and the month it is for.
    month: Option<((i64, u32), File)>,
    /// The line being written, kept to save an allocation per entry.
    line: Vec<u8>,
    /// Entries a failed write lost since the daemon started.
    dropped: u64,
}

impl Ledger {
    /// A ledger writing into `dir`, which is created on the first entry.
    pub fn at(dir: PathBuf) -> Self {
        Self {
            dir,
            open: Mutex::default(),
        }
    }

    /// Appends `entry` to its month's file. A failed write is logged and
    /// counted, and the file is opened afresh for the next entry.
    pub fn record(&self, entry: &Entry) {
        let mut writer = self.open.lock().unwrap_or_else(|p| p.into_inner());
        if let Err(e) = writer.append(&self.dir, entry) {
            writer.month = None;
            writer.dropped += 1;
            if writer.dropped == 1 {
                log::warn!("writing the usage ledger: {e}");
            }
        }
    }

    /// Entries a failed write lost since the daemon started.
    pub fn dropped(&self) -> u64 {
        self.open.lock().unwrap_or_else(|p| p.into_inner()).dropped
    }

    /// Flushes the month file to the disk, for a daemon that is stopping.
    pub fn sync(&self) {
        let writer = self.open.lock().unwrap_or_else(|p| p.into_inner());
        if let Some((_, file)) = &writer.month
            && let Err(e) = file.sync_data()
        {
            log::warn!("syncing the usage ledger: {e}");
        }
    }
}

impl Writer {
    fn append(&mut self, dir: &Path, entry: &Entry) -> std::io::Result<()> {
        let (year, month, _) = entry.at.date(SignedDuration::ZERO);
        let key = (year, month);
        if self.month.as_ref().is_none_or(|(open, _)| *open != key) {
            self.month = None;
            self.month = Some((key, open_month(dir, &file_for(dir, entry.at))?));
        }
        let Some((_, file)) = &mut self.month else {
            unreachable!("opened above");
        };
        self.line.clear();
        serde_json::to_writer(&mut self.line, entry).map_err(std::io::Error::other)?;
        self.line.push(b'\n');
        file.write_all(&self.line)
    }
}

/// Opens a month file for appending, private to the owner. A file a crash
/// left without its last newline gets one first, so the next entry starts
/// its own line instead of joining the torn one.
fn open_month(dir: &Path, path: &Path) -> std::io::Result<File> {
    fsx::private_dir(dir)?;
    let mut options = OpenOptions::new();
    options.read(true).create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    let len = file.metadata()?.len();
    if len > 0 {
        let mut last = [0];
        file.seek(SeekFrom::Start(len - 1))?;
        file.read_exact(&mut last)?;
        if last[0] != b'\n' {
            file.write_all(b"\n")?;
        }
    }
    Ok(file)
}

fn file_for(dir: &Path, at: Timestamp) -> PathBuf {
    let (year, month, _) = at.date(SignedDuration::ZERO);
    dir.join(format!("{year:04}-{month:02}.jsonl"))
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
            agent: None,
            session: None,
        }
    }

    fn temp_dir() -> PathBuf {
        std::env::temp_dir().join(format!("slopmax-ledger-{}", crate::ids::token()))
    }

    #[test]
    fn writes_monthly_files_and_reads_them_back() {
        let dir = temp_dir();
        let september = entry("2026-09-30T23:00:00Z", "a");
        let october = entry("2026-10-01T01:00:00Z", "b");
        let ledger = Ledger::at(dir.clone());
        ledger.record(&september);
        ledger.record(&october);
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

    #[test]
    fn every_entry_is_on_disk_as_soon_as_it_is_recorded() {
        let dir = temp_dir();
        let ledger = Ledger::at(dir.clone());
        let since = Timestamp::UNIX_EPOCH;
        for n in 0..50 {
            ledger.record(&entry("2026-10-02T00:00:00Z", &n.to_string()));
            assert_eq!(read(&dir, since).len(), n + 1);
        }
        ledger.sync();
        assert_eq!(ledger.dropped(), 0);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn appends_beside_another_writer_and_mends_a_torn_line() {
        let dir = temp_dir();
        let first = Ledger::at(dir.clone());
        first.record(&entry("2026-10-02T00:00:00Z", "a"));
        // A crash left half a line behind.
        let path = dir.join("2026-10.jsonl");
        let mut file = OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(br#"{"at":"2026-10-02T00:00:01Z","acc"#)
            .unwrap();
        // Another process (the CLI, a second ledger) appends after it.
        let second = Ledger::at(dir.clone());
        second.record(&entry("2026-10-02T00:00:02Z", "b"));
        first.record(&entry("2026-10-02T00:00:03Z", "c"));
        let models: Vec<String> = read(&dir, Timestamp::UNIX_EPOCH)
            .into_iter()
            .filter_map(|e| e.model)
            .collect();
        assert_eq!(models, ["a", "b", "c"]);
        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn keeps_the_directory_and_month_files_private() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir();
        Ledger::at(dir.clone()).record(&entry("2026-10-02T00:00:00Z", "a"));
        let mode = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&dir), 0o700);
        assert_eq!(mode(&dir.join("2026-10.jsonl")), 0o600);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn counts_what_a_failed_write_lost_and_writes_again_once_it_can() {
        let dir = temp_dir();
        // A file where the directory should be.
        fs::write(&dir, b"").unwrap();
        let ledger = Ledger::at(dir.clone());
        ledger.record(&entry("2026-10-02T00:00:00Z", "a"));
        assert_eq!(ledger.dropped(), 1);
        fs::remove_file(&dir).unwrap();
        ledger.record(&entry("2026-10-02T00:00:01Z", "b"));
        assert_eq!(read(&dir, Timestamp::UNIX_EPOCH).len(), 1);
        assert_eq!(ledger.dropped(), 1);
        fs::remove_dir_all(dir).unwrap();
    }
}
