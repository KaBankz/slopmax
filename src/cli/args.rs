//! A small declarative command-line parser. One table of commands drives
//! parsing, `--help` output, errors with suggestions, and shell completions.

use std::fmt::{self, Write as _};
use std::str::FromStr;

use anyhow::{Result, anyhow};

/// The program: its commands and the help around them.
pub struct App {
    pub name: &'static str,
    pub about: &'static str,
    pub after_help: &'static str,
    /// The command run when none is given.
    pub default: &'static str,
    pub commands: &'static [Command],
}

pub struct Command {
    pub name: &'static str,
    pub alias: Option<&'static str>,
    pub about: &'static str,
    pub args: &'static [Arg],
}

pub struct Arg {
    pub name: &'static str,
    pub help: &'static str,
    pub kind: Kind,
}

pub enum Kind {
    /// A positional value that must be given; `choices` may restrict it.
    Required(&'static [Choice]),
    /// A positional value that may be left out, falling back to `default`.
    Optional(&'static [Choice], &'static str),
    /// Every remaining argument, verbatim (flags included).
    Rest,
    /// `--name`, or `-x` with a short form.
    Flag(Option<char>),
    /// `--name VALUE`, `--name=VALUE`, or `-x VALUE`.
    Value(Option<char>, &'static str),
}

/// One accepted value of a positional argument.
pub struct Choice {
    pub value: &'static str,
    pub help: &'static str,
}

impl Arg {
    fn is_positional(&self) -> bool {
        matches!(self.kind, Kind::Required(_) | Kind::Optional(..))
    }

    fn short(&self) -> Option<char> {
        match self.kind {
            Kind::Flag(short) | Kind::Value(short, _) => short,
            _ => None,
        }
    }

    fn choices(&self) -> &'static [Choice] {
        match self.kind {
            Kind::Required(choices) | Kind::Optional(choices, _) => choices,
            _ => &[],
        }
    }

    /// `<PROVIDER>`, `[SOURCE]`, `[ARGS]...`, `--label <LABEL>`.
    fn usage(&self) -> String {
        let upper = self.name.to_ascii_uppercase();
        match self.kind {
            Kind::Required(_) => format!("<{upper}>"),
            Kind::Optional(..) => format!("[{upper}]"),
            Kind::Rest => format!("[{upper}]..."),
            Kind::Flag(_) => format!("--{}", self.name),
            Kind::Value(_, placeholder) => format!("--{} <{placeholder}>", self.name),
        }
    }
}

/// A parsed command line.
pub struct Matches {
    pub command: &'static Command,
    values: Vec<(&'static str, String)>,
    flags: Vec<&'static str>,
    pub rest: Vec<String>,
}

impl Matches {
    pub fn flag(&self, name: &str) -> bool {
        self.flags.contains(&name)
    }

    /// The value of a positional or `--name VALUE` argument, or the
    /// positional's default.
    pub fn value(&self, name: &str) -> Option<&str> {
        self.values
            .iter()
            .find(|(n, _)| *n == name)
            .map(|(_, v)| v.as_str())
            .or_else(|| {
                self.command.args.iter().find_map(|arg| match arg.kind {
                    Kind::Optional(_, default) if arg.name == name => Some(default),
                    _ => None,
                })
            })
    }

    /// A value converted with [`FromStr`]; required by the caller.
    pub fn get<T>(&self, name: &str) -> Result<T>
    where
        T: FromStr,
        T::Err: fmt::Display,
    {
        let value = self
            .value(name)
            .ok_or_else(|| anyhow!("missing <{}>", name.to_ascii_uppercase()))?;
        value
            .parse()
            .map_err(|e| anyhow!("invalid <{}> {value:?}: {e}", name.to_ascii_uppercase()))
    }
}

/// What the command line asked for.
pub enum Parsed {
    Run(Matches),
    /// Help or version text to print.
    Print(String),
}

/// A command line that does not fit the table.
#[derive(Debug)]
pub struct UsageError {
    message: String,
    usage: String,
    help_hint: String,
}

impl fmt::Display for UsageError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "error: {}\n\nUsage: {}\n\nFor more information, try '{}'.\n",
            self.message, self.usage, self.help_hint
        )
    }
}

impl std::error::Error for UsageError {}

pub fn parse(
    app: &'static App,
    args: impl IntoIterator<Item = String>,
) -> Result<Parsed, UsageError> {
    let mut args = args.into_iter().peekable();
    let app_error = |message: String| UsageError {
        message,
        usage: format!("{} [COMMAND]", app.name),
        help_hint: "--help".into(),
    };
    let name = match args.next() {
        None => app.default.to_owned(),
        Some(arg) => match arg.as_str() {
            "-h" | "--help" => return Ok(Parsed::Print(help(app, None))),
            "-V" | "--version" => {
                return Ok(Parsed::Print(format!(
                    "{} {}\n",
                    app.name,
                    env!("CARGO_PKG_VERSION")
                )));
            }
            "help" => {
                return match args.next() {
                    None => Ok(Parsed::Print(help(app, None))),
                    Some(name) => match find(app, &name) {
                        Some(command) => Ok(Parsed::Print(help(app, Some(command)))),
                        None => Err(app_error(unknown_command(app, &name))),
                    },
                };
            }
            _ if arg.starts_with('-') => {
                return Err(app_error(format!("unexpected argument '{arg}'")));
            }
            _ => arg,
        },
    };
    let command = find(app, &name).ok_or_else(|| app_error(unknown_command(app, &name)))?;
    let error = |message: String| UsageError {
        message,
        usage: usage(app, command),
        help_hint: format!("{} {} --help", app.name, command.name),
    };

    let positionals: Vec<&'static Arg> =
        command.args.iter().filter(|a| a.is_positional()).collect();
    let takes_rest = command.args.iter().any(|a| matches!(a.kind, Kind::Rest));
    let mut matches = Matches {
        command,
        values: Vec::new(),
        flags: Vec::new(),
        rest: Vec::new(),
    };
    let mut filled = 0;
    let mut options_done = false;
    while let Some(arg) = args.next() {
        // Once the positionals are in, a trailing list takes everything.
        if takes_rest && filled == positionals.len() {
            matches.rest.push(arg);
            matches.rest.extend(args.by_ref());
            break;
        }
        let is_option = !options_done
            && arg.starts_with('-')
            && arg.len() > 1
            && !arg[1..].starts_with(|c: char| c.is_ascii_digit());
        if arg == "--" && !options_done {
            options_done = true;
            continue;
        }
        if !is_option {
            let Some(spec) = positionals.get(filled) else {
                return Err(error(format!("unexpected argument '{arg}'")));
            };
            let choices = spec.choices();
            if !choices.is_empty() && !choices.iter().any(|c| c.value == arg) {
                let values: Vec<&str> = choices.iter().map(|c| c.value).collect();
                return Err(error(format!(
                    "invalid value '{arg}' for '{}'\n  [possible values: {}]",
                    spec.usage(),
                    values.join(", ")
                )));
            }
            matches.values.push((spec.name, arg));
            filled += 1;
            continue;
        }
        if arg == "-h" || arg == "--help" {
            return Ok(Parsed::Print(help(app, Some(command))));
        }
        let (spec, inline) = if let Some(long) = arg.strip_prefix("--") {
            let (name, inline) = match long.split_once('=') {
                Some((name, value)) => (name, Some(value.to_owned())),
                None => (long, None),
            };
            let spec = command
                .args
                .iter()
                .find(|a| !a.is_positional() && a.name == name)
                .ok_or_else(|| error(unknown_option(command, &arg)))?;
            (spec, inline)
        } else {
            // `-rw` sets two flags; `-lVALUE` gives a value.
            let mut shorts = arg[1..].chars();
            let first = shorts.next().unwrap_or_default();
            let spec = command
                .args
                .iter()
                .find(|a| a.short() == Some(first))
                .ok_or_else(|| error(unknown_option(command, &arg)))?;
            let rest: String = shorts.collect();
            match spec.kind {
                Kind::Value(..) => (spec, (!rest.is_empty()).then_some(rest)),
                _ => {
                    for short in rest.chars() {
                        let flag = command
                            .args
                            .iter()
                            .find(|a| a.short() == Some(short) && matches!(a.kind, Kind::Flag(_)))
                            .ok_or_else(|| error(unknown_option(command, &format!("-{short}"))))?;
                        matches.flags.push(flag.name);
                    }
                    (spec, None)
                }
            }
        };
        match spec.kind {
            Kind::Flag(_) if inline.is_none() => matches.flags.push(spec.name),
            Kind::Flag(_) => {
                return Err(error(format!("'--{}' takes no value", spec.name)));
            }
            Kind::Value(..) => {
                let value = match inline {
                    Some(value) => value,
                    None => args
                        .next()
                        .ok_or_else(|| error(format!("'{}' needs a value", spec.usage())))?,
                };
                matches.values.push((spec.name, value));
            }
            _ => unreachable!("only flags and values are options"),
        }
    }
    if let Some(missing) = positionals[filled..]
        .iter()
        .find(|a| matches!(a.kind, Kind::Required(_)))
    {
        return Err(error(format!(
            "the following required argument was not provided: {}",
            missing.usage()
        )));
    }
    Ok(Parsed::Run(matches))
}

fn find(app: &'static App, name: &str) -> Option<&'static Command> {
    app.commands
        .iter()
        .find(|c| c.name == name || c.alias == Some(name))
}

fn unknown_command(app: &App, name: &str) -> String {
    let names = app.commands.iter().map(|c| c.name);
    match suggest(name, names) {
        Some(close) => {
            format!("unrecognized command '{name}'\n\n  tip: a similar command exists: '{close}'")
        }
        None => format!("unrecognized command '{name}'"),
    }
}

fn unknown_option(command: &Command, arg: &str) -> String {
    let names: Vec<String> = command
        .args
        .iter()
        .filter(|a| !a.is_positional() && !matches!(a.kind, Kind::Rest))
        .map(|a| format!("--{}", a.name))
        .collect();
    let given = arg.split('=').next().unwrap_or(arg);
    match suggest(given, names.iter().map(String::as_str)) {
        Some(close) => {
            format!("unexpected argument '{arg}'\n\n  tip: a similar argument exists: '{close}'")
        }
        None => format!("unexpected argument '{arg}'"),
    }
}

/// The candidate within edit distance 2 of `given`, if any.
fn suggest<'a>(given: &str, candidates: impl Iterator<Item = &'a str>) -> Option<&'a str> {
    candidates
        .map(|c| (distance(given, c), c))
        .filter(|(d, _)| *d <= 2)
        .min_by_key(|(d, _)| *d)
        .map(|(_, c)| c)
}

/// Levenshtein distance.
fn distance(a: &str, b: &str) -> usize {
    let b: Vec<char> = b.chars().collect();
    let mut row: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.chars().enumerate() {
        let mut diagonal = row[0];
        row[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let above = row[j + 1];
            row[j + 1] = (above + 1)
                .min(row[j] + 1)
                .min(diagonal + usize::from(ca != *cb));
            diagonal = above;
        }
    }
    row[b.len()]
}

fn usage(app: &App, command: &Command) -> String {
    let mut out = format!("{} {}", app.name, command.name);
    if command
        .args
        .iter()
        .any(|a| !a.is_positional() && !matches!(a.kind, Kind::Rest))
    {
        out.push_str(" [OPTIONS]");
    }
    for arg in command
        .args
        .iter()
        .filter(|a| a.is_positional() || matches!(a.kind, Kind::Rest))
    {
        out.push(' ');
        out.push_str(&arg.usage());
    }
    out
}

/// Two-column help rows: a left label padded to a shared width.
fn rows(out: &mut String, title: &str, rows: &[(String, String)]) {
    if rows.is_empty() {
        return;
    }
    let width = rows.iter().map(|(left, _)| left.len()).max().unwrap_or(0);
    let _ = writeln!(out, "\n{title}:");
    for (left, right) in rows {
        let _ = writeln!(out, "  {left:width$}  {right}");
    }
}

/// The help text for the program, or for one command.
pub fn help(app: &App, command: Option<&Command>) -> String {
    let mut out = String::new();
    let Some(command) = command else {
        let _ = writeln!(out, "{}\n\nUsage: {} [COMMAND]", app.about, app.name);
        let commands: Vec<(String, String)> = app
            .commands
            .iter()
            .map(|c| {
                let alias = c
                    .alias
                    .map(|a| format!(" [alias: {a}]"))
                    .unwrap_or_default();
                (c.name.to_owned(), format!("{}{alias}", c.about))
            })
            .collect();
        rows(&mut out, "Commands", &commands);
        rows(
            &mut out,
            "Options",
            &[
                ("-h, --help".into(), "Print help".into()),
                ("-V, --version".into(), "Print version".into()),
            ],
        );
        let _ = writeln!(out, "\n{}", app.after_help);
        return out;
    };

    let _ = writeln!(out, "{}\n\nUsage: {}", command.about, usage(app, command));
    let mut arguments = Vec::new();
    for arg in command
        .args
        .iter()
        .filter(|a| a.is_positional() || matches!(a.kind, Kind::Rest))
    {
        let mut help = arg.help.to_owned();
        if let Kind::Optional(_, default) = arg.kind {
            let _ = write!(help, " [default: {default}]");
        }
        arguments.push((arg.usage(), help));
        let width = arg
            .choices()
            .iter()
            .map(|c| c.value.len())
            .max()
            .unwrap_or(0);
        for choice in arg.choices() {
            arguments.push((
                String::new(),
                format!("  {:width$}  {}", choice.value, choice.help),
            ));
        }
    }
    rows(&mut out, "Arguments", &arguments);
    let mut options: Vec<(String, String)> = command
        .args
        .iter()
        .filter(|a| matches!(a.kind, Kind::Flag(_) | Kind::Value(..)))
        .map(|a| {
            let short = a.short().map_or("    ".to_owned(), |s| format!("-{s}, "));
            (format!("{short}{}", a.usage()), a.help.to_owned())
        })
        .collect();
    options.push(("-h, --help".into(), "Print help".into()));
    rows(&mut out, "Options", &options);
    out
}

/// Shells `slopmax completions` can write a script for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Shell {
    Bash,
    Zsh,
    Fish,
}

impl FromStr for Shell {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, String> {
        match s {
            "bash" => Ok(Self::Bash),
            "zsh" => Ok(Self::Zsh),
            "fish" => Ok(Self::Fish),
            _ => Err("expected bash, zsh, or fish".into()),
        }
    }
}

/// A completion script: command names, each command's options, and the
/// accepted values of its first positional argument.
pub fn completions(app: &App, shell: Shell) -> String {
    let name = app.name;
    let commands: Vec<&str> = app.commands.iter().map(|c| c.name).collect();
    let options = |command: &Command| -> Vec<String> {
        command
            .args
            .iter()
            .filter(|a| matches!(a.kind, Kind::Flag(_) | Kind::Value(..)))
            .map(|a| format!("--{}", a.name))
            .chain(["--help".to_owned()])
            .collect()
    };
    let values = |command: &Command| -> Vec<&str> {
        command
            .args
            .iter()
            .find(|a| a.is_positional())
            .map(|a| a.choices().iter().map(|c| c.value).collect())
            .unwrap_or_default()
    };
    let mut out = String::new();
    match shell {
        Shell::Bash | Shell::Zsh => {
            if shell == Shell::Zsh {
                let _ = writeln!(
                    out,
                    "#compdef {name}\nautoload -U bashcompinit && bashcompinit"
                );
            }
            let _ = writeln!(out, "_{name}() {{");
            let _ = writeln!(out, "  local cur=${{COMP_WORDS[COMP_CWORD]}}");
            let _ = writeln!(out, "  if [ \"$COMP_CWORD\" -eq 1 ]; then");
            let _ = writeln!(
                out,
                "    COMPREPLY=($(compgen -W \"{} help --help --version\" -- \"$cur\"))",
                commands.join(" ")
            );
            let _ = writeln!(out, "    return\n  fi\n  case \"${{COMP_WORDS[1]}}\" in");
            for command in app.commands {
                let words: Vec<String> = values(command)
                    .into_iter()
                    .map(str::to_owned)
                    .chain(options(command))
                    .collect();
                let names = match command.alias {
                    Some(alias) => format!("{}|{alias}", command.name),
                    None => command.name.to_owned(),
                };
                let _ = writeln!(
                    out,
                    "    {names}) COMPREPLY=($(compgen -W \"{}\" -- \"$cur\")) ;;",
                    words.join(" ")
                );
            }
            let _ = writeln!(out, "  esac\n}}\ncomplete -F _{name} {name}");
        }
        Shell::Fish => {
            let _ = writeln!(out, "complete -c {name} -f");
            for command in app.commands {
                let _ = writeln!(
                    out,
                    "complete -c {name} -n __fish_use_subcommand -a {} -d '{}'",
                    command.name,
                    command.about.replace('\'', "\\'")
                );
                let seen = format!("__fish_seen_subcommand_from {}", command.name);
                for value in values(command) {
                    let _ = writeln!(out, "complete -c {name} -n '{seen}' -a {value}");
                }
                for arg in command
                    .args
                    .iter()
                    .filter(|a| matches!(a.kind, Kind::Flag(_) | Kind::Value(..)))
                {
                    let short = arg.short().map(|s| format!(" -s {s}")).unwrap_or_default();
                    let takes = if matches!(arg.kind, Kind::Value(..)) {
                        " -r"
                    } else {
                        ""
                    };
                    let _ = writeln!(
                        out,
                        "complete -c {name} -n '{seen}' -l {}{short}{takes} -d '{}'",
                        arg.name,
                        arg.help.replace('\'', "\\'")
                    );
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const COLORS: &[Choice] = &[
        Choice {
            value: "red",
            help: "Warm",
        },
        Choice {
            value: "blue",
            help: "Cool",
        },
    ];

    static APP: App = App {
        name: "tool",
        about: "Does things",
        after_help: "Run without a command to paint.",
        default: "paint",
        commands: &[
            Command {
                name: "paint",
                alias: Some("p"),
                about: "Paint a wall",
                args: &[
                    Arg {
                        name: "color",
                        help: "Paint color",
                        kind: Kind::Optional(COLORS, "red"),
                    },
                    Arg {
                        name: "glossy",
                        help: "Shiny finish",
                        kind: Kind::Flag(Some('g')),
                    },
                    Arg {
                        name: "wet",
                        help: "Leave it wet",
                        kind: Kind::Flag(Some('w')),
                    },
                    Arg {
                        name: "label",
                        help: "Name it",
                        kind: Kind::Value(Some('l'), "LABEL"),
                    },
                ],
            },
            Command {
                name: "shift",
                alias: None,
                about: "Move by an amount",
                args: &[
                    Arg {
                        name: "target",
                        help: "What to move",
                        kind: Kind::Required(&[]),
                    },
                    Arg {
                        name: "by",
                        help: "How far",
                        kind: Kind::Required(&[]),
                    },
                ],
            },
            Command {
                name: "exec",
                alias: None,
                about: "Run a program",
                args: &[
                    Arg {
                        name: "program",
                        help: "Which",
                        kind: Kind::Required(COLORS),
                    },
                    Arg {
                        name: "args",
                        help: "Its arguments",
                        kind: Kind::Rest,
                    },
                ],
            },
        ],
    };

    fn run(args: &[&str]) -> Matches {
        match parse(&APP, args.iter().map(|s| s.to_string())) {
            Ok(Parsed::Run(matches)) => matches,
            Ok(Parsed::Print(text)) => panic!("printed {text}"),
            Err(e) => panic!("{e}"),
        }
    }

    fn fail(args: &[&str]) -> String {
        match parse(&APP, args.iter().map(|s| s.to_string())) {
            Err(e) => e.to_string(),
            Ok(_) => panic!("{args:?} should fail"),
        }
    }

    #[test]
    fn parses_flags_values_and_defaults() {
        let m = run(&[]);
        assert_eq!(m.command.name, "paint");
        assert_eq!(m.value("color"), Some("red"));
        let m = run(&["p", "blue", "-gw", "--label=front"]);
        assert_eq!(m.value("color"), Some("blue"));
        assert!(m.flag("glossy") && m.flag("wet"));
        assert_eq!(m.value("label"), Some("front"));
        assert_eq!(run(&["paint", "-l", "x"]).value("label"), Some("x"));
        assert_eq!(run(&["paint", "-lx"]).value("label"), Some("x"));
    }

    #[test]
    fn negative_numbers_are_values_and_rest_is_verbatim() {
        let m = run(&["shift", "box", "-1"]);
        assert_eq!(m.get::<i32>("by").unwrap(), -1);
        let m = run(&["exec", "red", "exec", "-c", "model=\"m\"", "--help"]);
        assert_eq!(m.value("program"), Some("red"));
        assert_eq!(m.rest, ["exec", "-c", "model=\"m\"", "--help"]);
        assert!(run(&["exec", "blue"]).rest.is_empty());
    }

    #[test]
    fn explains_mistakes() {
        let e = fail(&["pain"]);
        assert!(e.contains("a similar command exists: 'paint'"), "{e}");
        let e = fail(&["paint", "--glosy"]);
        assert!(e.contains("a similar argument exists: '--glossy'"), "{e}");
        let e = fail(&["paint", "green"]);
        assert!(e.contains("[possible values: red, blue]"), "{e}");
        let e = fail(&["shift", "box"]);
        assert!(e.contains("not provided: <BY>"), "{e}");
        assert!(e.contains("Usage: tool shift <TARGET> <BY>"), "{e}");
        assert!(fail(&["paint", "--label"]).contains("needs a value"));
        assert!(fail(&["shift", "a", "b", "c"]).contains("unexpected argument 'c'"));
    }

    #[test]
    fn renders_help() {
        let Ok(Parsed::Print(top)) = parse(&APP, ["--help".to_owned()]) else {
            panic!()
        };
        assert!(top.contains("  paint  Paint a wall [alias: p]"), "{top}");
        assert!(top.ends_with("Run without a command to paint.\n"));
        let Ok(Parsed::Print(paint)) = parse(&APP, ["help".to_owned(), "paint".to_owned()]) else {
            panic!()
        };
        assert!(
            paint.contains("Usage: tool paint [OPTIONS] [COLOR]"),
            "{paint}"
        );
        assert!(paint.contains("Paint color [default: red]"), "{paint}");
        assert!(paint.contains("  red   Warm"), "{paint}");
        assert!(paint.contains("-l, --label <LABEL>  Name it"), "{paint}");
    }

    #[test]
    fn writes_completions() {
        let bash = completions(&APP, Shell::Bash);
        assert!(bash.contains("compgen -W \"paint shift exec help --help --version\""));
        assert!(bash.contains(
            "paint|p) COMPREPLY=($(compgen -W \"red blue --glossy --wet --label --help\""
        ));
        let fish = completions(&APP, Shell::Fish);
        assert!(
            fish.contains("-n '__fish_seen_subcommand_from paint' -l label -s l -r -d 'Name it'")
        );
        assert!(completions(&APP, Shell::Zsh).starts_with("#compdef tool"));
    }

    #[test]
    fn edit_distance() {
        assert_eq!(distance("status", "status"), 0);
        assert_eq!(distance("stauts", "status"), 2);
        assert_eq!(distance("", "abc"), 3);
    }
}
