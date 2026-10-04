//! `application/x-www-form-urlencoded`, as used by OAuth query strings and
//! token requests: the WHATWG serializer and parser.

/// Encodes `pairs` as `key=value&…`. Alphanumerics and `*-._` pass through,
/// a space becomes `+`, and every other byte is percent-encoded.
pub fn encode<'a>(pairs: impl IntoIterator<Item = (&'a str, &'a str)>) -> String {
    let mut out = String::new();
    for (key, value) in pairs {
        if !out.is_empty() {
            out.push('&');
        }
        encode_into(&mut out, key);
        out.push('=');
        encode_into(&mut out, value);
    }
    out
}

fn encode_into(out: &mut String, text: &str) {
    for &byte in text.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'*' | b'-' | b'.' | b'_' => {
                out.push(char::from(byte));
            }
            b' ' => out.push('+'),
            _ => {
                const HEX: &[u8; 16] = b"0123456789ABCDEF";
                out.push('%');
                out.push(char::from(HEX[usize::from(byte >> 4)]));
                out.push(char::from(HEX[usize::from(byte & 0xF)]));
            }
        }
    }
}

/// Decodes `key=value&…`. `+` is a space; malformed escapes are kept as
/// written, and invalid UTF-8 is replaced.
pub fn decode(query: &str) -> Vec<(String, String)> {
    query
        .split('&')
        .filter(|pair| !pair.is_empty())
        .map(|pair| {
            let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
            (decode_part(key), decode_part(value))
        })
        .collect()
}

/// Decodes `%XX` escapes (but not `+`), as in a URL's userinfo.
pub fn percent_decode(text: &str) -> String {
    unescape(text, false)
}

fn decode_part(text: &str) -> String {
    unescape(text, true)
}

fn unescape(text: &str, plus_is_space: bool) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' if plus_is_space => out.push(b' '),
            b'%' => match (
                bytes.get(i + 1).and_then(hex),
                bytes.get(i + 2).and_then(hex),
            ) {
                (Some(high), Some(low)) => {
                    out.push(high << 4 | low);
                    i += 2;
                }
                _ => out.push(b'%'),
            },
            byte => out.push(byte),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex(byte: &u8) -> Option<u8> {
    char::from(*byte).to_digit(16).map(|d| d as u8)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_like_the_whatwg_serializer() {
        assert_eq!(
            encode([
                ("scope", "user:profile user:inference"),
                ("redirect_uri", "http://localhost:1455/auth/callback")
            ]),
            "scope=user%3Aprofile+user%3Ainference&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback"
        );
        assert_eq!(encode([("a*-._~", "é")]), "a*-._%7E=%C3%A9");
        assert_eq!(encode([]), "");
    }

    #[test]
    fn decodes_pairs_and_tolerates_malformed_escapes() {
        assert_eq!(
            decode("code=ab%2Fc+d&state=s&&flag"),
            [
                ("code".to_owned(), "ab/c d".to_owned()),
                ("state".to_owned(), "s".to_owned()),
                ("flag".to_owned(), String::new()),
            ]
        );
        assert_eq!(decode("x=%zz%4"), [("x".to_owned(), "%zz%4".to_owned())]);
        assert_eq!(decode("x=%C3%A9"), [("x".to_owned(), "é".to_owned())]);
    }
}
