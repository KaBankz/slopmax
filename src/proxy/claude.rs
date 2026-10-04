//! Claude upstream adaptation.
//!
//! Requests from Claude Code are forwarded as-is except for what an OAuth
//! account needs: its bearer token and the OAuth beta flag, its own stable
//! identity in `metadata.user_id`, and the billing-header checksum (`cch`)
//! that Claude Code omits whenever `ANTHROPIC_BASE_URL` points elsewhere.

use http::{HeaderMap, HeaderName, HeaderValue};
use xxhash_rust::xxh64::xxh64;

use super::rawjson::{self, Seg};
use crate::account::Account;
use crate::auth::claude::OAUTH_BETA;
use crate::ids;

const CLAUDE_CODE_BETA: &str = "claude-code-20250219";
const BILLING_PREFIX: &str = "x-anthropic-billing-header:";
const CHECKSUM_SEED: u64 = 0x4D65_9218_E32A_3268;
const PLACEHOLDER: &str = "00000";

/// The conversation id Claude Code sends, used for session affinity.
pub fn session_id(headers: &HeaderMap, body: &[u8]) -> Option<String> {
    if let Some(id) = headers
        .get("x-claude-code-session-id")
        .and_then(|v| v.to_str().ok())
    {
        return Some(id.to_owned());
    }
    let user_id = rawjson::find_str(body, &[Seg::Key("metadata"), Seg::Key("user_id")])?;
    let inner = user_id.as_bytes();
    rawjson::find_str(inner, &[Seg::Key("session_id")]).or_else(|| {
        // Legacy form: user_<hash>_account_<uuid>_session_<uuid>.
        user_id.rsplit_once("_session_").map(|(_, s)| s.to_owned())
    })
}

/// Applies the account's identity and signs the billing header. Returns the
/// body unchanged when it is not a Messages request.
pub fn prepare_body(body: &[u8], account: &Account, session: Option<&str>) -> Vec<u8> {
    if !rawjson::is_valid(body) {
        return body.to_vec();
    }
    let device = account.device_id.as_deref().unwrap_or_default();
    let account_uuid = account.account_id.as_deref().unwrap_or_default();
    let body = with_identity(body, device, account_uuid, session).unwrap_or_else(|| body.to_vec());
    sign(&body).unwrap_or(body)
}

/// Rewrites `metadata.user_id` to present `device_id` and `account_uuid`,
/// keeping the session id and any extra fields in their original order.
fn with_identity(
    body: &[u8],
    device_id: &str,
    account_uuid: &str,
    session: Option<&str>,
) -> Option<Vec<u8>> {
    if device_id.is_empty() {
        return None;
    }
    let range = rawjson::find(body, &[Seg::Key("metadata"), Seg::Key("user_id")])?;
    let existing: String = serde_json::from_slice(&body[range.clone()]).ok()?;
    let inner = existing.as_bytes();
    let fields = rawjson::is_valid(inner)
        .then(|| rawjson::members(inner, 0..inner.len()))
        .flatten()
        .unwrap_or_default();

    let field = |name: &str| {
        fields
            .iter()
            .find(|(k, _)| &inner[k.start + 1..k.end - 1] == name.as_bytes())
            .and_then(|(_, v)| serde_json::from_slice::<String>(&inner[v.clone()]).ok())
    };
    let session = field("session_id").or_else(|| session.map(str::to_owned))?;
    let account_uuid = if account_uuid.is_empty() {
        field("account_uuid").unwrap_or_default()
    } else {
        account_uuid.to_owned()
    };

    let quote = |s: &str| serde_json::to_string(s).expect("strings serialize");
    let mut rebuilt = format!(
        "{{\"device_id\":{},\"account_uuid\":{},\"session_id\":{}",
        quote(device_id),
        quote(&account_uuid),
        quote(&session)
    );
    for (key, value) in &fields {
        let name = &inner[key.start + 1..key.end - 1];
        if ![&b"device_id"[..], b"account_uuid", b"session_id"].contains(&name) {
            rebuilt.push(',');
            rebuilt.push_str(std::str::from_utf8(&inner[key.clone()]).ok()?);
            rebuilt.push(':');
            rebuilt.push_str(std::str::from_utf8(&inner[value.clone()]).ok()?);
        }
    }
    rebuilt.push('}');
    Some(rawjson::splice(body, range, quote(&rebuilt).as_bytes()))
}

/// Restores the `cch=` checksum in the billing header and computes it, the
/// way Claude Code does against first-party Anthropic: xxHash64 over the
/// body with the digits zeroed and dispatch-only fields normalized away.
pub fn sign(body: &[u8]) -> Option<Vec<u8>> {
    let path = [Seg::Key("system"), Seg::Index(0), Seg::Key("text")];
    let range = rawjson::find(body, &path)?;
    let billing: String = serde_json::from_slice(&body[range.clone()]).ok()?;
    if !billing.starts_with(BILLING_PREFIX) {
        return None;
    }
    let mut out = match checksum_offset(&body[range.clone()]) {
        Some(_) => body.to_vec(),
        None => {
            let text = with_placeholder(&billing)?;
            let encoded = serde_json::to_string(&text).ok()?;
            rawjson::splice(body, range, encoded.as_bytes())
        }
    };
    let range = rawjson::find(&out, &path)?;
    let offset = range.start + checksum_offset(&out[range])?;
    let digits = offset..offset + PLACEHOLDER.len();
    out[digits.clone()].copy_from_slice(PLACEHOLDER.as_bytes());
    let view = rawjson::checksum_view(&out)?;
    let checksum = format!("{:05x}", xxh64(&view, CHECKSUM_SEED) & 0xF_FFFF);
    out[digits].copy_from_slice(checksum.as_bytes());
    Some(out)
}

/// Offset of the five checksum digits within a raw billing string.
fn checksum_offset(raw: &[u8]) -> Option<usize> {
    let mut from = 0;
    while let Some(found) = raw[from..].windows(4).position(|w| w == b"cch=") {
        let digits = from + found + 4;
        let end = digits + PLACEHOLDER.len();
        let hex = raw.get(digits..end)?;
        if raw.get(end) == Some(&b';') && hex.iter().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'))
        {
            return Some(digits);
        }
        from = digits;
    }
    None
}

/// Inserts ` cch=00000;` right after the `cc_entrypoint=…;` segment.
fn with_placeholder(billing: &str) -> Option<String> {
    let entry = billing.find("cc_entrypoint=")?;
    let at = entry + billing[entry..].find(';')? + 1;
    Some(format!(
        "{} cch={PLACEHOLDER};{}",
        &billing[..at],
        &billing[at..]
    ))
}

/// Inserts the OAuth beta flag, after `claude-code-20250219` where present,
/// the way an OAuth-authenticated Claude Code orders it.
pub fn with_oauth_beta(existing: Option<&str>) -> String {
    let betas: Vec<&str> = existing
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|b| !b.is_empty())
        .collect();
    if betas.contains(&OAUTH_BETA) {
        return betas.join(",");
    }
    let at = betas
        .iter()
        .position(|b| *b == CLAUDE_CODE_BETA)
        .map_or(0, |i| i + 1);
    let mut out = betas;
    out.insert(at, OAUTH_BETA);
    out.join(",")
}

/// Headers for the upstream request: the agent's own headers minus its
/// proxy credential, plus the account's token.
pub fn upstream_headers(client: &HeaderMap, access_token: &str) -> HeaderMap {
    let mut headers = super::forwardable(client);
    headers.remove("x-api-key");
    let beta = with_oauth_beta(client.get("anthropic-beta").and_then(|v| v.to_str().ok()));
    insert(&mut headers, "anthropic-beta", &beta);
    insert(
        &mut headers,
        "authorization",
        &format!("Bearer {access_token}"),
    );
    if !headers.contains_key("x-client-request-id") {
        insert(&mut headers, "x-client-request-id", &ids::uuid_v4());
    }
    headers
}

fn insert(headers: &mut HeaderMap, name: &'static str, value: &str) {
    if let Ok(value) = HeaderValue::from_str(value) {
        headers.insert(HeaderName::from_static(name), value);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::account::{Provider, Tokens};

    const BASE: &str = r#"{"model":"model-a","messages":[{"role":"user","content":[{"type":"text","text":"x"}]}],"system":[{"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.220.test; cc_entrypoint=sdk-cli; cch=00000;"},{"type":"text","text":"system-x"}],"tools":[],"metadata":{"user_id":"meta-x"},"max_tokens":1,"thinking":{"type":"adaptive","display":"omitted"},"context_management":{"edits":[{"type":"clear_thinking_20251015","keep":"all"}]},"output_config":{"effort":"high"},"stream":true}"#;

    fn checksum(body: &str) -> String {
        let signed = sign(body.as_bytes()).expect("signs");
        let text = rawjson::find_str(
            &signed,
            &[Seg::Key("system"), Seg::Index(0), Seg::Key("text")],
        )
        .unwrap();
        let at = text.find("cch=").unwrap() + 4;
        text[at..at + 5].to_owned()
    }

    #[test]
    fn checksum_matches_claude_code_vectors() {
        // Known vectors from CLIProxyAPI, captured from Claude Code 2.1.220.
        let replace = |from: &str, to: &str| BASE.replacen(from, to, 1);
        let cases = [
            (BASE.to_owned(), "7ee87"),
            (replace(r#""model":"model-a""#, r#""model":"model-b""#), "7ee87"),
            (replace(r#""max_tokens":1"#, r#""max_tokens":2"#), "7ee87"),
            (replace(r#""text":"x""#, r#""text":"y""#), "b9cc8"),
            (replace(r#""system-x""#, r#""system-y""#), "a30d3"),
            (replace(r#""user_id":"meta-x""#, r#""user_id":"meta-y""#), "7a89d"),
            (replace(r#""thinking":{"type":"adaptive","display":"omitted"}"#, r#""thinking":{"type":"disabled"}"#), "7205c"),
            (replace(r#""effort":"high""#, r#""effort":"low""#), "12366"),
            (replace(r#""stream":true"#, r#""stream":false"#), "60400"),
            (replace(r#""stream":true}"#, r#""stream":true,"extra_top":"extra"}"#), "2d622"),
            (replace(r#""stream":true}"#, r#""stream":true,"fallbacks":[{"model":"fallback-a"}]}"#), "7ee87"),
            (replace(r#""metadata":{"user_id":"meta-x"}"#, r#""metadata":{"user_id":"meta-x","model":"a"}"#), "0601b"),
            (replace(r#""metadata":{"user_id":"meta-x"}"#, r#""metadata":{"user_id":"meta-x","max_tokens":2}"#), "7ee87"),
            (
                replace(r#""metadata":{"user_id":"meta-x"}"#, r#""metadata":{"user_id":"meta-x","max_tokens":999,"fallbacks":[{"model":"fallback-model"}]}"#),
                "4589b",
            ),
            (
                replace(r#""metadata":{"user_id":"meta-x"}"#, r#""metadata":{"user_id":"meta-x","max_tokens":999,"model":"nested-model","fallbacks":[{"model":"fallback-model"}]}"#),
                "0601b",
            ),
            (r#"{"system":[{"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.220.test; cc_entrypoint=sdk-cli; cch=00000;"}]}"#.to_owned(), "f2edb"),
        ];
        for (body, want) in cases {
            assert_eq!(checksum(&body), want, "body: {body}");
        }
    }

    #[test]
    fn missing_checksum_is_inserted_after_entrypoint() {
        let unsigned = BASE.replacen(" cch=00000;", "", 1);
        let signed = sign(unsigned.as_bytes()).unwrap();
        let text = rawjson::find_str(
            &signed,
            &[Seg::Key("system"), Seg::Index(0), Seg::Key("text")],
        )
        .unwrap();
        assert!(text.contains("cc_entrypoint=sdk-cli; cch=7ee87;"), "{text}");
    }

    #[test]
    fn signing_changes_only_the_digits() {
        let body = BASE.replacen(
            r#""text":"x""#,
            r#""text":"keep literal cch=00000; here""#,
            1,
        );
        let signed = sign(body.as_bytes()).unwrap();
        assert_eq!(signed.len(), body.len());
        let differing = signed
            .iter()
            .zip(body.as_bytes())
            .filter(|(a, b)| a != b)
            .count();
        assert!(differing <= 5);
    }

    #[test]
    fn bodies_without_billing_header_are_untouched() {
        assert!(sign(br#"{"system":"plain"}"#).is_none());
        assert!(sign(br#"{"messages":[]}"#).is_none());
    }

    fn claude_account() -> Account {
        let mut account = Account::new(Provider::Claude, Tokens::default());
        account.device_id = Some("d".repeat(64));
        account.account_id = Some("acct-uuid".into());
        account
    }

    #[test]
    fn identity_rewrite_matches_captured_claude_code_shape() {
        // The shape Claude Code 2.1.287 sends through ANTHROPIC_BASE_URL.
        let body = r#"{"model":"claude-opus-5-5","metadata":{"user_id":"{\"device_id\":\"c46a\",\"account_uuid\":\"\",\"session_id\":\"e2f7\",\"extra\":1}"},"system":[{"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.287.95e; cc_entrypoint=sdk-cli;"}],"messages":[]}"#;
        let out = prepare_body(body.as_bytes(), &claude_account(), Some("header-session"));
        let user_id =
            rawjson::find_str(&out, &[Seg::Key("metadata"), Seg::Key("user_id")]).unwrap();
        assert_eq!(
            user_id,
            format!(
                r#"{{"device_id":"{}","account_uuid":"acct-uuid","session_id":"e2f7","extra":1}}"#,
                "d".repeat(64)
            )
        );
        let billing =
            rawjson::find_str(&out, &[Seg::Key("system"), Seg::Index(0), Seg::Key("text")])
                .unwrap();
        assert!(billing.starts_with(
            "x-anthropic-billing-header: cc_version=2.1.287.95e; cc_entrypoint=sdk-cli; cch="
        ));
        assert!(rawjson::is_valid(&out));
    }

    #[test]
    fn session_id_comes_from_header_then_metadata() {
        let mut headers = HeaderMap::new();
        let body = br#"{"metadata":{"user_id":"{\"session_id\":\"from-body\"}"}}"#;
        assert_eq!(session_id(&headers, body).as_deref(), Some("from-body"));
        headers.insert(
            "x-claude-code-session-id",
            HeaderValue::from_static("from-header"),
        );
        assert_eq!(session_id(&headers, body).as_deref(), Some("from-header"));
        let legacy = br#"{"metadata":{"user_id":"user_abc_account_def_session_s-1"}}"#;
        assert_eq!(
            session_id(&HeaderMap::new(), legacy).as_deref(),
            Some("s-1")
        );
    }

    #[test]
    fn oauth_beta_follows_claude_code_beta() {
        assert_eq!(
            with_oauth_beta(Some("claude-code-20250219,interleaved-thinking-2025-05-14")),
            "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14"
        );
        assert_eq!(with_oauth_beta(Some("a,b")), "oauth-2025-04-20,a,b");
        assert_eq!(with_oauth_beta(None), "oauth-2025-04-20");
        assert_eq!(
            with_oauth_beta(Some("oauth-2025-04-20,x")),
            "oauth-2025-04-20,x"
        );
    }
}
