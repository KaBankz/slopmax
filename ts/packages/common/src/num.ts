// The `f64` methods the Rust leans on that JavaScript spells differently.

/** `f64::round`: halves away from zero (`Math.round` sends them up). */
export const round = (x: number): number => (x < 0 ? -Math.round(-x) : Math.round(x))

/** `f64::total_cmp`: a total order (NaN last, -0 before +0). */
export const totalCmp = (a: number, b: number): number => {
  if (a < b) return -1
  if (a > b) return 1
  if (a === b) return Object.is(a, b) ? 0 : Object.is(a, -0) ? -1 : 1
  return a !== a ? (b !== b ? 0 : 1) : -1
}
