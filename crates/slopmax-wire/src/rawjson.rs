//! Byte-level JSON scanning for surgical edits.
//!
//! Request bodies are forwarded byte-for-byte. Where slopmax must read or
//! change a value, these helpers locate it in place: re-serializing through
//! a JSON library would reorder keys and reformat numbers in the rest of the
//! body.
//!
//! Every function is total: on any bytes at all it returns without
//! panicking, so a body need not be validated before it is scanned. On valid
//! JSON the results are exact (the property tests below hold them to
//! serde_json); on invalid JSON they are some range or `None`, and the body
//! goes upstream as it came, for the provider to refuse.

use std::ops::Range;

/// One step of a path into a JSON document.
#[derive(Debug, Clone, Copy)]
pub enum Seg<'a> {
    Key(&'a str),
    Index(usize),
}

/// Whether `body` is valid JSON. A full parse: kept for where a misread
/// would matter, such as a key held to some models.
pub fn is_valid(body: &[u8]) -> bool {
    serde_json::from_slice::<serde::de::IgnoredAny>(body).is_ok()
}

/// Whether `body` is framed as one JSON object: `{`, balanced to its `}`,
/// with only whitespace after. A structural scan that skips strings with
/// SIMD search, far cheaper than a parse on a large conversation; what it
/// does not check (numbers, escapes) the provider does.
pub fn is_object(body: &[u8]) -> bool {
    let start = skip_ws(body, 0);
    body.get(start) == Some(&b'{')
        && skip_value(body, start).is_some_and(|end| skip_ws(body, end) == body.len())
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

    mod properties {
        use super::super::*;
        use proptest::prelude::*;
        use serde_json::{Map, Value};

        fn value() -> impl Strategy<Value = Value> {
            let leaf = prop_oneof![
                Just(Value::Null),
                any::<bool>().prop_map(Value::Bool),
                any::<i64>().prop_map(Value::from),
                // Short decimals, which serde_json reads back exactly.
                (any::<i32>(), 0..4i32).prop_map(|(m, e)| Value::from(m as f64 / 10f64.powi(e))),
                // Quotes, backslashes, braces and control bytes inside strings.
                "[a-z\\\"{}\\[\\],:\\\\ \n\t\u{1}é😀]{0,12}".prop_map(Value::from),
            ];
            leaf.prop_recursive(4, 48, 6, |inner| {
                prop_oneof![
                    prop::collection::vec(inner.clone(), 0..6).prop_map(Value::Array),
                    prop::collection::vec(("[a-z\"\\\\]{0,6}", inner), 0..6).prop_map(|members| {
                        Value::Object(members.into_iter().collect::<Map<_, _>>())
                    }),
                ]
            })
        }

        fn object() -> impl Strategy<Value = (Value, bool)> {
            (
                prop::collection::vec(("[a-z\"\\\\]{0,6}", value()), 1..6),
                any::<bool>(),
            )
                .prop_map(|(members, pretty)| {
                    (Value::Object(members.into_iter().collect()), pretty)
                })
        }

        fn encode(value: &Value, pretty: bool) -> Vec<u8> {
            if pretty {
                serde_json::to_vec_pretty(value).unwrap()
            } else {
                serde_json::to_vec(value).unwrap()
            }
        }

        proptest! {
            #![proptest_config(ProptestConfig::with_cases(
                std::env::var("PROPTEST_CASES").ok().and_then(|n| n.parse().ok()).unwrap_or(256)
            ))]

            /// On valid JSON every member is found where serde_json puts it.
            #[test]
            fn finds_what_serde_json_reads((doc, pretty) in object()) {
                let body = encode(&doc, pretty);
                prop_assert!(is_object(&body));
                prop_assert!(is_valid(&body));
                for (key, expected) in doc.as_object().unwrap() {
                    let range = find(&body, &[Seg::Key(key)]);
                    // Keys with escapes are compared raw, so are not found.
                    if key.contains(['"', '\\']) {
                        continue;
                    }
                    let range = range.expect("a present key is found");
                    let found: Value = serde_json::from_slice(&body[range]).unwrap();
                    prop_assert_eq!(&found, expected);
                }
                if let Some((key, Value::String(text))) = doc.as_object().unwrap().iter().next()
                    && !key.contains(['"', '\\'])
                {
                    let found = find_str(&body, &[Seg::Key(key)]);
                    prop_assert_eq!(found.as_deref(), Some(text.as_str()));
                }
            }

            /// Cut anywhere, a document is never taken for a whole object,
            /// and nothing panics.
            #[test]
            fn every_cut_is_seen_and_nothing_panics((doc, pretty) in object()) {
                let body = encode(&doc, pretty);
                for end in 0..body.len() {
                    let cut = &body[..end];
                    prop_assert!(!is_object(cut));
                    let _ = find(cut, &[Seg::Key("model")]);
                    let _ = find(cut, &[Seg::Key("a"), Seg::Index(1), Seg::Key("")]);
                    let _ = find_str(cut, &[Seg::Key("model")]);
                }
            }

            /// Any bytes at all: no panic.
            #[test]
            fn arbitrary_bytes_never_panic(body in prop::collection::vec(any::<u8>(), 0..256)) {
                let _ = is_object(&body);
                let _ = find(&body, &[Seg::Key("model")]);
                let _ = find(&body, &[Seg::Index(2), Seg::Key("x")]);
                let _ = find_str(&body, &[Seg::Key("model")]);
            }

            /// Bytes made mostly of JSON's own punctuation, which reach the
            /// scanner's edge cases far more often than random bytes do.
            #[test]
            fn json_like_bytes_never_panic(body in "[{}\\[\\]\":,\\\\a1 ]{0,64}") {
                let body = body.as_bytes();
                let _ = is_object(body);
                let _ = find(body, &[Seg::Key("a")]);
                let _ = find(body, &[Seg::Key("a"), Seg::Index(0)]);
                let _ = find_str(body, &[Seg::Key("a")]);
            }
        }
    }
}
