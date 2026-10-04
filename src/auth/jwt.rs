//! Unverified JWT payload decoding.
//!
//! Tokens come straight from the issuer over TLS, so slopmax only reads
//! claims for display and routing; it never trusts them for authorization.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::Value;

use crate::time::Timestamp;

/// Decodes the claims segment of a JWT, or `None` if it is not one.
pub fn claims(token: &str) -> Option<Value> {
    let payload = token.split('.').nth(1)?;
    let bytes = URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// The `exp` claim as a timestamp.
pub fn expiry(token: &str) -> Option<Timestamp> {
    let exp = claims(token)?.get("exp")?.as_i64()?;
    Timestamp::from_second(exp)
}

#[cfg(test)]
pub fn encode_unsigned(claims: &Value) -> String {
    let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"none","typ":"JWT"}"#);
    let body = URL_SAFE_NO_PAD.encode(claims.to_string());
    format!("{header}.{body}.sig")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn decodes_claims_and_expiry() {
        let token = encode_unsigned(&json!({ "email": "a@b.c", "exp": 1_900_000_000 }));
        assert_eq!(claims(&token).unwrap()["email"], "a@b.c");
        assert_eq!(expiry(&token).unwrap().as_second(), 1_900_000_000);
    }

    #[test]
    fn rejects_non_jwt() {
        assert!(claims("not-a-jwt").is_none());
        assert!(claims("a.!!!.c").is_none());
    }
}
