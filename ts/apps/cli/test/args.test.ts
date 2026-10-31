import { describe, expect, it } from "bun:test"

import { Effect, Result } from "effect"

import {
  type App,
  type Choice,
  completions,
  distance,
  help,
  i32,
  Kind,
  type Matches,
  parse,
  usage,
  usize,
} from "../src/args.ts"

const COLORS: ReadonlyArray<Choice> = [
  { value: "red", help: "Warm" },
  { value: "blue", help: "Cool" },
]

const APP: App = {
  name: "tool",
  about: "Does things",
  afterHelp: "Run without a command to paint.",
  default: "paint",
  commands: [
    {
      name: "paint",
      alias: "p",
      about: "Paint a wall",
      args: [
        { name: "color", help: "Paint color", kind: Kind.Optional(COLORS, "red") },
        { name: "glossy", help: "Shiny finish", kind: Kind.Flag("g") },
        { name: "wet", help: "Leave it wet", kind: Kind.Flag("w") },
        { name: "label", help: "Name it", kind: Kind.Value("l", "LABEL") },
      ],
    },
    {
      name: "shift",
      alias: undefined,
      about: "Move by an amount",
      args: [
        { name: "target", help: "What to move", kind: Kind.Required() },
        { name: "by", help: "How far", kind: Kind.Required() },
      ],
    },
    {
      name: "exec",
      alias: undefined,
      about: "Run a program",
      args: [
        { name: "program", help: "Which", kind: Kind.Required(COLORS) },
        { name: "args", help: "Its arguments", kind: Kind.Rest },
      ],
    },
  ],
}

const run = (args: ReadonlyArray<string>): Matches => {
  const parsed = parse(APP, args)
  if (Result.isFailure(parsed)) throw new Error(parsed.failure.toString())
  if (parsed.success._tag === "Print") throw new Error(`printed ${parsed.success.text}`)
  return parsed.success.matches
}

const fail = (args: ReadonlyArray<string>): string => {
  const parsed = parse(APP, args)
  if (Result.isSuccess(parsed)) throw new Error(`${JSON.stringify(args)} should fail`)
  return parsed.failure.toString()
}

const printed = (args: ReadonlyArray<string>): string => {
  const parsed = parse(APP, args)
  if (Result.isFailure(parsed) || parsed.success._tag !== "Print")
    throw new Error(`${JSON.stringify(args)} should print`)
  return parsed.success.text
}

describe("args", () => {
  it("parses_flags_values_and_defaults", () => {
    let m = run([])
    expect(m.command.name).toBe("paint")
    expect(m.value("color")).toBe("red")
    m = run(["p", "blue", "-gw", "--label=front"])
    expect(m.value("color")).toBe("blue")
    expect(m.flag("glossy") && m.flag("wet")).toBe(true)
    expect(m.value("label")).toBe("front")
    expect(run(["paint", "-l", "x"]).value("label")).toBe("x")
    expect(run(["paint", "-lx"]).value("label")).toBe("x")
  })

  it("negative_numbers_are_values_and_rest_is_verbatim", () => {
    let m = run(["shift", "box", "-1"])
    expect(Effect.runSync(m.get("by", i32))).toBe(-1)
    m = run(["exec", "red", "exec", "-c", 'model="m"', "--help"])
    expect(m.value("program")).toBe("red")
    expect(m.rest).toEqual(["exec", "-c", 'model="m"', "--help"])
    expect(run(["exec", "blue"]).rest).toEqual([])
  })

  it("explains_mistakes", () => {
    expect(fail(["pain"])).toContain("a similar command exists: 'paint'")
    expect(fail(["paint", "--glosy"])).toContain("a similar argument exists: '--glossy'")
    expect(fail(["paint", "green"])).toContain("[possible values: red, blue]")
    const e = fail(["shift", "box"])
    expect(e).toContain("not provided: <BY>")
    expect(e).toContain("Usage: tool shift <TARGET> <BY>")
    expect(fail(["paint", "--label"])).toContain("needs a value")
    expect(fail(["shift", "a", "b", "c"])).toContain("unexpected argument 'c'")
  })

  it("renders_help", () => {
    const top = printed(["--help"])
    expect(top).toContain("  paint  Paint a wall [alias: p]")
    expect(top.endsWith("Run without a command to paint.\n")).toBe(true)
    const paint = printed(["help", "paint"])
    expect(paint).toContain("Usage: tool paint [OPTIONS] [COLOR]")
    expect(paint).toContain("Paint color [default: red]")
    expect(paint).toContain("  red   Warm")
    expect(paint).toContain("-l, --label <LABEL>  Name it")
  })

  it("writes_completions", () => {
    const bash = completions(APP, "bash")
    expect(bash).toContain('compgen -W "paint shift exec help --help --version"')
    expect(bash).toContain('paint|p) COMPREPLY=($(compgen -W "red blue --glossy --wet --label --help"')
    const fish = completions(APP, "fish")
    expect(fish).toContain("-n '__fish_seen_subcommand_from paint' -l label -s l -r -d 'Name it'")
    expect(completions(APP, "zsh").startsWith("#compdef tool")).toBe(true)
  })

  it("edit_distance", () => {
    expect(distance("status", "status")).toBe(0)
    expect(distance("stauts", "status")).toBe(2)
    expect(distance("", "abc")).toBe(3)
  })
})

describe("args, beyond the Rust tests", () => {
  it("renders usage errors exactly", () => {
    expect(fail(["shift", "box"])).toBe(
      "error: the following required argument was not provided: <BY>\n\nUsage: tool shift <TARGET> <BY>\n\n" +
        "For more information, try 'tool shift --help'.\n",
    )
    // An alias still names the command by its own name.
    expect(fail(["p", "--wat"])).toContain("try 'tool paint --help'")
    expect(fail(["--wat"])).toBe(
      "error: unexpected argument '--wat'\n\nUsage: tool [COMMAND]\n\nFor more information, try '--help'.\n",
    )
    expect(fail(["help", "nothing"])).toContain("unrecognized command 'nothing'")
  })

  it("reads options the way the table says", () => {
    expect(fail(["paint", "--glossy=yes"])).toContain("'--glossy' takes no value")
    expect(fail(["paint", "-gx"])).toContain("unexpected argument '-x'")
    expect(fail(["paint", "--label"])).toContain("'--label <LABEL>' needs a value")
    // The next token is a value even when it starts with `-`.
    expect(run(["paint", "--label", "-g"]).value("label")).toBe("-g")
    // Repeated options are accepted; the first is read.
    expect(run(["paint", "-l", "a", "-l", "b"]).value("label")).toBe("a")
    // `--` ends options: what follows is positional.
    expect(fail(["paint", "--", "--glossy"])).toContain("invalid value '--glossy'")
    expect(fail(["paint", "-"])).toContain("invalid value '-'")
    // `-h` anywhere prints the command's help, even with arguments missing.
    expect(printed(["shift", "--help"])).toContain("Move by an amount")
    expect(printed(["exec", "-h"])).toContain("Usage: tool exec <PROGRAM> [ARGS]...")
  })

  it("lays out the help columns", () => {
    expect(help(APP, undefined)).toBe(
      "Does things\n\nUsage: tool [COMMAND]\n\nCommands:\n" +
        "  paint  Paint a wall [alias: p]\n  shift  Move by an amount\n  exec   Run a program\n\n" +
        "Options:\n  -h, --help     Print help\n  -V, --version  Print version\n\nRun without a command to paint.\n",
    )
    expect(usage(APP, APP.commands[2] ?? APP.commands[0]!)).toBe("tool exec <PROGRAM> [ARGS]...")
  })

  it("converts values as Rust's FromStr does", () => {
    expect(i32("-2147483648")).toEqual(Result.succeed(-2147483648))
    expect(i32("2147483648")).toEqual(Result.fail("number too large to fit in target type"))
    expect(i32("-2147483649")).toEqual(Result.fail("number too small to fit in target type"))
    expect(i32("+7")).toEqual(Result.succeed(7))
    expect(i32("")).toEqual(Result.fail("cannot parse integer from empty string"))
    expect(i32("high")).toEqual(Result.fail("invalid digit found in string"))
    expect(usize("-1")).toEqual(Result.fail("invalid digit found in string"))
    const m = run(["shift", "box", "far"])
    const error = Effect.runSync(Effect.flip(m.get("by", i32)))
    expect(error.message).toBe('invalid <BY> "far": invalid digit found in string')
  })
})
