//! Byte-level JSON scanning for surgical edits.
//!
//! Request bodies are forwarded byte-for-byte. Where slopmax must read or
//! change a value, these helpers locate it in place: re-serializing through
//! a JSON library would reorder keys and reformat numbers in the rest of the
//! body. Input must already be valid JSON (see [`is_valid`]).

use std::ops::Range;

/// One step of a path into a JSON document.
#[derive(Debug, Clone, Copy)]
pub enum Seg<'a> {
    Key(&'a str),
    Index(usize),
}

pub fn is_valid(body: &[u8]) -> bool {
    serde_json::from_slice::<serde::de::IgnoredAny>(body).is_ok()
}

/// Byte range of the value at `path`. Only what lies before the value is
/// scanned, so a key near the start of a large body is found quickly.
pub fn find(body: &[u8], path: &[Seg]) -> Option<Range<usize>> {
    let start = skip_ws(body, 0);
    if path.is_empty() {
        return Some(start..skip_value(body, start)?);
    }
    let mut range = start..start;
    for seg in path {
        range = match *seg {
            Seg::Key(key) => member(body, range.start, key)?,
            Seg::Index(index) => element(body, range.start, index)?,
        };
    }
    Some(range)
}

/// The string at `path`, decoded.
pub fn find_str(body: &[u8], path: &[Seg]) -> Option<String> {
    serde_json::from_slice(&body[find(body, path)?]).ok()
}

/// `body` with `range` replaced by `with`.
pub fn splice(body: &[u8], range: Range<usize>, with: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(body.len() + with.len());
    out.extend_from_slice(&body[..range.start]);
    out.extend_from_slice(with);
    out.extend_from_slice(&body[range.end..]);
    out
}

/// The value of the first member named `key` in the object at `object`.
fn member(body: &[u8], object: usize, key: &str) -> Option<Range<usize>> {
    if body.get(object) != Some(&b'{') {
        return None;
    }
    let mut pos = skip_ws(body, object + 1);
    if body.get(pos) == Some(&b'}') {
        return None;
    }
    loop {
        let key_end = skip_string(body, pos)?;
        let colon = skip_ws(body, key_end);
        (body.get(colon) == Some(&b':')).then_some(())?;
        let value_start = skip_ws(body, colon + 1);
        let value_end = skip_value(body, value_start)?;
        if key_is(body, pos..key_end, key) {
            return Some(value_start..value_end);
        }
        pos = skip_ws(body, value_end);
        match body.get(pos)? {
            b',' => pos = skip_ws(body, pos + 1),
            _ => return None,
        }
    }
}

/// The element at `index` in the array at `array`.
fn element(body: &[u8], array: usize, index: usize) -> Option<Range<usize>> {
    if body.get(array) != Some(&b'[') {
        return None;
    }
    let mut pos = skip_ws(body, array + 1);
    if body.get(pos) == Some(&b']') {
        return None;
    }
    for i in 0.. {
        let end = skip_value(body, pos)?;
        if i == index {
            return Some(pos..end);
        }
        pos = skip_ws(body, end);
        match body.get(pos)? {
            b',' => pos = skip_ws(body, pos + 1),
            _ => return None,
        }
    }
    None
}

/// Compares a raw key (with quotes) to `key` without allocating.
fn key_is(body: &[u8], raw: Range<usize>, key: &str) -> bool {
    let inner = &body[raw.start + 1..raw.end - 1];
    inner == key.as_bytes()
}

fn skip_ws(body: &[u8], mut pos: usize) -> usize {
    while matches!(body.get(pos), Some(b' ' | b'\t' | b'\r' | b'\n')) {
        pos += 1;
    }
    pos
}

/// Strings are most of a conversation, so their ends are found with SIMD
/// search rather than byte by byte.
fn skip_string(body: &[u8], pos: usize) -> Option<usize> {
    (body.get(pos) == Some(&b'"')).then_some(())?;
    let mut i = pos + 1;
    loop {
        i += memchr::memchr2(b'"', b'\\', body.get(i..)?)?;
        if body[i] == b'"' {
            return Some(i + 1);
        }
        i += 2;
    }
}

fn skip_value(body: &[u8], pos: usize) -> Option<usize> {
    match body.get(pos)? {
        b'"' => skip_string(body, pos),
        b'{' | b'[' => {
            let mut depth = 0usize;
            let mut i = pos;
            while i < body.len() {
                match body[i] {
                    b'"' => {
                        i = skip_string(body, i)?;
                        continue;
                    }
                    b'{' | b'[' => depth += 1,
                    b'}' | b']' => {
                        depth -= 1;
                        if depth == 0 {
                            return Some(i + 1);
                        }
                    }
                    _ => {}
                }
                i += 1;
            }
            None
        }
        _ => {
            let end = body[pos..]
                .iter()
                .position(|b| matches!(b, b',' | b'}' | b']' | b' ' | b'\t' | b'\r' | b'\n'))
                .map_or(body.len(), |n| pos + n);
            (end > pos).then_some(end)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_nested_values() {
        let body = br#"{"a":{"b":[10,{"c":"x\"y"}]},"d":true}"#;
        let r = find(
            body,
            &[Seg::Key("a"), Seg::Key("b"), Seg::Index(1), Seg::Key("c")],
        )
        .unwrap();
        assert_eq!(&body[r], br#""x\"y""#);
        assert_eq!(
            find_str(
                body,
                &[Seg::Key("a"), Seg::Key("b"), Seg::Index(1), Seg::Key("c")]
            )
            .unwrap(),
            "x\"y"
        );
        assert_eq!(&body[find(body, &[Seg::Key("d")]).unwrap()], b"true");
        assert!(find(body, &[Seg::Key("missing")]).is_none());
        assert!(find(body, &[Seg::Key("a"), Seg::Key("b"), Seg::Index(9)]).is_none());
    }

    #[test]
    fn strings_end_only_at_unescaped_quotes() {
        let body = br#"{"a":"x\\\"y\\","b":[1,"]",{"c":"}"}],"model":"m","model":"later"}"#;
        assert_eq!(&body[find(body, &[Seg::Key("model")]).unwrap()], br#""m""#);
        let c = find(body, &[Seg::Key("b"), Seg::Index(2), Seg::Key("c")]).unwrap();
        assert_eq!(&body[c], br#""}""#);
        assert!(find(br#"{"a":"open\"}"#, &[Seg::Key("b")]).is_none());
        assert!(find(br#"{"a":"x\"#, &[Seg::Key("a")]).is_none());
        assert!(find(br#"{"a":"x\\"#, &[Seg::Key("a")]).is_none());
    }

    #[test]
    fn splice_replaces_in_place() {
        let body = br#"{"model":"a","keep":1}"#;
        let r = find(body, &[Seg::Key("model")]).unwrap();
        assert_eq!(splice(body, r, br#""bb""#), br#"{"model":"bb","keep":1}"#);
    }
}
