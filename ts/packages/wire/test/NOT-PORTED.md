# Rust tests not ported as written

Every test of `crates/slopmax-wire` has a TypeScript test with its name
(38 of 38). None was left out. These run against a changed mechanism and
say so here:

| Rust test                                                                              | File                                        | What changed, and what covers the rest                                                                                                                        |
| -------------------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `frames_are_server_sent_events`                                                        | `test/dialect.test.ts`                      | `frame` returns the text instead of appending to a `Vec<u8>`; the test concatenates two frames and compares the same bytes.                                   |
| `usage_adds_up_and_totals_every_kind_of_token`                                         | `test/dialect.test.ts`                      | `Usage` is immutable: `Usage.add` returns the sum instead of adding in place.                                                                                 |
| `encodes_turns_as_items`                                                               | `test/responses/request.test.ts`            | The Rust pushes an image onto the decoded request's first message in place; the port's `Request` is readonly, so the test builds a copy with the image added. |
| `streams_text_then_tool_use`, `failures_become_error_events`, every other encoder test | `test/*/reply.test.ts`, `translate.test.ts` | Encoders return each event's frames as a string; the tests concatenate them where the Rust appends to one buffer.                                             |

The Rust tests compare with serde_json `Value`s; the port's compare plain
objects with `toEqual` and reach into JSON with `test/helpers.ts`'s `at`.
`test/golden.test.ts` checks the byte-for-byte claims the Rust tests do not:
it replays 285 cases through the Rust crate (`test/fixtures/wire-golden.rs`)
and compares every request, frame, whole answer, decoded event, usage count,
opening, limit body, and serde_json error message.

## Behavior deliberately left out

Not Rust tests, but serde_json behaviors the port does not reproduce
(details in `PORT.md`, "Deviations from the Rust"):

| What                                          | Rust                                                                     | Port, and why                                                                                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| JSON nested deeper than 127 levels (WIRE-022) | refused: `the request is not valid JSON: recursion limit exceeded at …`  | read and translated. Counting depth costs about 3 ms per MB on every request; `json.scan` still reports it, and the golden test checks that text. |
| Integer-like object keys (`"0"`, `"10"`)      | written in the order received                                            | written in ascending numeric order first, as JavaScript objects keep them. Same JSON, different bytes.                                            |
| `as_u64` values above 2^53                    | exact (`max_tokens`, `max_output_tokens`, usage counts up to `u64::MAX`) | read as the nearest `number`. Real values never come near.                                                                                        |
