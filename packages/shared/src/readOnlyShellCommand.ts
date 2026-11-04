import { parse, type Command, type PipelineNode, type Word, type WordPart } from "unbash";

/**
 * Decides from command text alone whether a shell command is expected to only
 * read, and says what it reads. Approval cards use it to explain a command;
 * it never decides an approval, and nothing on the server imports it, since
 * the provider owns that decision. Nothing here runs, expands or inspects
 * files, so anything this module cannot fully account for is not read-only.
 * The answer is not a guarantee: aliases, shell startup files, environment
 * variables and repository settings such as Git helpers can still make a
 * reading program run others.
 */

const MAX_LENGTH = 8_192;
const MAX_PARTS = 8;

// Unquoted text the parser keeps as a plain word can still be special in zsh,
// which Codex uses to run commands: `=(cmd)` is process substitution there and
// `(...)` can be a glob qualifier that runs code. Only these characters are plain
// in every shell we unwrap.
const PLAIN_UNQUOTED = /^[\w./:@%+,=~^-]+$/u;

function isPlainPart(part: WordPart): boolean {
  if (part.type === "SingleQuoted" || part.type === "AnsiCQuoted") return true;
  if (part.type === "DoubleQuoted") return part.parts.every((child) => child.type === "Literal");
  return part.type === "Literal" && isPlainUnquoted(part.text);
}

function isPlainUnquoted(text: string): boolean {
  return PLAIN_UNQUOTED.test(text) && !text.startsWith("=") && !text.startsWith("~");
}

/**
 * The word's value when the shell would pass it through unchanged: quoted text,
 * or unquoted text without expansions, globs, `~` or zsh-only syntax. `{}` and
 * `\;` are accepted because `find` uses them as plain arguments.
 */
export function literalShellWord(word: Word): string | undefined {
  if (word.parts) return word.parts.every(isPlainPart) ? word.value : undefined;
  if (word.text === "{}" || word.text === "\\;") return word.value;
  return isPlainUnquoted(word.text) ? word.value : undefined;
}

const SHELLS = new Set(["sh", "bash", "zsh"]);
const SHELL_SCRIPT_FLAG = /^-(?:[il]*c|c[il]*)$/u;

/** Strips `/bin/` and `/usr/bin/`; any other path is a different program. */
export function shellProgramName(value: string): string {
  return value.replace(/^\/(?:usr\/)?bin\//u, "");
}

export interface UnwrappedShellCommand {
  /** The wrapper as written before the script, such as `/bin/zsh -lc`. */
  readonly wrapper: string;
  /** The script the wrapper runs, exactly as the shell receives it. */
  readonly script: string;
}

/**
 * Returns the script inside a single `sh|bash|zsh -c '<script>'` wrapper (with
 * `-l`/`-i` allowed), the shape Codex gives every command. Anything else,
 * including a wrapper followed by more commands, returns undefined.
 */
export function unwrapShellCommand(source: string | undefined): UnwrappedShellCommand | undefined {
  if (!source?.trim() || source.length > MAX_LENGTH) return undefined;
  try {
    const parsed = parse(source);
    if (parsed.errors?.length || parsed.commands.length !== 1) return undefined;
    const statement = parsed.commands[0]!;
    const node = statement.command;
    if (statement.background || node.type !== "Command") return undefined;
    const name = node.name ? literalShellWord(node.name) : undefined;
    if (!name || !SHELLS.has(shellProgramName(name))) return undefined;
    if (node.prefix.length > 0 || node.redirects.length > 0 || node.args.length !== 2) {
      return undefined;
    }
    const [flagWord, scriptWord] = node.args;
    if (flagWord?.type !== "Word" || scriptWord?.type !== "Word") return undefined;
    const flag = literalShellWord(flagWord);
    const script = literalShellWord(scriptWord);
    if (!flag || !SHELL_SCRIPT_FLAG.test(flag) || script === undefined || !script.trim()) {
      return undefined;
    }
    return { wrapper: source.slice(node.pos, scriptWord.pos).trim(), script };
  } catch {
    return undefined;
  }
}

interface ParsedArgs {
  readonly options: readonly string[];
  readonly operands: readonly string[];
  /** Values of options that take one, by option, in order. */
  readonly values: ReadonlyMap<string, readonly string[]>;
}

/**
 * Splits arguments into options and operands. `valued` lists options whose value
 * may follow as the next argument; short ones also accept it attached (`-n5`).
 */
function parseArgs(args: readonly string[], valued: ReadonlySet<string> = new Set()): ParsedArgs {
  const options: string[] = [];
  const operands: string[] = [];
  const values = new Map<string, string[]>();
  const record = (option: string, value: string) =>
    values.set(option, [...(values.get(option) ?? []), value]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--") {
      operands.push(...args.slice(index + 1));
      break;
    }
    if (arg.startsWith("--")) {
      options.push(arg);
      const equals = arg.indexOf("=");
      if (equals > 0) record(arg.slice(0, equals), arg.slice(equals + 1));
      else if (valued.has(arg) && index + 1 < args.length) record(arg, args[++index]!);
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      options.push(arg);
      const flag = arg.slice(0, 2);
      if (valued.has(flag)) {
        if (arg.length > 2) record(flag, arg.slice(2));
        else if (index + 1 < args.length) record(flag, args[++index]!);
      }
      continue;
    }
    operands.push(arg);
  }
  return { options, operands, values };
}

/** True when a short-option cluster such as `-rno` contains one of `letters`. */
function shortClusterHas(options: readonly string[], letters: string): boolean {
  return options.some(
    (option) =>
      /^-[^-]/u.test(option) && Array.from(letters).some((letter) => option.includes(letter, 1)),
  );
}

/**
 * True when `arg` gives the long option `option` in full or abbreviated, since
 * getopt_long, less and `git diff --no-index` accept any unambiguous prefix
 * (`--out=x` for `--output`). `shortest` is the shortest prefix that counts.
 */
function givesLongOption(arg: string, option: string, shortest = option.slice(0, 3)): boolean {
  const name = arg.split("=", 1)[0]!;
  return name.startsWith(shortest) && option.startsWith(name);
}

function hasLongOption(args: readonly string[], ...longOptions: readonly string[]): boolean {
  return args.some((arg) => longOptions.some((option) => givesLongOption(arg, option)));
}

function names(values: readonly string[]): string {
  const shown = values
    .slice(0, 3)
    .map((value) => (value.length > 60 ? `${value.slice(0, 57)}…` : value));
  if (values.length > 3) return `${shown.join(", ")} and ${values.length - 3} more`;
  if (shown.length <= 1) return shown[0] ?? "";
  return `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`;
}

function quoted(value: string): string {
  return `"${value.length > 40 ? `${value.slice(0, 37)}…` : value}"`;
}

function lineCount(parsed: ParsedArgs, args: readonly string[]): string {
  const legacy = args.find((arg) => /^-\d+$/u.test(arg))?.slice(1);
  const bytes = parsed.values.get("-c")?.at(-1) ?? parsed.values.get("--bytes")?.at(-1);
  if (bytes !== undefined) return `${bytes} bytes`;
  const count = parsed.values.get("-n")?.at(-1) ?? parsed.values.get("--lines")?.at(-1) ?? legacy;
  return `${count ?? "10"} lines`;
}

const GREP_VALUED = new Set([
  "-e",
  "-f",
  "-m",
  "-A",
  "-B",
  "-C",
  "-d",
  "-D",
  "-g",
  "-t",
  "-T",
  "-M",
  "-j",
  "-E",
  "--regexp",
  "--file",
  "--max-count",
  "--after-context",
  "--before-context",
  "--context",
  "--glob",
  "--iglob",
  "--type",
  "--type-not",
  "--include",
  "--exclude",
  "--exclude-dir",
  "--encoding",
  "--max-columns",
  "--threads",
]);

function describeSearch(name: string, args: readonly string[], piped: boolean): string | undefined {
  // ripgrep runs a preprocessor program for every file searched, and the
  // --hostname-bin program to name the host in hyperlinks.
  if (name === "rg" && hasLongOption(args, "--pre", "--pre-glob", "--hostname-bin")) {
    return undefined;
  }
  // Only ripgrep takes these short options with a value; for grep `-E`/`-T` are flags.
  const valued =
    name === "rg"
      ? GREP_VALUED
      : new Set(
          [...GREP_VALUED].filter(
            (option) => !["-E", "-T", "-g", "-t", "-M", "-j"].includes(option),
          ),
        );
  const parsed = parseArgs(args, valued);
  const explicit = [...(parsed.values.get("-e") ?? []), ...(parsed.values.get("--regexp") ?? [])];
  const fromFile = parsed.values.has("-f") || parsed.values.has("--file");
  // With -e or -f the pattern comes from the option, so every operand is a target.
  const patternFromOption = explicit.length > 0 || fromFile;
  const pattern = patternFromOption ? explicit[0] : parsed.operands[0];
  const targets = patternFromOption ? parsed.operands : parsed.operands.slice(1);
  const what = pattern === undefined ? "patterns from a file" : quoted(pattern);
  const recursive =
    name === "rg" ||
    shortClusterHas(parsed.options, "rR") ||
    parsed.options.includes("--recursive");
  const listsFiles =
    shortClusterHas(parsed.options, "l") || parsed.options.includes("--files-with-matches");
  const inverted =
    shortClusterHas(parsed.options, "v") || parsed.options.includes("--invert-match");
  if (name === "rg" && parsed.options.includes("--files")) {
    return `lists the files ripgrep would search under ${targets.length > 0 || pattern ? names(pattern === undefined ? targets : [pattern, ...targets]) : "the current folder"}`;
  }
  if (targets.length === 0 && piped && !recursive) {
    return `${inverted ? "drops" : "keeps"} lines matching ${what}`;
  }
  const scope =
    targets.length > 0
      ? `${recursive ? "under " : ""}${names(targets)}`
      : recursive
        ? "the current folder"
        : "its input";
  if (listsFiles) return `lists files in ${scope} containing ${what}`;
  return `searches ${scope} for ${inverted ? "lines not matching " : ""}${what}`;
}

const FIND_WRITES = new Set([
  "-delete",
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-fls",
  "-fprint",
  "-fprint0",
  "-fprintf",
]);

function describeFind(args: readonly string[]): string | undefined {
  if (args.some((arg) => FIND_WRITES.has(arg))) return undefined;
  const firstExpression = args.findIndex((arg) => /^[-(!]/u.test(arg));
  const roots = firstExpression < 0 ? args : args.slice(0, firstExpression);
  const expression = firstExpression < 0 ? [] : args.slice(firstExpression);
  const valueOf = (flag: string) => {
    const index = expression.indexOf(flag);
    return index < 0 ? undefined : expression[index + 1];
  };
  const type = valueOf("-type");
  const what = type === "f" ? "files" : type === "d" ? "folders" : "files and folders";
  const named = valueOf("-name") ?? valueOf("-iname");
  const where =
    roots.length === 0 || (roots.length === 1 && roots[0] === ".")
      ? "in the current folder"
      : `under ${names(roots)}`;
  return `lists ${what} ${where}${named ? ` named ${quoted(named)}` : ""}`;
}

const SED_PRINT_SCRIPT = /^\s*(?:(?:\d+|\$)(?:\s*,\s*(?:\d+|\$))?\s*p\s*;?\s*)+$/u;
const SED_OPTIONS = new Set([
  "-n",
  "--quiet",
  "--silent",
  "-E",
  "-r",
  "--regexp-extended",
  "-u",
  "--unbuffered",
  "-z",
  "--null-data",
  "-s",
  "--separate",
]);

function describeSed(args: readonly string[], piped: boolean): string | undefined {
  const parsed = parseArgs(args, new Set(["-e", "--expression"]));
  const scripts = [
    ...(parsed.values.get("-e") ?? []),
    ...(parsed.values.get("--expression") ?? []),
  ];
  const operands = [...parsed.operands];
  if (scripts.length === 0 && operands.length > 0) scripts.push(operands.shift()!);
  // Only line-range printing: other sed commands can write (`w`), run (`e`) or edit in place.
  const quiet = parsed.options.some((option) => ["-n", "--quiet", "--silent"].includes(option));
  const optionsAllowed = parsed.options.every(
    (option) =>
      SED_OPTIONS.has(option) ||
      option.startsWith("-e") ||
      option.startsWith("--expression") ||
      /^-[nErsuz]+$/u.test(option),
  );
  if (
    !optionsAllowed ||
    !(quiet || shortClusterHas(parsed.options, "n")) ||
    scripts.length === 0 ||
    !scripts.every((script) => SED_PRINT_SCRIPT.test(script))
  ) {
    return undefined;
  }
  const range = /^\s*(\d+|\$)(?:\s*,\s*(\d+|\$))?\s*p\s*$/u.exec(
    scripts.length === 1 ? scripts[0]! : "",
  );
  const lines = range
    ? range[2]
      ? `lines ${range[1]}–${range[2]}`
      : `line ${range[1]}`
    : "selected lines";
  return operands.length > 0
    ? `shows ${lines} of ${names(operands)}`
    : `keeps ${lines}${piped ? "" : " of its input"}`;
}

function describeAwk(args: readonly string[], piped: boolean): string | undefined {
  const parsed = parseArgs(args, new Set(["-F", "-v", "--field-separator", "--assign"]));
  const allowed = parsed.options.every(
    (option) =>
      option.startsWith("-F") ||
      option.startsWith("-v") ||
      option.startsWith("--field-separator") ||
      option.startsWith("--assign"),
  );
  const [program, ...rest] = parsed.operands;
  // Output redirection, pipes, `system` and `getline` reach files or other programs.
  if (
    !allowed ||
    program === undefined ||
    /[>|@`]/u.test(program) ||
    /\b(?:system|getline|close|fflush)\b/u.test(program)
  ) {
    return undefined;
  }
  // Operands like `x=1` set variables; the rest are input files.
  const files = rest.filter((operand) => !/^[A-Za-z_]\w*=/u.test(operand));
  return files.length > 0
    ? `extracts text from ${names(files)} with an awk program`
    : `reformats ${piped ? "the lines" : "its input"} with an awk program`;
}

const GIT_BRANCH_LIST_OPTIONS =
  /^(?:-[arvl]+|-vv|--all|--remotes|--verbose|--list|--show-current|--no-color|--color(?:=.*)?|--sort=.+|--format=.+|--(?:no-)?merged(?:=.+)?|--(?:no-)?contains(?:=.+)?|--points-at=.+|--column(?:=.*)?|--no-column|--ignore-case|--omit-empty)$/u;

function describeGit(args: readonly string[]): string | undefined {
  let rest = [...args];
  // Only location and pager options: `-c` and similar can define what runs.
  for (;;) {
    if (rest[0] === "-C" && rest[1] !== undefined) rest = rest.slice(2);
    else if (rest[0] === "--no-pager" || rest[0] === "-P" || rest[0] === "--no-optional-locks") {
      rest = rest.slice(1);
    } else break;
  }
  const [operation, ...tail] = rest;
  const separator = tail.indexOf("--");
  const options = separator < 0 ? tail : tail.slice(0, separator);
  if (operation === "--version" && tail.length === 0) return "shows the Git version";
  if (operation === "status") return "shows which files Git considers changed, staged or untracked";
  if (operation === "diff" || operation === "log" || operation === "show") {
    if (
      options.some(
        (option) =>
          givesLongOption(option, "--output") ||
          givesLongOption(option, "--ext-diff") ||
          // `--text` is its own option.
          givesLongOption(option, "--textconv", "--textc"),
      )
    ) {
      return undefined;
    }
    return operation === "diff"
      ? "shows Git differences"
      : operation === "log"
        ? "shows Git history"
        : "shows the selected Git commits or files";
  }
  if (operation === "blame") {
    const files = parseArgs(tail).operands;
    return `shows who last changed each line${files.length > 0 ? ` of ${names(files.slice(-1))}` : ""}`;
  }
  if (operation === "ls-files") return "lists files Git tracks";
  if (operation === "rev-parse") return "looks up Git revisions or repository paths";
  if (operation === "remote" && tail.every((arg) => arg === "-v" || arg === "--verbose")) {
    return "lists Git remotes";
  }
  if (operation === "branch") {
    const parsed = parseArgs(tail);
    const listing = parsed.options.includes("--list") || shortClusterHas(parsed.options, "l");
    // Without --list, a branch name creates a branch.
    if (!parsed.options.every((option) => GIT_BRANCH_LIST_OPTIONS.test(option))) return undefined;
    if (parsed.operands.length > 0 && !listing) return undefined;
    if (parsed.options.includes("--show-current")) return "shows the current Git branch";
    return "lists Git branches";
  }
  return undefined;
}

const VERSION_CHECKS: Readonly<
  Record<string, { readonly args: readonly string[]; readonly label: string }>
> = {
  node: { args: ["-v", "--version"], label: "Node.js" },
  python: { args: ["--version", "-V"], label: "Python" },
  python3: { args: ["--version", "-V"], label: "Python" },
};

/**
 * What one read-only command does, as a lowercase phrase ("lists files under
 * src"), or undefined when the command might write, run something else, or is
 * not one this module knows. `piped` means its input comes from the previous
 * command in a pipeline. `words` are the program and its literal arguments.
 */
export function describeReadOnlyCommand(
  words: readonly string[],
  piped = false,
): string | undefined {
  const name = shellProgramName(words[0] ?? "");
  const args = words.slice(1);
  const parsed = () => parseArgs(args);
  const files = () => parsed().operands;
  const version = VERSION_CHECKS[name];
  if (version) {
    return args.length === 1 && version.args.includes(args[0]!)
      ? `shows the ${version.label} version`
      : undefined;
  }
  switch (name) {
    case "cat": {
      const targets = files();
      return targets.length > 0
        ? `shows ${names(targets)}`
        : piped
          ? "passes the output on"
          : "shows its input";
    }
    case "head":
    case "tail": {
      const parsedArgs = parseArgs(args, new Set(["-n", "-c", "--lines", "--bytes"]));
      const which = name === "head" ? "first" : "last";
      const amount = lineCount(parsedArgs, args);
      const follow = name === "tail" && shortClusterHas(parsedArgs.options, "fF");
      return parsedArgs.operands.length > 0
        ? `shows the ${which} ${amount} of ${names(parsedArgs.operands)}${follow ? " and keeps following it" : ""}`
        : `keeps the ${which} ${amount}`;
    }
    case "less":
    case "more": {
      // `-o` writes a log file, a lesskey file can set LESSOPEN to run a program,
      // and a `+` command can run a shell command. On macOS `more` is less.
      if (
        args.some((arg) => arg.startsWith("+") && !/^\+\d+$/u.test(arg)) ||
        shortClusterHas(parsed().options, "oOk") ||
        hasLongOption(
          args.map((arg) => arg.toLowerCase()),
          "--log-file",
          "--lesskey-file",
          "--lesskey-src",
          "--lesskey-content",
        )
      ) {
        return undefined;
      }
      return `shows ${names(files()) || "its input"} in a pager`;
    }
    case "wc": {
      const { options, operands } = parsed();
      const kind =
        shortClusterHas(options, "l") || options.includes("--lines")
          ? "lines"
          : shortClusterHas(options, "w") || options.includes("--words")
            ? "words"
            : shortClusterHas(options, "c") || options.includes("--bytes")
              ? "bytes"
              : shortClusterHas(options, "m") || options.includes("--chars")
                ? "characters"
                : "lines, words and bytes";
      return operands.length > 0
        ? `counts the ${kind} in ${names(operands)}`
        : `counts the ${kind}`;
    }
    case "grep":
    case "egrep":
    case "fgrep":
    case "rg":
      return describeSearch(name, args, piped);
    case "find":
      return describeFind(args);
    case "ls": {
      const targets = files();
      return targets.length > 0 ? `lists ${names(targets)}` : "lists the current folder";
    }
    case "tree": {
      // `-o` writes the tree to a file; `-R` runs tree through a shell to write one
      // into every folder (with -H). Both also work inside a cluster such as `-ao`.
      if (shortClusterHas(args, "oR") || args.some((arg) => arg.startsWith("--output"))) {
        return undefined;
      }
      const targets = parseArgs(
        args,
        new Set(["-L", "-P", "-I", "--charset", "--filelimit"]),
      ).operands;
      return `shows the folder tree of ${names(targets) || "the current folder"}`;
    }
    case "du":
      return `shows how much disk space ${names(files()) || "the current folder"} uses`;
    case "df":
      return "shows free disk space";
    case "stat":
      return `shows file details for ${names(parseArgs(args, new Set(["-f", "-c", "-t", "--format", "--printf"])).operands) || "its input"}`;
    case "file":
      // `file -C` compiles a magic file and writes it.
      if (shortClusterHas(parsed().options, "C") || hasLongOption(args, "--compile")) {
        return undefined;
      }
      return `identifies the type of ${names(files()) || "its input"}`;
    case "pwd":
      return "shows the current folder";
    case "which":
      return files().length > 0 ? `shows where ${names(files())} is installed` : undefined;
    case "echo":
    case "printf":
      return "prints text";
    case "sed":
      return describeSed(args, piped);
    case "awk":
    case "gawk":
      return describeAwk(args, piped);
    case "sort": {
      // `-o` writes the result to a file; a compress program runs another program.
      const { options, operands } = parseArgs(
        args,
        new Set(["-k", "-t", "-S", "-T", "--key", "--field-separator"]),
      );
      if (
        shortClusterHas(
          options.filter((option) => !/^-[ktST]./u.test(option)),
          "o",
        ) ||
        hasLongOption(args, "--output", "--compress-program")
      ) {
        return undefined;
      }
      return operands.length > 0 ? `sorts the lines of ${names(operands)}` : "sorts the lines";
    }
    case "uniq": {
      const { options, operands } = parseArgs(args, new Set(["-f", "-s", "-w"]));
      // A second operand is an output file.
      if (operands.length > 1) return undefined;
      const counts = shortClusterHas(options, "c") || options.includes("--count");
      return `${counts ? "counts" : "removes"} repeated lines${operands.length > 0 ? ` in ${operands[0]}` : ""}`;
    }
    case "cut": {
      const targets = parseArgs(args, new Set(["-b", "-c", "-d", "-f"])).operands;
      return `keeps selected columns${targets.length > 0 ? ` of ${names(targets)}` : ""}`;
    }
    case "tr":
      return "replaces or removes characters in the text";
    case "diff": {
      const targets = files();
      return targets.length === 2 ? `compares ${targets[0]} with ${targets[1]}` : "compares files";
    }
    case "nl":
      return "numbers the lines";
    case "basename":
    case "dirname":
      return "prints part of a path";
    case "realpath":
    case "readlink":
      return `shows the full path of ${names(files()) || "its input"}`;
    case "uname":
      return "shows system information";
    case "whoami":
      return "shows the current user name";
    case "cd": {
      const targets = files();
      return args.length === 1 && targets.length === 1 ? `moves into ${targets[0]}` : undefined;
    }
    case "git":
      return describeGit(args);
    default:
      return undefined;
  }
}

/** Only these redirections are allowed: they discard or merge error output. */
function isHarmlessRedirect(redirect: Command["redirects"][number]): boolean {
  if (redirect.type !== "Redirect" || redirect.descriptor?.type !== "FileDescriptor") return false;
  if (redirect.descriptor.value !== 2 || !redirect.target) return false;
  const target = literalShellWord(redirect.target);
  return (
    (redirect.operator === ">" && target === "/dev/null") ||
    (redirect.operator === ">&" && target === "1")
  );
}

function commandWords(node: Command): string[] | undefined {
  if (node.prefix.some((part) => part.type === "Assignment")) return undefined;
  if (!node.redirects.every(isHarmlessRedirect)) return undefined;
  const name = node.name ? literalShellWord(node.name) : undefined;
  if (!name) return undefined;
  const args: string[] = [];
  for (const arg of node.args) {
    if (arg.type !== "Word") return undefined;
    const value = literalShellWord(arg);
    if (value === undefined) return undefined;
    args.push(value);
  }
  return [name, ...args];
}

function describePipeline(node: PipelineNode): string[] | undefined {
  const commands = node.type === "Pipeline" ? node.commands : [node];
  if (node.type === "Pipeline" && node.operators.some((operator) => operator !== "|")) {
    return undefined;
  }
  const phrases: string[] = [];
  for (const [index, command] of commands.entries()) {
    if (command.type !== "Command") return undefined;
    const words = commandWords(command);
    const phrase = words ? describeReadOnlyCommand(words, index > 0) : undefined;
    if (phrase === undefined) return undefined;
    phrases.push(phrase);
  }
  return phrases;
}

export type ReadOnlyShellCommand =
  | {
      readonly readOnly: true;
      /** One sentence that leads with the expected effect and scope, for an approval card. */
      readonly summary: string;
      /** The command that runs, without the outer shell wrapper. */
      readonly command: string;
    }
  | { readonly readOnly: false };

const NOT_READ_ONLY = { readOnly: false } as const;

/**
 * Read-only only when every command in every pipeline and list (`|`, `&&`,
 * `||`, `;`) is a known read-only program with safe arguments: no redirection
 * except `2>/dev/null` and `2>&1`, no expansions or substitutions, no
 * assignments, no background jobs, no compound commands, and at most one outer
 * `sh|bash|zsh -c` wrapper. Unknown means not read-only.
 */
export function classifyReadOnlyShellCommand(source: string | undefined): ReadOnlyShellCommand {
  if (!source?.trim() || source.length > MAX_LENGTH) return NOT_READ_ONLY;
  const inner = unwrapShellCommand(source)?.script ?? source;
  try {
    const parsed = parse(inner);
    if (parsed.errors?.length || parsed.commands.length === 0) return NOT_READ_ONLY;
    const parts: string[][] = [];
    for (const statement of parsed.commands) {
      if (statement.background) return NOT_READ_ONLY;
      const node = statement.command;
      const members = node.type === "AndOr" ? node.commands : [node];
      for (const member of members) {
        const phrases = describePipeline(member);
        if (phrases === undefined) return NOT_READ_ONLY;
        parts.push(phrases);
      }
    }
    if (parts.length === 0 || parts.length > MAX_PARTS) return NOT_READ_ONLY;
    const effect = parts.map((phrases) => phrases.join(", then ")).join("; ");
    return {
      readOnly: true,
      summary: `Expected to read only — ${effect}.`,
      command: inner.trim(),
    };
  } catch {
    return NOT_READ_ONLY;
  }
}
