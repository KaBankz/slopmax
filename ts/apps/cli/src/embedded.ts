// The dashboard's files inside the binary. This checked-in copy carries
// none, so a slopmax run from source answers the dashboard's paths with 404;
// `build.ts` writes the real list over it for the build and puts this back.
import { Assets } from "@slopmax/core"
import type { Layer } from "effect"

export const embedded: Layer.Layer<Assets> = Assets.none
