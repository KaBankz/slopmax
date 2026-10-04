//! Random identifiers.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;

fn random_bytes<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    getrandom::fill(&mut bytes).expect("operating system RNG is unavailable");
    bytes
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// 32 random bytes, base64url-encoded without padding (43 characters).
pub fn token() -> String {
    URL_SAFE_NO_PAD.encode(random_bytes::<32>())
}

/// 32 random bytes as lowercase hex (64 characters).
pub fn hex64() -> String {
    hex(&random_bytes::<32>())
}

/// A random RFC 4122 version 4 UUID.
pub fn uuid_v4() -> String {
    let mut b = random_bytes::<16>();
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
    }
}
