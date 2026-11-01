// @slopmax/ui has no code for other packages: `build.ts` writes the app's two
// copies, which the CLI embeds and the desktop app ships as files. This names
// where each copy lands, relative to apps/ui.
export const outputs = { web: "dist/web", desktop: "dist/desktop" } as const
