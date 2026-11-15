//! Reading the binaries out of a release archive: a `.tar.gz` holding
//! `slopmax`, or for Windows a `.zip` holding `slopmax.exe` and
//! `slopmaxw.exe`. Only as much of each format as releases use.

use anyhow::{Context, Result, bail};

use crate::wire::sse::{gunzip, inflate_raw};

/// The file named `name` (wherever in the tree) from a gzipped tar.
pub fn from_tar_gz(archive: &[u8], name: &str, limit: usize) -> Result<Vec<u8>> {
    let tar = gunzip(archive, limit).context("the release archive is not gzip")?;
    let mut at = 0;
    while let Some(header) = tar.get(at..at + 512) {
        if header.iter().all(|&b| b == 0) {
            break;
        }
        let size = octal(&header[124..136]).context("a tar header with a bad size")?;
        let data = at + 512;
        let path = text(&header[0..100]);
        let prefix = text(&header[345..500]);
        let regular = matches!(header[156], b'0' | 0);
        let file = path.rsplit('/').next().unwrap_or_default();
        let file = if file.is_empty() && !prefix.is_empty() {
            prefix.rsplit('/').next().unwrap_or_default()
        } else {
            file
        };
        if regular && file == name {
            return tar
                .get(data..data + size)
                .map(<[u8]>::to_vec)
                .context("the release archive ends inside its binary");
        }
        at = data + size.div_ceil(512) * 512;
    }
    bail!("the release archive holds no {name}")
}

fn text(field: &[u8]) -> &str {
    let end = field.iter().position(|&b| b == 0).unwrap_or(field.len());
    std::str::from_utf8(&field[..end]).unwrap_or_default()
}

fn octal(field: &[u8]) -> Option<usize> {
    let digits = text(field).trim();
    usize::from_str_radix(digits, 8).ok()
}

/// The files named in `names` from a zip, each stored or deflated.
pub fn from_zip(archive: &[u8], names: &[&str], limit: usize) -> Result<Vec<(String, Vec<u8>)>> {
    const END: u32 = 0x0605_4b50;
    const CENTRAL: u32 = 0x0201_4b50;
    const LOCAL: u32 = 0x0403_4b50;
    let u16_at = |at: usize| -> Option<usize> {
        Some(usize::from(u16::from_le_bytes(
            archive.get(at..at + 2)?.try_into().ok()?,
        )))
    };
    let u32_at = |at: usize| -> Option<u32> {
        Some(u32::from_le_bytes(
            archive.get(at..at + 4)?.try_into().ok()?,
        ))
    };
    // The end record is the last thing, after a comment of up to 64 KiB.
    let floor = archive.len().saturating_sub(22 + 0xffff);
    let end = (floor..archive.len().saturating_sub(21))
        .rev()
        .find(|&at| u32_at(at) == Some(END))
        .context("the release archive is not a zip")?;
    let count = u16_at(end + 10).context("a short zip")?;
    let mut at = u32_at(end + 16).context("a short zip")? as usize;
    let mut found = Vec::new();
    for _ in 0..count {
        if u32_at(at) != Some(CENTRAL) {
            bail!("the release archive's zip directory is damaged");
        }
        let entry = (|| {
            let method = u16_at(at + 10)?;
            let packed = u32_at(at + 20)? as usize;
            let size = u32_at(at + 24)? as usize;
            let name_len = u16_at(at + 28)?;
            let skip = name_len + u16_at(at + 30)? + u16_at(at + 32)?;
            let local = u32_at(at + 42)? as usize;
            let name = std::str::from_utf8(archive.get(at + 46..at + 46 + name_len)?).ok()?;
            Some((method, packed, size, name.to_owned(), local, 46 + skip))
        })()
        .context("the release archive's zip directory is damaged")?;
        let (method, packed, size, name, local, length) = entry;
        at += length;
        let file = name.rsplit('/').next().unwrap_or_default();
        if !names.contains(&file) {
            continue;
        }
        if size > limit {
            bail!("{file} in the release archive is too large");
        }
        if u32_at(local) != Some(LOCAL) {
            bail!("the release archive's zip is damaged at {file}");
        }
        let data = local
            + 30
            + u16_at(local + 26).context("a short zip")?
            + u16_at(local + 28).context("a short zip")?;
        let bytes = archive
            .get(data..data + packed)
            .with_context(|| format!("the release archive ends inside {file}"))?;
        let bytes = match method {
            0 => bytes.to_vec(),
            8 => inflate_raw(bytes, limit)
                .with_context(|| format!("{file} in the release archive does not decompress"))?,
            other => bail!("{file} in the release archive uses compression {other}"),
        };
        if bytes.len() != size {
            bail!("{file} in the release archive is not the size its directory says");
        }
        found.push((file.to_owned(), bytes));
    }
    for name in names {
        if !found.iter().any(|(n, _)| n == name) {
            bail!("the release archive holds no {name}");
        }
    }
    Ok(found)
}

#[cfg(test)]
pub(crate) mod tests {
    use std::io::Write as _;

    use super::*;

    /// A release archive holding `slopmax` as `data`.
    #[cfg(unix)]
    pub(crate) fn release(data: &[u8]) -> Vec<u8> {
        let mut tar = Vec::new();
        tar_entry(&mut tar, "slopmax", b'0', data);
        tar.extend_from_slice(&[0; 1024]);
        gzip(&tar)
    }

    fn tar_entry(out: &mut Vec<u8>, path: &str, kind: u8, data: &[u8]) {
        let mut header = [0u8; 512];
        header[..path.len()].copy_from_slice(path.as_bytes());
        let size = format!("{:011o}\0", data.len());
        header[124..136].copy_from_slice(size.as_bytes());
        header[156] = kind;
        header[257..263].copy_from_slice(b"ustar\0");
        out.extend_from_slice(&header);
        out.extend_from_slice(data);
        out.resize(out.len().div_ceil(512) * 512, 0);
    }

    fn gzip(data: &[u8]) -> Vec<u8> {
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        encoder.write_all(data).unwrap();
        encoder.finish().unwrap()
    }

    #[test]
    fn the_binary_is_read_from_a_gzipped_tar_past_other_entries() {
        let mut tar = Vec::new();
        tar_entry(&mut tar, "README.md", b'0', &[b'r'; 700]);
        tar_entry(&mut tar, "dir/slopmax", b'5', b"");
        tar_entry(&mut tar, "dir/slopmax", b'0', b"\x7fELF binary");
        tar.extend_from_slice(&[0; 1024]);
        let archive = gzip(&tar);
        assert_eq!(
            from_tar_gz(&archive, "slopmax", 1 << 20).unwrap(),
            b"\x7fELF binary"
        );
        let missing = from_tar_gz(&archive, "other", 1 << 20).unwrap_err();
        assert_eq!(missing.to_string(), "the release archive holds no other");
        assert!(from_tar_gz(b"not gzip", "slopmax", 1 << 20).is_err());
        assert!(from_tar_gz(&gzip(&tar[..600]), "slopmax", 1 << 20).is_err());
    }

    /// A zip as release tooling writes it: deflated entries with their
    /// sizes in the local headers, then the directory.
    fn zip(files: &[(&str, &[u8], bool)]) -> Vec<u8> {
        let mut out = Vec::new();
        let mut directory = Vec::new();
        for (name, data, deflate) in files {
            let packed = if *deflate {
                let mut encoder =
                    flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::fast());
                encoder.write_all(data).unwrap();
                encoder.finish().unwrap()
            } else {
                data.to_vec()
            };
            let method: u16 = if *deflate { 8 } else { 0 };
            let offset = out.len() as u32;
            out.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
            out.extend_from_slice(&[20, 0, 0, 0]);
            out.extend_from_slice(&method.to_le_bytes());
            out.extend_from_slice(&[0; 8]);
            out.extend_from_slice(&(packed.len() as u32).to_le_bytes());
            out.extend_from_slice(&(data.len() as u32).to_le_bytes());
            out.extend_from_slice(&(name.len() as u16).to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(name.as_bytes());
            out.extend_from_slice(&packed);
            directory.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
            directory.extend_from_slice(&[20, 0, 20, 0, 0, 0]);
            directory.extend_from_slice(&method.to_le_bytes());
            directory.extend_from_slice(&[0; 8]);
            directory.extend_from_slice(&(packed.len() as u32).to_le_bytes());
            directory.extend_from_slice(&(data.len() as u32).to_le_bytes());
            directory.extend_from_slice(&(name.len() as u16).to_le_bytes());
            directory.extend_from_slice(&[0; 12]);
            directory.extend_from_slice(&offset.to_le_bytes());
            directory.extend_from_slice(name.as_bytes());
        }
        let start = out.len() as u32;
        out.extend_from_slice(&directory);
        out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
        out.extend_from_slice(&[0; 4]);
        out.extend_from_slice(&(files.len() as u16).to_le_bytes());
        out.extend_from_slice(&(files.len() as u16).to_le_bytes());
        out.extend_from_slice(&(directory.len() as u32).to_le_bytes());
        out.extend_from_slice(&start.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out
    }

    #[test]
    fn the_windows_binaries_are_read_from_a_zip() {
        let archive = zip(&[
            ("LICENSE", b"text", false),
            ("slopmax.exe", &[b'M'; 5000], true),
            ("slopmaxw.exe", b"MZ launcher", false),
        ]);
        let files = from_zip(&archive, &["slopmax.exe", "slopmaxw.exe"], 1 << 20).unwrap();
        assert_eq!(files.len(), 2);
        assert_eq!(files[0], ("slopmax.exe".to_owned(), vec![b'M'; 5000]));
        assert_eq!(files[1].1, b"MZ launcher");
        let missing = from_zip(&archive, &["slopmax.exe", "other.exe"], 1 << 20).unwrap_err();
        assert_eq!(
            missing.to_string(),
            "the release archive holds no other.exe"
        );
        assert!(from_zip(b"PK not really", &["slopmax.exe"], 1 << 20).is_err());
        assert!(from_zip(&archive, &["slopmax.exe"], 100).is_err());
    }
}
