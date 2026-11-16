// @slopmax/ui has no code for other packages: `build.ts` writes the dashboard
// the daemon embeds. This names where it lands, relative to apps/ui, which is
// where the daemon's build.rs looks for it.
export const outdir = "dist/rust"
