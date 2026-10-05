//! Small filesystem helpers for files holding secrets.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::Path;

use serde::Serialize;
use serde::de::DeserializeOwned;

/// Atomically replaces `path` with `data`, readable only by the owner.
///
/// Writes to a sibling temp file, syncs it, then renames over the target so
/// readers never observe a partially written file.
pub fn write_private(path: &Path, data: &[u8]) -> io::Result<()> {
    let dir = path.parent().unwrap_or(Path::new("."));
    private_dir(dir)?;
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    let tmp = dir.join(format!(".{name}.{}.tmp", std::process::id()));

    let mut file = private_options().open(&tmp)?;
    let result = file.write_all(data).and_then(|()| file.sync_all());
    drop(file);
    match result.and_then(|()| fs::rename(&tmp, path)) {
        Ok(()) => Ok(()),
        Err(err) => {
            let _ = fs::remove_file(&tmp);
            Err(err)
        }
    }
}

/// Serializes `value` as pretty JSON and writes it with [`write_private`].
pub fn write_json<T: Serialize>(path: &Path, value: &T) -> io::Result<()> {
    let mut data = serde_json::to_vec_pretty(value)?;
    data.push(b'\n');
    write_private(path, &data)
}

/// Reads and parses a JSON file, returning `None` if it does not exist.
pub fn read_json<T: DeserializeOwned>(path: &Path) -> io::Result<Option<T>> {
    match fs::read(path) {
        Ok(data) => serde_json::from_slice(&data)
            .map(Some)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

/// Opens (creating if needed) a lock file and takes an exclusive lock on it.
///
/// The lock is released when the returned handle is dropped. Used to keep
/// separate slopmax processes from refreshing the same token concurrently.
pub fn lock(path: &Path) -> io::Result<File> {
    if let Some(dir) = path.parent() {
        private_dir(dir)?;
    }
    let file = private_options().truncate(false).open(path)?;
    file.lock()?;
    Ok(file)
}

/// Creates `dir` and any missing parents, readable only by the owner.
/// Directories that already exist keep their permissions.
pub fn private_dir(dir: &Path) -> io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(dir)
}

fn private_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn new_directories_are_private() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("slopmax-fsx-{}", crate::ids::token()));
        write_private(&root.join("a/b/secret.json"), b"{}").unwrap();
        for dir in [root.join("a"), root.join("a/b")] {
            let mode = fs::metadata(&dir).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o700, "{}", dir.display());
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn write_private_round_trips_and_restricts_permissions() {
        let dir = std::env::temp_dir().join(format!("slopmax-fsx-{}", std::process::id()));
        let path = dir.join("secret.json");
        write_json(&path, &serde_json::json!({ "token": "abc" })).unwrap();

        let value: serde_json::Value = read_json(&path).unwrap().unwrap();
        assert_eq!(value["token"], "abc");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn read_json_missing_file_is_none() {
        let missing = std::env::temp_dir().join("slopmax-definitely-missing.json");
        assert!(read_json::<serde_json::Value>(&missing).unwrap().is_none());
    }
}
