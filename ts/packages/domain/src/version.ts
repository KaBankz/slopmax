// The version every part of slopmax reports: the proxy's `/healthz`, the
// CLI's `--version`, the user agent of slopmax's own calls to providers, and
// the stamp on `config.schema.json`. One constant, so a front end and the
// daemon it talks to can tell when they come from different releases.

/** This release of slopmax. */
export const slopmaxVersion = "0.4.0"
