// Values that change at run time reach CSS as custom properties, set in a
// `style` that holds only those (`style={{ "--fill": pct(f) }}`) and read by
// classes such as `w-(--fill)`; the classes themselves stay static.
declare module "react" {
  interface CSSProperties {
    [variable: `--${string}`]: string | number | undefined
  }
}

/** A fraction as a CSS percentage, kept within 0–100%. */
export const pct = (fraction: number): string => `${Math.min(100, Math.max(0, fraction * 100))}%`
