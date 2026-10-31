// Finds the titles of the tests a TypeScript source file defines, for the test
// map. A title only counts when it is a real test call: code that is commented
// out, or that only appears inside a string, defines no test. So the source is
// first split into tokens (comments dropped, strings and templates kept whole),
// and calls are matched on the tokens.

type Token =
  | { readonly kind: "name"; readonly text: string }
  | { readonly kind: "punct"; readonly text: string }
  | { readonly kind: "string"; readonly value: string }
  /** A template with `${…}` in it, or any other token whose text does not matter. */
  | { readonly kind: "other" }

const simpleEscapes: Readonly<Record<string, string>> = {
  n: "\n",
  t: "\t",
  r: "\r",
  b: "\b",
  f: "\f",
  v: "\v",
  "0": "\0",
}

/** Words after which a `/` starts a regular expression, not a division. */
const beforeExpression = new Set([
  "return",
  "typeof",
  "case",
  "do",
  "else",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "yield",
  "await",
])

const isNameStart = (char: string) => /[\p{L}_$]/u.test(char)
const isNamePart = (char: string) => /[\p{L}\p{N}_$‌‍]/u.test(char)

/** Splits source into tokens; comments and regular expressions are dropped. */
export const tokenize = (source: string): ReadonlyArray<Token> => {
  const tokens: Array<Token> = []
  // One entry per open `${`: the `{` depth inside it, so its `}` resumes the template.
  const templates: Array<number> = []
  let at = 0

  // Reads an escape after a backslash at `at`, returning its value and moving past it.
  const escape = (): string => {
    const char = source[at + 1] ?? ""
    at += 2
    if (char === "\r" && source[at] === "\n") at += 1
    if (char === "\n" || char === "\r" || char === " " || char === " ") return ""
    const hex = (length: number) => {
      const digits = source.slice(at, at + length)
      at += length
      return String.fromCodePoint(Number.parseInt(digits, 16))
    }
    if (char === "x") return hex(2)
    if (char === "u") {
      if (source[at] !== "{") return hex(4)
      const end = source.indexOf("}", at)
      const digits = source.slice(at + 1, end)
      at = end + 1
      return String.fromCodePoint(Number.parseInt(digits, 16))
    }
    return simpleEscapes[char] ?? char
  }

  // Reads template text from `at` (just past a backtick or a closing `}`).
  // Returns its value, or undefined when it reached a `${` instead of its end.
  const templateText = (): string | undefined => {
    let value = ""
    while (at < source.length) {
      const char = source[at]
      if (char === "`") {
        at += 1
        return value
      }
      if (char === "$" && source[at + 1] === "{") {
        at += 2
        templates.push(0)
        return undefined
      }
      if (char === "\\") value += escape()
      else {
        value += char
        at += 1
      }
    }
    return value
  }

  const regexAllowed = () => {
    const last = tokens.at(-1)
    if (last === undefined) return true
    if (last.kind === "punct") return last.text !== ")" && last.text !== "]" && last.text !== "}"
    if (last.kind === "name") return beforeExpression.has(last.text)
    return false
  }

  while (at < source.length) {
    const char = source[at] ?? ""
    const next = source[at + 1]
    if (/\s/.test(char)) at += 1
    else if (char === "/" && next === "/") {
      const end = source.indexOf("\n", at)
      at = end === -1 ? source.length : end
    } else if (char === "/" && next === "*") {
      const end = source.indexOf("*/", at + 2)
      at = end === -1 ? source.length : end + 2
    } else if (char === "/" && regexAllowed()) {
      let inClass = false
      at += 1
      while (at < source.length && source[at] !== "\n") {
        const c = source[at]
        if (c === "\\") at += 1
        else if (c === "[") inClass = true
        else if (c === "]") inClass = false
        else if (c === "/" && !inClass) break
        at += 1
      }
      at += 1
      while (at < source.length && isNamePart(source[at] ?? "")) at += 1
      tokens.push({ kind: "other" })
    } else if (char === '"' || char === "'") {
      let value = ""
      at += 1
      while (at < source.length && source[at] !== char && source[at] !== "\n") {
        if (source[at] === "\\") value += escape()
        else {
          value += source[at]
          at += 1
        }
      }
      at += 1
      tokens.push({ kind: "string", value })
    } else if (char === "`") {
      at += 1
      const value = templateText()
      tokens.push(value === undefined ? { kind: "other" } : { kind: "string", value })
    } else if (char === "}" && templates.length > 0 && templates.at(-1) === 0) {
      templates.pop()
      at += 1
      templateText()
    } else if (isNameStart(char)) {
      const start = at
      while (at < source.length && isNamePart(source[at] ?? "")) at += 1
      tokens.push({ kind: "name", text: source.slice(start, at) })
    } else if (/[0-9]/.test(char) || (char === "." && /[0-9]/.test(next ?? ""))) {
      while (at < source.length && /[\w.]/.test(source[at] ?? "")) at += 1
      tokens.push({ kind: "other" })
    } else {
      if (templates.length > 0) {
        const depth = templates.length - 1
        if (char === "{") templates[depth] = (templates[depth] ?? 0) + 1
        else if (char === "}") templates[depth] = (templates[depth] ?? 0) - 1
      }
      at += 1
      tokens.push({ kind: "punct", text: char })
    }
  }
  return tokens
}

/** Names a test call can start with; `effect` and `live` are the testers an `it.layer` body receives. */
const roots = new Set(["it", "test", "effect", "live"])
/** bun's and slopmax's modifiers that keep the call a test: `it.skip(…)`, `it.effect(…)`. */
const modifiers = new Set(["effect", "live", "skip", "only", "todo", "failing", "concurrent", "serial"])
/** Modifiers that take arguments first: `test.skipIf(cond)(…)`, `test.each(rows)(…)`. */
const conditional = new Set(["skipIf", "if", "todoIf", "each"])

/** The titles of the tests a source file defines with literal names. */
export const testTitles = (source: string): ReadonlySet<string> => {
  const tokens = tokenize(source)
  const titles = new Set<string>()
  const isPunct = (index: number, text: string) => {
    const token = tokens[index]
    return token?.kind === "punct" && token.text === text
  }
  const nameAt = (index: number) => {
    const token = tokens[index]
    return token?.kind === "name" ? token.text : undefined
  }
  // The index just past the parenthesized group opening at `index`.
  const skipGroup = (index: number) => {
    let depth = 0
    for (let at = index; at < tokens.length; at++) {
      if (isPunct(at, "(")) depth += 1
      else if (isPunct(at, ")") && --depth === 0) return at + 1
    }
    return tokens.length
  }
  // Whether the tokens from `index` start a function: `() =>`, `async (…) =>`, `function`, `x =>`.
  const isFunctionAt = (index: number) =>
    isPunct(index, "(") ||
    nameAt(index) === "async" ||
    nameAt(index) === "function" ||
    (nameAt(index) !== undefined && isPunct(index + 1, "=") && isPunct(index + 2, ">"))

  for (let index = 0; index < tokens.length; index++) {
    const root = nameAt(index)
    if (root === undefined || !roots.has(root) || isPunct(index - 1, ".")) continue
    let at = index + 1
    const fromLayer = root === "effect" || root === "live"
    while (isPunct(at, ".")) {
      const modifier = nameAt(at + 1)
      if (modifier !== undefined && modifiers.has(modifier)) at += 2
      else if (modifier !== undefined && conditional.has(modifier) && isPunct(at + 2, "(")) at = skipGroup(at + 2)
      else break
    }
    const title = tokens[at + 1]
    if (!isPunct(at, "(") || title?.kind !== "string") continue
    // A bare `effect(…)` or `live(…)` is a test only when a test body follows,
    // so an unrelated local function of that name is not mistaken for one.
    if (fromLayer && !(isPunct(at + 2, ",") && isFunctionAt(at + 3))) continue
    titles.add(title.value)
  }
  return titles
}
