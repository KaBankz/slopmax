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

/// Byte range of the value at `path`.
pub fn find(body: &[u8], path: &[Seg]) -> Option<Range<usize>> {
    let start = skip_ws(body, 0);
    let mut range = start..skip_value(body, start)?;
    for seg in path {
        range = match *seg {
            Seg::Key(key) => members(body, range)?
                .into_iter()
                .find(|(k, _)| key_is(body, k.clone(), key))
                .map(|(_, v)| v)?,
            Seg::Index(index) => elements(body, range)?.into_iter().nth(index)?,
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

/// `(key, value)` ranges of an object's members, in document order. Key
/// ranges include the quotes.
pub fn members(body: &[u8], object: Range<usize>) -> Option<Vec<(Range<usize>, Range<usize>)>> {
    if body.get(object.start) != Some(&b'{') {
        return None;
    }
    let mut out = Vec::new();
    let mut pos = skip_ws(body, object.start + 1);
    if body.get(pos) == Some(&b'}') {
        return Some(out);
    }
    loop {
        let key_end = skip_string(body, pos)?;
        let colon = skip_ws(body, key_end);
        (body.get(colon) == Some(&b':')).then_some(())?;
        let value_start = skip_ws(body, colon + 1);
        let value_end = skip_value(body, value_start)?;
        out.push((pos..key_end, value_start..value_end));
        pos = skip_ws(body, value_end);
        match body.get(pos)? {
            b',' => pos = skip_ws(body, pos + 1),
            b'}' => return Some(out),
            _ => return None,
        }
    }
}

fn elements(body: &[u8], array: Range<usize>) -> Option<Vec<Range<usize>>> {
    if body.get(array.start) != Some(&b'[') {
        return None;
    }
    let mut out = Vec::new();
    let mut pos = skip_ws(body, array.start + 1);
    if body.get(pos) == Some(&b']') {
        return Some(out);
    }
    loop {
        let end = skip_value(body, pos)?;
        out.push(pos..end);
        pos = skip_ws(body, end);
        match body.get(pos)? {
            b',' => pos = skip_ws(body, pos + 1),
            b']' => return Some(out),
            _ => return None,
        }
    }
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

fn skip_string(body: &[u8], pos: usize) -> Option<usize> {
    (body.get(pos) == Some(&b'"')).then_some(())?;
    let mut i = pos + 1;
    while i < body.len() {
        match body[i] {
            b'\\' => i += 2,
            b'"' => return Some(i + 1),
            _ => i += 1,
        }
    }
    None
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
    fn splice_replaces_in_place() {
        let body = br#"{"model":"a","keep":1}"#;
        let r = find(body, &[Seg::Key("model")]).unwrap();
        assert_eq!(splice(body, r, br#""bb""#), br#"{"model":"bb","keep":1}"#);
    }
}
