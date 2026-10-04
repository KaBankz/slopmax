//! Byte-level JSON scanning for surgical edits.
//!
//! Request bodies are forwarded byte-for-byte except for the few values
//! slopmax must change. Re-serializing through a JSON library would reorder
//! keys and reformat numbers, changing bytes that Anthropic's request
//! checksum covers, so these helpers locate and splice values in place.
//! Input must already be valid JSON (see [`is_valid`]).

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

/// The view of a Messages body that Claude Code's billing checksum hashes:
/// every `"model"` string value emptied, and the dispatch-only members
/// `max_tokens`, `fallbacks`, and `fallback_credit_token` dropped, at any
/// depth. Comma handling reproduces the native client exactly, including
/// its quirk of keeping the preceding comma when an object ends with two or
/// more dropped members.
pub fn checksum_view(body: &[u8]) -> Option<Vec<u8>> {
    let mut edits = Vec::new();
    let start = skip_ws(body, 0);
    let end = view_value(body, start, true, &mut edits)?;
    (skip_ws(body, end) == body.len()).then_some(())?;
    edits.sort_by_key(|r: &Range<usize>| r.start);
    let mut out = Vec::with_capacity(body.len());
    let mut last = 0;
    for edit in edits {
        (edit.start >= last).then_some(())?;
        out.extend_from_slice(&body[last..edit.start]);
        last = edit.end;
    }
    out.extend_from_slice(&body[last..]);
    Some(out)
}

const DROPPED_KEYS: [&str; 3] = ["max_tokens", "fallbacks", "fallback_credit_token"];

struct Member {
    span: Range<usize>,
    comma_before: Option<usize>,
    comma_after: Option<usize>,
    dropped: bool,
}

fn view_value(
    body: &[u8],
    pos: usize,
    collect: bool,
    edits: &mut Vec<Range<usize>>,
) -> Option<usize> {
    match body.get(pos)? {
        b'{' => view_object(body, pos, collect, edits),
        b'[' => {
            let mut i = skip_ws(body, pos + 1);
            if body.get(i) == Some(&b']') {
                return Some(i + 1);
            }
            loop {
                i = skip_ws(body, view_value(body, i, collect, edits)?);
                match body.get(i)? {
                    b',' => i = skip_ws(body, i + 1),
                    b']' => return Some(i + 1),
                    _ => return None,
                }
            }
        }
        _ => skip_value(body, pos),
    }
}

fn view_object(
    body: &[u8],
    pos: usize,
    collect: bool,
    edits: &mut Vec<Range<usize>>,
) -> Option<usize> {
    let mut i = skip_ws(body, pos + 1);
    if body.get(i) == Some(&b'}') {
        return Some(i + 1);
    }
    let mut members: Vec<Member> = Vec::new();
    let mut comma_before = None;
    let end = loop {
        let start = i;
        let key_end = skip_string(body, i)?;
        let colon = skip_ws(body, key_end);
        (body.get(colon) == Some(&b':')).then_some(())?;
        let value = skip_ws(body, colon + 1);
        let key = start..key_end;
        let dropped = collect && DROPPED_KEYS.iter().any(|k| key_is(body, key.clone(), k));
        let value_end = if collect && key_is(body, key, "model") && body.get(value) == Some(&b'"') {
            let value_end = skip_string(body, value)?;
            push_edit(edits, value + 1..value_end - 1);
            value_end
        } else {
            view_value(body, value, collect && !dropped, edits)?
        };
        i = skip_ws(body, value_end);
        let comma_after = (body.get(i) == Some(&b',')).then_some(i);
        members.push(Member {
            span: start..value_end,
            comma_before,
            comma_after,
            dropped,
        });
        match comma_after {
            Some(comma) => {
                comma_before = Some(comma);
                i = skip_ws(body, comma + 1);
            }
            None if body.get(i) == Some(&b'}') => break i + 1,
            None => return None,
        }
    };
    if collect {
        drop_members(&members, edits);
    }
    Some(end)
}

fn drop_members(members: &[Member], edits: &mut Vec<Range<usize>>) {
    let mut start = 0;
    while start < members.len() {
        if !members[start].dropped {
            start += 1;
            continue;
        }
        let mut end = start;
        while end + 1 < members.len() && members[end + 1].dropped {
            end += 1;
        }
        let (first, last) = (&members[start], &members[end]);
        let range = if end + 1 < members.len() {
            first.span.start..last.comma_after.map_or(last.span.end, |c| c + 1)
        } else if start > 0 && end > start {
            first.span.start..last.span.end
        } else if start > 0 {
            first.comma_before.unwrap_or(first.span.start)..last.span.end
        } else {
            first.span.start..last.span.end
        };
        push_edit(edits, range);
        start = end + 1;
    }
}

fn push_edit(edits: &mut Vec<Range<usize>>, range: Range<usize>) {
    if range.start < range.end {
        edits.push(range);
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

    #[test]
    fn checksum_view_matches_native_normalization() {
        // Vectors from CLIProxyAPI, which reproduces Claude Code 2.1.220.
        let cases = [
            (r#"{"model":"claude","keep":1}"#, r#"{"model":"","keep":1}"#),
            (r#"{"max_tokens":1,"keep":2}"#, r#"{"keep":2}"#),
            (
                r#"{"keep":1,"fallbacks":[{"model":"x"}],"tail":2}"#,
                r#"{"keep":1,"tail":2}"#,
            ),
            (
                r#"{"keep":1,"fallback_credit_token":"secret"}"#,
                r#"{"keep":1}"#,
            ),
            (
                r#"{"max_tokens":1,"fallbacks":[],"fallback_credit_token":"secret"}"#,
                r#"{}"#,
            ),
            (
                r#"{"keep":1,"max_tokens":1,"fallbacks":[],"tail":2}"#,
                r#"{"keep":1,"tail":2}"#,
            ),
            (
                r#"{"keep":1,"max_tokens":1,"fallbacks":[]}"#,
                r#"{"keep":1,}"#,
            ),
            (
                r#"{"outer":{"model":"x","max_tokens":1,"keep":"y"}}"#,
                r#"{"outer":{"model":"","keep":"y"}}"#,
            ),
            (
                r#"{"text":"literal \"model\":\"x\" and \"max_tokens\":1"}"#,
                r#"{"text":"literal \"model\":\"x\" and \"max_tokens\":1"}"#,
            ),
        ];
        for (input, want) in cases {
            let got = checksum_view(input.as_bytes()).unwrap();
            assert_eq!(String::from_utf8(got).unwrap(), want, "input: {input}");
        }
    }
}
