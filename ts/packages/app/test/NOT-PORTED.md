# @slopmax/app: what is not ported

## Rust tests

None left out. All 39 tests of `crates/slopmax-app` (`alerts.rs` 4,
`lib.rs` 8, `view.rs` 27) are ported under their Rust names, in
`alerts.test.ts`, `lib.test.ts`, and `view.test.ts`.

## Behavior that has no counterpart

| Item                                                      | Why                                                                                                                           | What stands in, and its test                                                                                                                                         |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| APP-010: a 2-worker tokio runtime named `slopmax-app`     | One event loop; the app's background work is fibers forked into the scope the app starts in.                                  | `AppShape.scope`; every `lib.test.ts` test that awaits a task.                                                                                                       |
| APP-012: `handle()` (the runtime, for a UI's own tasks)   | No runtime to hand out.                                                                                                       | `AppShape.scope`: a UI forks its own tasks there (the host does).                                                                                                    |
| APP-012: `subscribe()` usable from any executor           | A `SubscriptionRef`'s `changes` stream is the subscription.                                                                   | `AppShape.changes` and `AppShape.snapshot`; `host.test.ts` draws from them.                                                                                          |
| APP-006: `Notice.shown` as a monotonic `Instant`          | Time comes from `Clock`, so `TestClock` drives it.                                                                            | `Notice.shown` is `Clock.currentTimeMillis`; the 6 s expiry compares it with the clock.                                                                              |
| APP-021: an action that panics reads `the action stopped` | There is no thread to panic; a defect (a thrown error) inside an action is the counterpart.                                   | `actOn` tells `the action stopped: ` and the defect's message; `an action that dies says it stopped, and why` (`lib.test.ts`).                                       |
| `f32` fractions and weights (view.rs)                     | GPUI takes `f32`; JSON and the renderer take numbers. Rounding them to `f32` would print `0.800000011920929` into every view. | Plain numbers; `groups_carry_gauges_status_and_the_pool` and `a_weighted_pool_sizes_its_segments_by_plan` compare `[0.8, 0.2]` exactly, as the Rust compares `f32`s. |
| APP-014: the CLI looked up beside the app first           | The desktop's engine is `slopmax app-host`, the slopmax CLI itself, so its own binary is the CLI whatever it is named.        | `defaults()` tries `background.currentExe` (a compiled slopmax), then `bundledCli` in the Rust's order; `commands_are_looked_up_on_path` covers the lookup.          |
