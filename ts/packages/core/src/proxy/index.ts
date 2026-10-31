// The `proxy` namespace: the proxy agents talk to (`App`, `handle`), window
// warmups, in-place JSON edits, and the header rules the providers share.
export * from "./headers.ts"
export { App, handle, httpApp, type Target } from "./mod.ts"
export * as rawjson from "./rawjson.ts"
export * as warm from "./warm.ts"
