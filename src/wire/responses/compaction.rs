//! Codex's remote compaction, for models that cannot do it themselves.
//!
//! Codex asks for compaction by ending a request's input with a
//! `compaction_trigger` item and expects one `compaction` item back, whose
//! sealed content stands in for the history from then on. For a model
//! reached by translation, slopmax asks the model for a summary instead,
//! seals it in the item itself, and opens it again when the item comes
//! back.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;

/// Marks compaction content slopmax sealed.
const SEAL: &str = "slopmax1:";

/// What the model is asked to write when compacting.
pub const PROMPT: &str = "Summarize this conversation so that another assistant can \
    continue the task without it. Include the goal and the user's instructions, what has \
    been done (files read or changed, commands run, and what they showed), decisions \
    made, and what remains to do. Write only the summary.";

/// Introduces a summary when the history it replaced comes back.
pub const PREFIX: &str = "The conversation so far was compacted into this summary. \
    Continue the task from it:";

/// Seals a summary into compaction content.
pub fn seal(summary: &str) -> String {
    format!("{SEAL}{}", STANDARD.encode(summary))
}

/// The summary in compaction content slopmax sealed.
pub fn open(content: &str) -> Option<String> {
    let encoded = content.strip_prefix(SEAL)?;
    String::from_utf8(STANDARD.decode(encoded).ok()?).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seals_round_trip_and_ignore_openais() {
        let sealed = seal("Fixed the bug in a.rs; tests pass.");
        assert!(sealed.starts_with("slopmax1:"));
        assert_eq!(
            open(&sealed).as_deref(),
            Some("Fixed the bug in a.rs; tests pass.")
        );
        assert_eq!(open("gAAAAABencrypted"), None);
    }
}
