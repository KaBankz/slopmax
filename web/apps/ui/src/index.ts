// @slopmax/ui has no code for other packages: `build.ts` writes the app's
// copies, the web one and the one the CLI embeds. This names where each
// lands, relative to apps/ui.
export const outputs = { web: "dist/web", rust: "dist/rust" } as const
