//! Random identifiers and digests.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ring::digest::{self, SHA256};
use ring::rand::{SecureRandom, SystemRandom};

/// `N` random bytes from the operating system.
pub fn random<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    SystemRandom::new()
        .fill(&mut bytes)
        .expect("operating system RNG is unavailable");
    bytes
}

/// SHA-256 of `data`.
pub fn sha256(data: &[u8]) -> [u8; 32] {
    digest::digest(&SHA256, data)
        .as_ref()
        .try_into()
        .expect("SHA-256 digests are 32 bytes")
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// 32 random bytes, base64url-encoded without padding (43 characters).
pub fn token() -> String {
    URL_SAFE_NO_PAD.encode(random::<32>())
}

/// 32 random bytes as lowercase hex (64 characters).
pub fn hex64() -> String {
    hex(&random::<32>())
}

/// A random RFC 4122 version 4 UUID.
pub fn uuid_v4() -> String {
    let mut b = random::<16>();
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h = hex(&b);
    format!(
        "{}-{}-{}-{}-{}",
        &h[..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..]
    )
}

/// Whether `id` is a UUID in its usual hyphenated form.
pub fn is_uuid(id: &str) -> bool {
    id.len() == 36
        && id.char_indices().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => c == '-',
            _ => c.is_ascii_hexdigit(),
        })
}

/// The id a redemption is sent with: the caller's own when it is a UUID, so
/// a caller asking again is answered as before, else a fresh one.
pub fn request_id(asked: Option<&str>) -> String {
    asked
        .filter(|id| is_uuid(id))
        .map_or_else(uuid_v4, str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shapes() {
        assert_eq!(token().len(), 43);
        assert_eq!(hex64().len(), 64);
        let id = uuid_v4();
        assert_eq!(id.len(), 36);
        assert_eq!(id.as_bytes()[14], b'4');
        assert!(matches!(id.as_bytes()[19], b'8' | b'9' | b'a' | b'b'));
        assert_ne!(uuid_v4(), uuid_v4());
        assert!(is_uuid(&id));
        assert!(is_uuid("0b4e1f5a-9c2d-4e8f-a1b3-c5d7e9f0a2b4"));
        assert!(!is_uuid("org-claude0"));
        assert!(!is_uuid("../../v1/messages?x=0b4e1f5a-9c2d-4e8f-a1"));
        assert!(!is_uuid("0b4e1f5a-9c2d-4e8f-a1b3-c5d7e9f0a2b4/x"));
    }

    #[test]
    fn a_callers_request_id_is_kept_when_it_is_a_uuid() {
        let asked = "0b1c2d3e-0000-5000-8000-000000000000";
        assert_eq!(request_id(Some(asked)), asked);
        assert_ne!(request_id(Some("retry-1")), "retry-1");
        assert!(is_uuid(&request_id(None)));
    }
}
