# @slopmax/wire: port notes

The TypeScript port of `crates/slopmax-wire`: the request and response
formats slopmax speaks, and translation between them. Pure code: plain
synchronous functions and small classes over plain data, with `Result` for
decoding failures and `Schema` only for the two types slopmax stores
(`Dialect`, `Usage`). No I/O, no `Effect` in the codecs.

## Files

| Rust                          | TypeScript                                      | Notes                                                                                                                                                                                                                                                                                            |
| ----------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/lib.rs`                  | `src/index.ts`, `src/dialect.ts`, `src/base.ts` | `index.ts` is the public surface (the `pub mod` list). `Dialect` and its methods are in `dialect.ts`; `Usage`, `Opening`, `Outcome`, and `frame` in `base.ts`, so the formats import them without importing `Dialect` back (oxlint's `import/no-cycle` forbids the cycle the Rust modules have). |
| `src/ir.rs`                   | `src/ir.ts`                                     | Enums are string unions (`Role`, `ToolKind`, `Effort`, `Stop`) or `_tag` unions (`Part`, `Source`, `ToolChoice`, `Event`); methods are functions on a same-named object (`Media.url`, `Answer.collect`, `Failure.kind`). `Request.make`/`Answer.make` stand for `..Default::default()`.          |
| `src/translate.rs`            | `src/translate.ts`                              | `Decoder.make`, `Encoder.make`/`Encoder.forRequest`; `RequestError` (a `Data.TaggedError`) carries the decoding message.                                                                                                                                                                         |
| `src/messages/mod.rs`         | `src/messages/mod.ts` (+ `index.ts`)            | `index.ts` re-exports `mod.ts` and the submodules as `request` and `reply`, as `messages::…` reads in Rust.                                                                                                                                                                                      |
| `src/messages/request.rs`     | `src/messages/request.ts`                       | One to one.                                                                                                                                                                                                                                                                                      |
| `src/messages/reply.rs`       | `src/messages/reply.ts`                         | `Reply.event` returns the frames.                                                                                                                                                                                                                                                                |
| `src/responses/mod.rs`        | `src/responses/mod.ts` (+ `index.ts`)           | `index.ts` also re-exports `freeformSchema`, as the Rust's `pub use`.                                                                                                                                                                                                                            |
| `src/responses/compaction.rs` | `src/responses/compaction.ts`                   | Base64 through `node:buffer`, checked first as strictly as the `base64` crate's `STANDARD` engine (canonical padding, no stray bits).                                                                                                                                                            |
| `src/responses/events.rs`     | `src/responses/events.ts`                       | One to one.                                                                                                                                                                                                                                                                                      |
| `src/responses/request.rs`    | `src/responses/request.ts`                      | One to one.                                                                                                                                                                                                                                                                                      |
| `src/responses/reply.rs`      | `src/responses/reply.ts`                        | `Reply.compacting`, `whole`, `compacted`.                                                                                                                                                                                                                                                        |
| `src/chat/mod.rs`             | `src/chat/mod.ts` (+ `index.ts`)                |                                                                                                                                                                                                                                                                                                  |
| `src/chat/request.rs`         | `src/chat/request.ts`                           | One to one.                                                                                                                                                                                                                                                                                      |
| `src/chat/events.rs`          | `src/chat/events.ts`                            | The `BTreeMap` of calls is a `Map` read in key order.                                                                                                                                                                                                                                            |
| `src/chat/reply.rs`           | `src/chat/reply.ts`                             |                                                                                                                                                                                                                                                                                                  |
| (serde_json)                  | `src/json.ts`                                   | New: JSON as serde_json reads and writes it. See below.                                                                                                                                                                                                                                          |

## JSON (`src/json.ts`)

The Rust reads and writes `serde_json::Value` (with `preserve_order`,
without `float_roundtrip`). The port uses the engine's `JSON.parse` and
`JSON.stringify` (insertion order and string escapes already match) and adds
what differs:

- **Numbers.** Where the text has no number JavaScript could read
  differently (a fraction or an exponent, `-0`, an integer of 16 digits or
  more) and no surrogate escape, `read` is a plain `JSON.parse`; a regex
  test decides, and a false match (`"x:1.5"` inside a string) only takes the
  slow way. Otherwise it uses `JSON.parse` with a reviver that sees each
  number's source text and gives it serde_json's value and text: `1.0` stays
  `1.0`, `-0` becomes `-0.0`, integers past 2^53 stay exact, floats go
  through serde_json's own fast algorithm (`1e-30` reads as
  `9.999999999999999e-31`, as in the Rust), and out-of-range numbers are
  refused. Numbers JavaScript would write differently are kept as
  `JSON.rawJSON` values, which `JSON.stringify` writes verbatim.
  `json.u64` is `as_u64` (never a float), `json.f64` is `as_f64`, and
  `json.f64Value` writes an `f64` as serde_json does (Chat's `temperature: 1.0`).
- **Errors.** When the text is not JSON, a port of serde_json's reader finds
  the error and says it word for word (`expected value at line 1 column 1`),
  so `the request is not valid JSON: {e}` (WIRE-022) matches. It runs only
  after `JSON.parse` fails. Lone surrogates and invalid UTF-8 are refused as
  serde_json refuses them.
- **Accessors.** `get` (own members of objects only), `str`, `strOf`
  (`get(key).and_then(as_str).unwrap_or("")`), `bool`,
  `array`, `count` (`as_u64().unwrap_or(0)`), `or` (`or_else`, which keeps a
  `null`), `isSome` (present and not `null`).

Measured on Bun 1.4.4 (medians): 2,000 Responses deltas read in 3.1 ms
(plain `JSON.parse` 1.8 ms; 9.4 ms when every event went through the
reviver) and decode and re-encode as Messages frames in 3.9 ms; 2,000 Chat
chunks become Responses frames in 5.7 ms (was 16.9 ms). A 0.68 MB Claude
Code request with no floats decodes, encodes for Responses, and stringifies
in 2.8 ms; one with floats takes the reviver, 7–10 ms for 1.26 MB. A
differential fuzz (800,000 random documents, text and bytes, four seeds)
found no difference between the plain path and the reviver.

## Tests

|                                          | Count                                    |
| ---------------------------------------- | ---------------------------------------- |
| Rust tests in `crates/slopmax-wire`      | 38                                       |
| Ported with the Rust name                | 38 (4 adapted, see `test/NOT-PORTED.md`) |
| Added for contract clauses and `json.ts` | 48                                       |
| Golden tests against the Rust crate      | 6 (285 cases)                            |
| Passing                                  | 92 of 92                                 |

`test/golden.test.ts` replays `test/fixtures/wire-golden.jsonl`, written by
`test/fixtures/wire-golden.rs` running the Rust crate: requests decoded and
encoded for each upstream, streams and whole answers decoded and encoded for
each client (frames, decoded events as Rust's `{:?}`, and whole answers),
every event kind through every encoder, usage and openings read from 21
events per dialect, limit bodies, and serde_json's reading of 54 invalid
request bodies and 9 tricky documents. Random ids read as `<prefix>ID` and creation times
as 0 on both sides. Regenerate with a binary crate depending on
`slopmax-wire`, `slopmax-common` (by path), and `serde_json = "=1.0.151"`
with `preserve_order`; the file's header says how.

## Contract items

| ID            | Where                                                        | Tests                                                                                                                                            |
| ------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| WIRE-001      | `dialect.ts` `Dialect`, `DialectSchema`                      | `formats_have_stable_names`, "dialects serialize as their lowercase names"                                                                       |
| WIRE-002      | `base.ts` `Usage`, `UsageSchema`                             | `usage_adds_up_and_totals_every_kind_of_token`, "usage is stored with snake_case keys"                                                           |
| WIRE-003      | `messages/mod.ts` `error`, `responses/mod.ts` `error`        | `each_format_names_its_errors_its_own_way`, golden "limit errors and error bodies"                                                               |
| WIRE-004      | `limitReached` in each `mod.ts`, `Dialect.limitReached`      | `spent_pools_answer_with_each_clients_own_limit_error`, "the limit headers carry…", golden                                                       |
| WIRE-005      | `responses/mod.ts` `opening`, `Dialect.holdsStart`/`opening` | `only_codex_streams_are_held_until_they_open`, golden "usage, exhaustion, and openings"                                                          |
| WIRE-006..008 | `observe` in each `mod.ts`                                   | `usage_is_read_from_each_formats_events`, `usage_comes_from_the_final_chunk`, "an in-stream rate limit…", golden                                 |
| WIRE-009      | `base.ts` `frame`                                            | `frames_are_server_sent_events`                                                                                                                  |
| WIRE-010      | `ir.ts`                                                      | all codec tests                                                                                                                                  |
| WIRE-011      | `Media.url`, `Media.fromUrl`                                 | `data_urls_round_trip`, "only data URLs with base64…"                                                                                            |
| WIRE-012      | `Effort.parse`, `Effort.fromBudget`                          | `budgets_map_to_efforts`, "effort names and budget edges"                                                                                        |
| WIRE-013      | `Failure.kind`                                               | "failure kinds by status", golden scripts                                                                                                        |
| WIRE-014      | `Answer.collect`, `Answer.stop`                              | `answers_collect_and_infer_tool_use`, "answers keep the last end…"                                                                               |
| WIRE-015      | `textOf`, `ToolResult.text`                                  | "text_of reads strings…"                                                                                                                         |
| WIRE-020..025 | `translate.ts`                                               | the four `translate` Rust tests, "upstream paths", "invalid JSON and a missing model…", "encoding a compaction…", "a cut or unreadable…", golden |
| WIRE-030, 031 | `messages/request.ts`                                        | `decodes_a_claude_code_turn`, `named_effort_wins_over_a_budget`, "tool choices, documents, and results", golden requests                         |
| WIRE-032, 033 | `messages/reply.ts`                                          | `streams_text_then_tool_use`, `failures_become_error_events`, `whole_messages_carry_text_and_calls`, contract tests, golden streams/scripts      |
| WIRE-040..045 | `responses/request.ts`                                       | `decodes_codex_items_into_turns`, `encodes_turns_as_items`, `foreign_reasoning_is_not_replayed`, contract tests, golden requests                 |
| WIRE-046..049 | `responses/events.ts`                                        | the three `responses::events` Rust tests, contract tests, golden streams/wholes                                                                  |
| WIRE-050..054 | `responses/reply.ts`                                         | `streams_items_codex_can_rebuild`, `failures_fail_the_response`, `whole_responses`, contract tests, golden                                       |
| WIRE-056      | `responses/compaction.ts`                                    | `seals_round_trip_and_ignore_openais`, "seals are standard padded base64…", "the prompt and the prefix…"                                         |
| WIRE-060..062 | `chat/request.ts`                                            | `decodes_and_encodes_a_tool_loop`, `freeform_calls_travel_as_functions`, contract tests, golden requests                                         |
| WIRE-063      | `chat/events.ts`                                             | the three `chat::events` Rust tests, contract tests, golden streams/wholes                                                                       |
| WIRE-064, 065 | `chat/reply.ts`                                              | `streams_chunks_then_usage_and_done`, `usage_chunks_only_when_asked`, `whole_completions`, contract tests, golden                                |

## Deviations from the Rust, and why

- **Encoders return text.** `Reply.event(event)` and `Encoder.event` return
  the frames as a string where the Rust appends to `&mut Vec<u8>`; the
  core's transcoding stream concatenates and encodes them once per chunk.
  Decoders push into an `Array<Event>` as the Rust pushes into a `Vec`.
  `translate.decode`, `Decoder.data`, and `Decoder.whole` take bytes, as
  the Rust's `&[u8]`.
- **The clock.** The Responses and Chat encoders, `Encoder.make`,
  `Encoder.forRequest`, and `whole` take `now` (epoch ms) for
  `created`/`created_at`, where the Rust reads `Timestamp::now()`. It is
  required, so the core passes `Clock` time and a `TestClock` test cannot
  see the system clock by accident.
- **Errors.** The format decoders return `Result<Request, string>` as the
  Rust does; `translate.decode` wraps the message in `RequestError`.
  `translate.encode` takes a `Target` (`Exclude<Dialect, "messages">`), so
  the Rust's `unreachable!` for Messages is a type error instead.
- **Readonly data.** `Request`, `Answer`, and the IR are readonly; `Usage.add`
  returns a sum; `observe` replaces `outcome.usage`.
- **JSON limits that stay** (also in `test/NOT-PORTED.md`). JSON nested
  deeper than serde_json's 127 levels is read, where the Rust refuses it (a
  scan to count depth costs about 3 ms per MB on every translated request,
  more than the plain read itself; the scanner still reports it, and the
  golden test checks that). JavaScript objects list integer-like keys
  (`"0"`, `"10"`) first, so a passed-through object with such keys (a tool
  schema's properties, a tool call's input) is written in a different key
  order; the JSON means the same. An `as_u64` value above 2^53 (a
  `max_tokens` of 2^60) is read approximately.
- **`frame`** is not exported from the package, as it is `pub(crate)` in Rust.

## Left for later

Nothing. (The root `.oxlintrc.json` now allows `_tag` for
`no-underscore-dangle` in every package.)
