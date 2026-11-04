/**
 * StarkPagesGuard: what counts as publishing to Stark Pages. The one
 * implementation every provider adapter uses (Claude, Codex and its MCP
 * elicitations), so a publish is recognised the same way everywhere.
 *
 * SDK chats cannot publish yet (the workbench's own approval hooks are
 * unverified on the SDK path). The adapters deny a "publish", ask the user
 * about an "ambiguous" call (and never remember an allow for either), and
 * leave "none" alone. Matching is on exact tool names and on a static reading
 * of the shell command, never on free text: an Edit containing page.save(), a
 * file called output-to-s3.md or `echo spage publish` is not a publish.
 *
 * "publish" (starkPagesPublishVerdict; isStarkPagesPublish is true):
 * - a Pages MCP tool that is not a read, on any server
 *   (`mcp__<server>__pages_upload_begin`, or `pages_upload_begin` with the
 *   server reported separately), or the same tool named by a generic proxy
 *   call (`{ name: "pages_upload_files", arguments }`);
 * - a shell command that runs `spage publish …` or `spage upload …`. spage is
 *   any executable or package named spage (`/kit/spage`, `spage.js`,
 *   `@stark/spage@1.2.0`, `npm:@stark/spage`), or the spage script given as
 *   the script argument of node, nodejs, bun, deno, tsx, ts-node, esno,
 *   electron, python or pypy, or of any binary run with ELECTRON_RUN_AS_NODE.
 *   The subcommand is spage's first operand, or a later one when the operand
 *   before it may be an option's value (`spage --profile work publish`);
 * - a curl or wget call that sends data (upload, data, form, json,
 *   PUT/POST/PATCH) to a Pages host named in an operand or an option value
 *   (`--url=…`).
 *
 * The command is read the way bash or zsh parses it: quoting (single quotes
 * and backslash escapes never substitute, double quotes do), `$'…'`, line
 * splicing, comments, `;` `&&` `||` `&` `|` and newlines, `( … )`,
 * `{ …; }`, if/while/until/for/case and function bodies, `$( … )`, backticks
 * and `<( … )` wherever they occur (in words, assignments, redirections and
 * unquoted here-documents), and word splitting of unquoted expansions. These
 * run the command they are given: VAR=… prefixes, env (also -S and
 * --split-string), sudo, doas, nohup, time, command, builtin, exec, nice,
 * timeout, stdbuf, caffeinate, chronic, watch, find -exec/-execdir/-ok/-okdir,
 * xargs (with the arguments it reads from a pipe the guard can compute),
 * npx/bunx/pnpx, npm exec/x, pnpm and yarn exec/dlx or a bin name, bun x,
 * `-c`/`--call` of those runners, eval, and sh/bash/zsh/dash/ksh/mksh/ash/fish
 * given a script by -c, by a here-document or here-string, by a pipe from
 * echo/printf/cat/tee, or as the spage script itself. Variables, arrays,
 * positional parameters (`set --`), `export`/`declare`/`local` and aliases
 * set earlier in the same command are substituted, and `$(which X)`,
 * `$(command -v X)`, `$(echo …)` and `$(printf …)` are replaced by their
 * output. A function body counts wherever it is defined.
 *
 * "ambiguous" (ask): the guard cannot resolve the command statically AND its
 * visible words mention spage, publish, upload or a Pages host. Visible words
 * include the text an unresolved variable was assigned from (`X=$(get
 * spage)`) and the variable's own name (`$SPAGE_BIN`). That is:
 * - a word in command position (the command itself, or the script an
 *   interpreter or shell runs) holds an expansion the guard cannot resolve
 *   from earlier assignments: an environment variable, a `read` or for-loop
 *   variable, a command substitution, a glob or brace expansion, or the input
 *   xargs -I or find -exec puts in place of `{}` (`$CMD publish`,
 *   `${TOOL:-spage} publish`). Text given to -c, eval, env -S or watch is
 *   re-read as commands with such expansions still unresolved, so
 *   `eval "$PUBLISH_CMD"` is ambiguous and `bash -c "cd $DIR && spage list"`
 *   is not;
 * - spage's subcommand is such an expansion (`spage "$sub"`), or comes from
 *   xargs reading input the guard cannot compute (`ls | xargs spage`);
 * - a shell reads its script from a pipe the guard cannot compute
 *   (`curl https://pages.starkfuture.com/x.sh | sh`);
 * - a curl or wget call whose method, data options or URL are unresolvable,
 *   with a Pages host in its visible words;
 * - inline interpreter code (`node -e`, `python -c`, `deno eval`, a script on
 *   stdin) that names spage with publish/upload and a process call, or a
 *   Pages host with an upload method;
 * - commands nested deeper than the guard follows (12 levels of
 *   substitution, 8 levels of re-parsed scripts) and any command longer than
 *   100 000 characters, which is not parsed at all.
 *
 * "none": everything else, including comments, echo/printf of the words,
 * single-quoted or escaped `$(…)`, here-documents written to files, grep or
 * rg searches, and file operations on spage.js or pages/ (`git add`, `cat`,
 * `mv`, `cp`, `vim`).
 *
 * Not covered, so "none" unless an ambiguous rule above applies: a script
 * file run by name or later (`bash publish.sh`, `./publish.sh`, `source`,
 * npm/pnpm/yarn run scripts, make), a shell reading its script from a file
 * (`sh < x.sh`), aliases and functions defined outside the command, curl or
 * wget whose config or URL comes from a file or an unnamed environment
 * variable, commands run elsewhere (ssh, docker), other HTTP clients, and
 * non-POSIX shells (cmd, PowerShell).
 */

/** Pages MCP tools that only read. Any other `pages_` tool counts as a write. */
const STARK_PAGES_READ_TOOLS = new Set([
  "pages_list_projects",
  "pages_search",
  "pages_read_content",
  "pages_read_file",
  "pages_get_data_sdk_reference",
  "pages_get_public_url",
  "pages_download_files_zip",
  "pages_export_data",
  "pages_query_data",
]);

/** The write tools of the claude.ai Pages connector, also denied natively by name. */
export const STARK_PAGES_CONNECTOR_DISALLOWED_TOOLS = [
  "pages_create_project",
  "pages_update_project",
  "pages_invite_member",
  "pages_upload_begin",
  "pages_upload_commit",
  "pages_upload_files",
  "pages_add_data_row",
  "pages_update_data_row",
  "pages_delete_data_row",
].map((tool) => `mcp__claude_ai_Pages__${tool}`);

export const STARK_PAGES_PUBLISH_DENIED =
  "Stark Pages publishing is available only in native Claude shell mode until its SDK approval hooks have been verified.";

/** Why an "ambiguous" command is put to the user even when the mode would allow it. */
export const STARK_PAGES_PUBLISH_UNCERTAIN =
  "Stark Code cannot tell whether this command publishes to Stark Pages, which is available only in native Claude shell mode, so it needs your approval.";

/** How a tool call relates to Stark Pages publishing; see the module comment. */
export type StarkPagesPublishVerdict = "publish" | "ambiguous" | "none";

/** A tool call as the guard judges it. */
export interface StarkPagesToolCall {
  readonly toolName: string;
  readonly toolInput: unknown;
  /** The MCP server behind an MCP tool, when the provider reports it. */
  readonly mcpServer?: { readonly name: string; readonly source?: string | undefined } | undefined;
}

/** Tools that run a shell command: Claude's Bash and Monitor, and Codex's shell tools. */
const SHELL_COMMAND_TOOLS = new Set([
  "bash",
  "monitor",
  "shell",
  "local_shell",
  "exec_command",
  "command",
]);
const PROXY_NAME_KEYS = ["name", "tool", "tool_name", "toolName", "method"] as const;
const PROXY_ARGUMENT_KEYS = ["arguments", "args", "params", "input"] as const;

const isPagesWrite = (tool: string | undefined) =>
  tool !== undefined && !STARK_PAGES_READ_TOOLS.has(tool);
const normalizePagesTool = (tool: string) => tool.toLowerCase().replaceAll("-", "_");

/**
 * The `pages_` tool an MCP call refers to, whatever its server is called: from
 * `mcp__<server>__pages_…`, or from the bare tool name when the provider
 * reports the server separately.
 */
function mcpPagesTool(toolName: string, reportsServer: boolean): string | undefined {
  if (!toolName.startsWith("mcp__")) {
    return reportsServer && /^pages_/i.test(toolName) ? normalizePagesTool(toolName) : undefined;
  }
  const at = toolName.toLowerCase().lastIndexOf("__pages_");
  return at > 3 ? normalizePagesTool(toolName.slice(at + 2)) : undefined;
}

/** The `pages_` tool a generic proxy call names (`{ name: "pages_upload_files", arguments }`). */
function proxiedPagesTool(toolInput: unknown): string | undefined {
  if (typeof toolInput !== "object" || toolInput === null) return undefined;
  if (!PROXY_ARGUMENT_KEYS.some((key) => Object.hasOwn(toolInput, key))) return undefined;
  for (const key of PROXY_NAME_KEYS) {
    const value = Reflect.get(toolInput, key);
    if (typeof value !== "string") continue;
    const match = /(?:^|__|[./:])(pages_[A-Za-z0-9_-]{1,80})$/.exec(value.trim());
    if (match) return normalizePagesTool(match[1]!);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Shell parsing: a command line becomes simple commands whose words keep where
// each piece came from (quoted text, a parameter, a command substitution).

type ParamPart = {
  readonly kind: "param";
  readonly name: string;
  /** `#` (length) or `!` (indirection), which the guard never resolves. */
  readonly prefix: string;
  readonly index: string | undefined;
  readonly op: string;
  readonly arg: ShellWord | undefined;
  readonly raw: string;
  readonly quoted: boolean;
};

type Part =
  | { readonly kind: "text"; readonly text: string; readonly quoted: boolean }
  | ParamPart
  | {
      readonly kind: "command";
      readonly script: ShellScript;
      readonly raw: string;
      readonly quoted: boolean;
    }
  | {
      /** Arithmetic or process substitution: runs what it contains, value unknown. */
      readonly kind: "opaque";
      readonly raw: string;
      readonly scripts: ReadonlyArray<ShellScript>;
      readonly words: ReadonlyArray<ShellWord>;
    };

interface ShellWord {
  readonly parts: ReadonlyArray<Part>;
  readonly raw: string;
  /** The elements of an array assignment `name=( … )`. */
  readonly array?: ReadonlyArray<ShellWord> | undefined;
}

type Stdin =
  | { readonly kind: "text"; readonly word: ShellWord; readonly hereString: boolean }
  | { readonly kind: "pipe"; readonly from: ShellCommand }
  | { readonly kind: "file" };

interface ShellCommand {
  readonly words: ShellWord[];
  readonly redirects: ShellWord[];
  stdin: Stdin | undefined;
  raw: string;
}

interface ShellScript {
  readonly commands: ReadonlyArray<ShellCommand>;
  readonly tooDeep: boolean;
}

interface PendingHeredoc {
  readonly delimiter: string;
  readonly quoted: boolean;
  readonly stripTabs: boolean;
  readonly command: ShellCommand;
}

const MAX_NESTING = 12;
const OPERATOR_CHARS = new Set([";", "&", "|", "(", ")", "<", ">"]);
const SHELL_KEYWORDS = new Set([
  "!",
  "{",
  "}",
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "do",
  "done",
  "while",
  "until",
  "esac",
  "coproc",
]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

const isBlank = (char: string | undefined) => char === " " || char === "\t" || char === "\r";
const emptyCommand = (): ShellCommand => ({ words: [], redirects: [], stdin: undefined, raw: "" });

function pushText(parts: Part[], text: string, quoted: boolean): void {
  const last = parts.at(-1);
  if (last?.kind === "text" && last.quoted === quoted) {
    parts[parts.length - 1] = { kind: "text", text: last.text + text, quoted };
  } else parts.push({ kind: "text", text, quoted });
}

/** The word as unquoted plain text, or undefined when any of it is quoted or expanded. */
function plainText(word: ShellWord): string | undefined {
  const [first, ...rest] = word.parts;
  return first?.kind === "text" && !first.quoted && rest.length === 0 ? first.text : undefined;
}

const ESCAPES: Readonly<Record<string, string>> = {
  n: "\n",
  t: "\t",
  r: "\r",
  a: "\u0007",
  b: "\b",
  e: "\u001b",
  E: "\u001b",
  f: "\f",
  v: "\v",
};

/** Backslash escapes as `$'…'`, `echo -e` and printf decode them. */
function decodeEscapes(text: string): string {
  return text.replace(
    /\\(x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|U[0-9a-fA-F]{1,8}|[0-7]{1,3}|c[\s\S]|[\s\S])/g,
    (_match, code: string) => {
      if (/^[xuU]/.test(code)) {
        const point = Number.parseInt(code.slice(1), 16);
        return point <= 0x10ffff ? String.fromCodePoint(point) : "";
      }
      if (/^[0-7]/.test(code)) return String.fromCharCode(Number.parseInt(code, 8) & 0xff);
      if (code.length === 2 && code.startsWith("c")) {
        return String.fromCharCode(code.charCodeAt(1) & 0x1f);
      }
      return ESCAPES[code] ?? code;
    },
  );
}

class ShellParser {
  readonly src: string;
  readonly nesting: number;
  i: number;
  tooDeep = false;
  /** Open `${…}` and `$((…))` in this parser, which nest by recursion. */
  private open = 0;

  constructor(src: string, start: number, nesting: number) {
    this.src = src;
    this.i = start;
    this.nesting = nesting;
  }

  /** Simple commands up to the end, or up to an unmatched `)` when `closing`. */
  script(closing: boolean): ShellScript {
    const src = this.src;
    const commands: ShellCommand[] = [];
    const heredocs: PendingHeredoc[] = [];
    let current = emptyCommand();
    let start = -1;
    let pipeFrom: ShellCommand | undefined;
    let parens = 0;
    let cases = 0;
    const finish = () => {
      const hasHeredoc = heredocs.some((doc) => doc.command === current);
      if (current.words.length > 0 || current.redirects.length > 0 || current.stdin || hasHeredoc) {
        if (current.words.length > 0) {
          if (current.stdin === undefined && pipeFrom !== undefined) {
            current.stdin = { kind: "pipe", from: pipeFrom };
          }
          pipeFrom = undefined;
        }
        current.raw = src.slice(Math.max(start, 0), this.i);
        commands.push(current);
      }
      current = emptyCommand();
      start = -1;
    };
    while (this.i < src.length) {
      const char = src[this.i]!;
      const next = src[this.i + 1];
      if (isBlank(char)) this.i++;
      else if (char === "\\" && next === "\n") this.i += 2;
      else if (char === "\n") {
        finish();
        this.i++;
        this.heredocBodies(heredocs);
      } else if (char === "#") {
        const end = src.indexOf("\n", this.i);
        this.i = end < 0 ? src.length : end;
      } else if (char === ";") {
        finish();
        while (src[this.i] === ";" || src[this.i] === "&") this.i++;
      } else if (char === "&" && next !== ">") {
        finish();
        this.i += next === "&" ? 2 : 1;
      } else if (char === "|") {
        finish();
        if (next !== "|") pipeFrom = commands.at(-1);
        this.i += next === "|" || next === "&" ? 2 : 1;
      } else if (char === "(") {
        const definition = /\(\s*\)/y;
        definition.lastIndex = this.i;
        if (cases === 0 && definition.test(src)) {
          // `name () { … }`: drop the name, the body follows as commands.
          current = emptyCommand();
          start = -1;
          this.i = definition.lastIndex;
          continue;
        }
        finish();
        if (cases === 0) parens++;
        this.i++;
      } else if (char === ")") {
        if (cases === 0 && parens === 0 && closing) {
          finish();
          return { commands, tooDeep: this.tooDeep };
        }
        finish();
        if (cases === 0 && parens > 0) parens--;
        this.i++;
      } else {
        if (start < 0) start = this.i;
        if ((char === "<" || char === ">" || char === "&") && next !== "(") {
          this.redirect(current, heredocs);
          continue;
        }
        const word = this.word("word");
        if (word.raw === "") {
          this.i++;
          continue;
        }
        const after = src[this.i];
        if (
          (after === "<" || after === ">") &&
          /^(?:\d+|\{[A-Za-z_][A-Za-z0-9_]*\})$/.test(word.raw)
        ) {
          continue;
        }
        if (
          after === "(" &&
          /^[A-Za-z_][A-Za-z0-9_]*\+?=$/.test(word.raw) &&
          current.words.every((existing) => assignmentOf(existing) !== undefined)
        ) {
          current.words.push({ ...word, array: this.arrayElements() });
          continue;
        }
        const plain = plainText(word);
        const atStart = current.words.every((existing) =>
          SHELL_KEYWORDS.has(plainText(existing) ?? ""),
        );
        if (atStart && plain === "case") cases++;
        else if (atStart && plain === "esac" && cases > 0) cases--;
        current.words.push(word);
      }
    }
    finish();
    return { commands, tooDeep: this.tooDeep };
  }

  /** One word: up to unquoted whitespace or an operator ("word"), up to `}` ("brace"), or all of a here-document body. */
  word(mode: "word" | "brace" | "heredoc"): ShellWord {
    const src = this.src;
    const begin = this.i;
    const parts: Part[] = [];
    const heredoc = mode === "heredoc";
    while (this.i < src.length) {
      const char = src[this.i]!;
      const next = src[this.i + 1];
      const processSubstitution = mode === "word" && (char === "<" || char === ">") && next === "(";
      if (
        mode === "word" &&
        !processSubstitution &&
        (isBlank(char) || char === "\n" || OPERATOR_CHARS.has(char))
      ) {
        break;
      }
      if (mode === "brace" && char === "}") break;
      if (char === "\\") {
        if (next === undefined) {
          pushText(parts, "\\", heredoc);
          this.i++;
        } else if (next === "\n") this.i += 2;
        else if (heredoc && !"$`\\".includes(next)) {
          pushText(parts, "\\", true);
          this.i++;
        } else {
          pushText(parts, next, true);
          this.i += 2;
        }
      } else if (!heredoc && char === "'") {
        const end = src.indexOf("'", this.i + 1);
        const stop = end < 0 ? src.length : end;
        pushText(parts, src.slice(this.i + 1, stop), true);
        this.i = Math.min(stop + 1, src.length);
      } else if (!heredoc && char === '"') {
        this.i++;
        this.doubleQuoted(parts);
      } else if (!heredoc && char === "$" && next === "'") this.ansiC(parts);
      else if (!heredoc && char === "$" && next === '"') {
        this.i += 2;
        this.doubleQuoted(parts);
      } else if (char === "$") this.dollar(parts, heredoc);
      else if (char === "`") this.backtick(parts, heredoc);
      else if (processSubstitution) {
        const opening = this.i;
        this.i += 2;
        const script = this.substitution();
        parts.push({
          kind: "opaque",
          raw: src.slice(opening, this.i),
          scripts: [script],
          words: [],
        });
      } else {
        pushText(parts, char, heredoc);
        this.i++;
      }
    }
    return { parts, raw: src.slice(begin, this.i) };
  }

  private doubleQuoted(parts: Part[]): void {
    const src = this.src;
    pushText(parts, "", true);
    while (this.i < src.length) {
      const char = src[this.i]!;
      const next = src[this.i + 1];
      if (char === '"') {
        this.i++;
        return;
      }
      if (char === "\\" && next === "\n") this.i += 2;
      else if (char === "\\" && next !== undefined && '$`"\\'.includes(next)) {
        pushText(parts, next, true);
        this.i += 2;
      } else if (char === "$") this.dollar(parts, true);
      else if (char === "`") this.backtick(parts, true);
      else {
        pushText(parts, char, true);
        this.i++;
      }
    }
  }

  private ansiC(parts: Part[]): void {
    const src = this.src;
    let end = this.i + 2;
    while (end < src.length && src[end] !== "'") end += src[end] === "\\" ? 2 : 1;
    pushText(parts, decodeEscapes(src.slice(this.i + 2, Math.min(end, src.length))), true);
    this.i = Math.min(end + 1, src.length);
  }

  private dollar(parts: Part[], quoted: boolean): void {
    const src = this.src;
    const begin = this.i;
    const next = src[this.i + 1];
    if (next === "(" && src[this.i + 2] === "(") {
      if (this.nesting >= MAX_NESTING) {
        this.tooDeep = true;
        this.i = src.length;
        return;
      }
      let depth = 0;
      let end = this.i + 1;
      for (; end < src.length; end++) {
        if (src[end] === "(") depth++;
        else if (src[end] === ")" && --depth === 0) break;
      }
      this.i = Math.min(end + 1, src.length);
      const inner = new ShellParser(
        src.slice(begin + 3, Math.max(begin + 3, end - 1)),
        0,
        this.nesting + 1,
      );
      const word = inner.word("heredoc");
      this.tooDeep ||= inner.tooDeep;
      parts.push({ kind: "opaque", raw: src.slice(begin, this.i), scripts: [], words: [word] });
      return;
    }
    if (next === "(") {
      this.i += 2;
      const script = this.substitution();
      parts.push({ kind: "command", script, raw: src.slice(begin, this.i), quoted });
      return;
    }
    if (next === "{") {
      this.braceParameter(parts, quoted);
      return;
    }
    const name = /[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-]/y;
    name.lastIndex = this.i + 1;
    const match = name.exec(src);
    if (match) {
      this.i = name.lastIndex;
      parts.push({
        kind: "param",
        name: match[0],
        prefix: "",
        index: undefined,
        op: "",
        arg: undefined,
        raw: src.slice(begin, this.i),
        quoted,
      });
      return;
    }
    pushText(parts, "$", quoted);
    this.i++;
  }

  private braceParameter(parts: Part[], quoted: boolean): void {
    const src = this.src;
    const begin = this.i;
    if (this.open >= MAX_NESTING) {
      this.tooDeep = true;
      this.i = src.length;
      return;
    }
    this.i += 2;
    let prefix = "";
    if ((src[this.i] === "#" || src[this.i] === "!") && src[this.i + 1] !== "}") {
      prefix = src[this.i]!;
      this.i++;
    }
    const name = /[A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*#?$!-]/y;
    name.lastIndex = this.i;
    const match = name.exec(src);
    if (match) this.i = name.lastIndex;
    let index: string | undefined;
    if (src[this.i] === "[") {
      const close = src.indexOf("]", this.i);
      if (close >= 0) {
        index = src.slice(this.i + 1, close);
        this.i = close + 1;
      }
    }
    const operator = /:[-=?+]|[-=?+]|##|#|%%|%|\/\/|\/#|\/%|\/|\^\^|\^|,,|,|:|@/y;
    operator.lastIndex = this.i;
    const op = operator.exec(src)?.[0] ?? "";
    this.i += op.length;
    this.open++;
    const arg = op === "" && src[this.i] === "}" ? undefined : this.word("brace");
    this.open--;
    if (src[this.i] === "}") this.i++;
    parts.push({
      kind: "param",
      name: match?.[0] ?? "",
      prefix,
      index,
      op: op === "" && arg !== undefined ? "invalid" : op,
      arg,
      raw: src.slice(begin, this.i),
      quoted,
    });
  }

  private backtick(parts: Part[], quoted: boolean): void {
    const src = this.src;
    const begin = this.i;
    let inner = "";
    this.i++;
    while (this.i < src.length && src[this.i] !== "`") {
      const char = src[this.i]!;
      const next = src[this.i + 1];
      if (char === "\\" && next !== undefined) {
        inner += "$`\\".includes(next) || (quoted && next === '"') ? next : char + next;
        this.i += 2;
      } else {
        inner += char;
        this.i++;
      }
    }
    this.i = Math.min(this.i + 1, src.length);
    let script: ShellScript = { commands: [], tooDeep: true };
    if (this.nesting >= MAX_NESTING) this.tooDeep = true;
    else {
      const parser = new ShellParser(inner, 0, this.nesting + 1);
      script = parser.script(false);
      this.tooDeep ||= parser.tooDeep;
    }
    parts.push({ kind: "command", script, raw: src.slice(begin, this.i), quoted });
  }

  /** The script of `$( … )` or `<( … )`, from just after the opening parenthesis. */
  private substitution(): ShellScript {
    if (this.nesting >= MAX_NESTING) {
      this.tooDeep = true;
      this.i = this.src.length;
      return { commands: [], tooDeep: true };
    }
    const parser = new ShellParser(this.src, this.i, this.nesting + 1);
    const script = parser.script(true);
    this.tooDeep ||= parser.tooDeep;
    this.i = Math.min(parser.i + 1, this.src.length);
    return script;
  }

  private arrayElements(): ShellWord[] {
    const src = this.src;
    const elements: ShellWord[] = [];
    this.i++;
    while (this.i < src.length) {
      const char = src[this.i]!;
      if (isBlank(char) || char === "\n") this.i++;
      else if (char === "\\" && src[this.i + 1] === "\n") this.i += 2;
      else if (char === ")") {
        this.i++;
        break;
      } else if (char === "#") {
        const end = src.indexOf("\n", this.i);
        this.i = end < 0 ? src.length : end;
      } else {
        const word = this.word("word");
        if (word.raw === "") this.i++;
        else elements.push(word);
      }
    }
    return elements;
  }

  private redirect(command: ShellCommand, heredocs: PendingHeredoc[]): void {
    const src = this.src;
    const operator = /&>>|&>|<<<|<<-|<<|<>|<&|>>|>\||>&|<|>/y;
    operator.lastIndex = this.i;
    const op = operator.exec(src)?.[0] ?? src[this.i]!;
    this.i += op.length;
    while (isBlank(src[this.i])) this.i++;
    const char = src[this.i];
    if (
      char === undefined ||
      char === "\n" ||
      (OPERATOR_CHARS.has(char) && !((char === "<" || char === ">") && src[this.i + 1] === "("))
    ) {
      return;
    }
    const target = this.word("word");
    if (op === "<<" || op === "<<-") {
      heredocs.push({
        delimiter: target.parts
          .map((part) => (part.kind === "text" ? part.text : part.raw))
          .join(""),
        quoted: target.parts.some((part) => part.kind === "text" && part.quoted),
        stripTabs: op === "<<-",
        command,
      });
    } else if (op === "<<<") command.stdin = { kind: "text", word: target, hereString: true };
    else {
      command.redirects.push(target);
      if (op === "<" || op === "<>") command.stdin = { kind: "file" };
    }
  }

  /** Reads the bodies of the here-documents opened on the line just ended. */
  private heredocBodies(heredocs: PendingHeredoc[]): void {
    const src = this.src;
    for (const doc of heredocs.splice(0)) {
      const lines: string[] = [];
      while (this.i < src.length) {
        const newline = src.indexOf("\n", this.i);
        let line = src.slice(this.i, newline < 0 ? src.length : newline);
        this.i = newline < 0 ? src.length : newline + 1;
        if (doc.stripTabs) line = line.replace(/^\t+/, "");
        if (line.replace(/\r$/, "") === doc.delimiter) break;
        lines.push(line);
      }
      const body = lines.map((line) => `${line}\n`).join("");
      let word: ShellWord = { parts: [{ kind: "text", text: body, quoted: true }], raw: body };
      if (!doc.quoted) {
        const parser = new ShellParser(body, 0, this.nesting + 1);
        word = parser.word("heredoc");
        this.tooDeep ||= parser.tooDeep;
      }
      doc.command.stdin = { kind: "text", word, hereString: false };
    }
  }
}

function assignmentOf(
  word: ShellWord,
): { readonly name: string; readonly append: boolean; readonly value: ShellWord } | undefined {
  const first = word.parts[0];
  if (first?.kind !== "text" || first.quoted) return undefined;
  const match = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[[^\]]*\])?(\+?)=/.exec(first.text);
  if (!match) return undefined;
  const rest = first.text.slice(match[0].length);
  const parts: Part[] = rest === "" ? [] : [{ kind: "text", text: rest, quoted: false }];
  return {
    name: match[1]!,
    append: match[2] === "+",
    value: {
      parts: [...parts, ...word.parts.slice(1)],
      raw: word.raw.slice(match[0].length),
      array: word.array,
    },
  };
}

// ---------------------------------------------------------------------------
// Static evaluation: expand each word with what earlier commands assigned, and
// judge the command that runs.

/** A piece of an expanded word: known text, or an expansion the guard cannot resolve. */
interface Segment {
  /** The text, or for a dynamic segment the shell source that stands for it. */
  readonly text: string;
  readonly dynamic: boolean;
  /** For a dynamic segment, the words it was assigned from. */
  readonly mention?: string | undefined;
}
type Field = ReadonlyArray<Segment>;
/** Text a command writes or a word expands to, with whether any of it is unknown. */
interface Output {
  readonly text: string;
  readonly dynamic: boolean;
  readonly mention: string;
}
type Value =
  | { readonly kind: "static"; readonly value: string }
  | { readonly kind: "list"; readonly values: ReadonlyArray<string> }
  | { readonly kind: "dynamic"; readonly text: string; readonly mention: string };
interface Env {
  readonly vars: Map<string, Value>;
  readonly aliases: Map<string, string>;
}
interface CommandContext {
  readonly env: Env;
  readonly depth: number;
  readonly stdin: Output | undefined;
  /** The source of the commands piping into this one, for mentions. */
  readonly upstream: string;
  readonly electron: boolean;
  /** xargs appends arguments the guard cannot see. */
  readonly extraArgs: boolean;
}

const MAX_DEPTH = 8;
const MAX_COMMAND_LENGTH = 100_000;
/** Commands judged and text re-parsed (per 64 characters) before the guard gives up and asks. */
const MAX_STEPS = 50_000;
const RANK: Readonly<Record<StarkPagesPublishVerdict, number>> = {
  none: 0,
  ambiguous: 1,
  publish: 2,
};
const MENTION = /spage|publish|upload|vibecoded-apps|pages(?:-ext)?\.starkfuture\.com/i;
const PAGES_MENTION = /vibecoded-apps|pages(?:-ext)?\.starkfuture\.com/i;
const PROCESS_CALL =
  /child_process|exec|spawn|subprocess|os\.system|popen|Bun\.\$|\$`|Deno\.(?:run|Command)/i;
const UPLOAD_METHOD = /\b(?:PUT|POST|PATCH)\b|upload/i;
const GLOB = /[*?]|\[[^\]]*\]|\{[^{}]*(?:,|\.\.)[^{}]*\}/;
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash", "fish"]);
const INTERPRETER =
  /^(?:node|nodejs|bun|deno|tsx|ts-node|ts-node-esm|esno|electron|python[0-9.]*|pypy[0-9.]*)$/;
const SPAGE_NAME = /^spage(?:\.(?:[cm]?[jt]s|cmd|exe|ps1))?$/;

interface WrapperOptions {
  readonly values: ReadonlySet<string>;
  /** Operands before the command, such as timeout's duration. */
  readonly operands?: number;
}
const wrapper = (values: ReadonlyArray<string>, operands = 0): WrapperOptions => ({
  values: new Set(values),
  operands,
});
/** Commands that run the command after their options, and the options that take a value. */
const WRAPPERS: Readonly<Record<string, WrapperOptions>> = {
  sudo: wrapper([
    "-u",
    "-g",
    "-h",
    "-p",
    "-C",
    "-D",
    "-r",
    "-t",
    "-T",
    "-U",
    "--user",
    "--group",
    "--host",
    "--prompt",
    "--close-from",
    "--chdir",
    "--role",
    "--type",
    "--command-timeout",
    "--other-user",
  ]),
  doas: wrapper(["-u", "-C"]),
  nohup: wrapper([]),
  builtin: wrapper([]),
  command: wrapper([]),
  exec: wrapper(["-a"]),
  time: wrapper(["-f", "-o", "--format", "--output"]),
  nice: wrapper(["-n", "--adjustment"]),
  timeout: wrapper(["-s", "--signal", "-k", "--kill-after"], 1),
  stdbuf: wrapper(["-i", "-o", "-e", "--input", "--output", "--error"]),
  caffeinate: wrapper(["-t", "-w"]),
  chronic: wrapper([]),
};
const ENV_VALUE_OPTIONS = new Set(["-u", "--unset", "-C", "--chdir", "-P", "-a", "--argv0"]);
const PACKAGE_GLOBAL_OPTIONS = new Set([
  "-C",
  "--dir",
  "--prefix",
  "--filter",
  "-F",
  "-w",
  "--workspace",
  "--cwd",
]);
const RUNNER_VALUE_OPTIONS = new Set(["-p", "--package", "-w", "--workspace"]);
const INTERPRETER_VALUE_OPTIONS = new Set([
  "-r",
  "--require",
  "--import",
  "--loader",
  "--experimental-loader",
  "-C",
  "--conditions",
  "--input-type",
  "--title",
  "--env-file",
  "--inspect-port",
  "--cwd",
  "--preload",
  "--config",
  "--tsconfig",
  "-P",
  "--project",
  "-O",
  "--compiler-options",
  "-W",
  "-X",
]);
const XARGS_VALUE_OPTIONS = new Set([
  "-L",
  "-n",
  "-P",
  "-s",
  "-d",
  "-E",
  "--max-lines",
  "--max-args",
  "--max-procs",
  "--max-chars",
  "--delimiter",
  "--eof",
]);

const staticField = (text: string): Field => [{ text, dynamic: false }];
const fieldValue = (field: Field): string | undefined =>
  field.every((segment) => !segment.dynamic)
    ? field.map((segment) => segment.text).join("")
    : undefined;
const fieldText = (field: Field): string => field.map((segment) => segment.text).join("");
const fieldMention = (field: Field): string =>
  field
    .map((segment) =>
      segment.dynamic && segment.mention ? `${segment.text} ${segment.mention}` : segment.text,
    )
    .join("");

/** The last path segment when it is fully known: `$HOME/bin/spage` is `spage`. */
function fieldTail(field: Field): string | undefined {
  let tail = "";
  for (let index = field.length - 1; index >= 0; index--) {
    const segment = field[index]!;
    if (segment.dynamic) return undefined;
    const at = Math.max(segment.text.lastIndexOf("/"), segment.text.lastIndexOf("\\"));
    if (at >= 0) return segment.text.slice(at + 1) + tail;
    tail = segment.text + tail;
  }
  return tail;
}

/** The package or executable a word runs: `@stark/spage@1.2.0`, `npm:spage` and `/kit/spage` are `spage`. */
function executableName(field: Field): string | undefined {
  const tail = fieldTail(field);
  return tail
    ?.replace(/^(?:npm|jsr|node):/i, "")
    .replace(/(?<=.)@[^/@]*$/, "")
    .toLowerCase();
}

/**
 * Input xargs or find puts in place of `{}`: an unresolved variable, so a word
 * holding it stays unresolved when a shell re-parses it (`sh -c '{}'`).
 */
const INPUT_VARIABLE = "STARK_PAGES_GUARD_INPUT";
function withInput(field: Field, token: string, mention: string): Field {
  const text = fieldText(field);
  return text.includes(token)
    ? [{ text: text.replaceAll(token, `\${${INPUT_VARIABLE}}`), dynamic: true, mention }]
    : field;
}
function inputContext(context: CommandContext, mention: string): CommandContext {
  const env = cloneEnv(context.env);
  env.vars.set(INPUT_VARIABLE, { kind: "dynamic", text: `\${${INPUT_VARIABLE}}`, mention });
  return { ...context, env };
}

function joinFields(fields: ReadonlyArray<Field>): Output {
  return {
    text: fields.map(fieldText).join(" "),
    dynamic: fields.some((field) => field.some((segment) => segment.dynamic)),
    mention: fields
      .flatMap((field) => field.filter((segment) => segment.dynamic))
      .map((segment) => segment.mention ?? "")
      .join(" "),
  };
}

const cloneEnv = (env: Env): Env => ({ vars: new Map(env.vars), aliases: new Map(env.aliases) });

function lookup(env: Env, name: string): Value | undefined {
  if (name === "@" || name === "*") return env.vars.get("@");
  if (/^[1-9]\d*$/.test(name)) {
    const positional = env.vars.get("@");
    return positional?.kind === "list"
      ? { kind: "static", value: positional.values[Number(name) - 1] ?? "" }
      : positional;
  }
  const value = env.vars.get(name);
  if (value !== undefined) return value;
  if (name === "SHELL") return { kind: "static", value: "sh" };
  if (name === "BASH") return { kind: "static", value: "bash" };
  return undefined;
}

/** What spage's arguments ask it to do. */
function spageVerdict(args: ReadonlyArray<Field>, extraArgs: boolean): StarkPagesPublishVerdict {
  let maybeValue = false;
  for (const arg of args) {
    const value = fieldValue(arg);
    if (value === undefined) return "ambiguous";
    if (value === "--") continue;
    if (value.startsWith("-") && value.length > 1) {
      maybeValue = !value.includes("=");
      continue;
    }
    if (value === "publish" || value === "upload") return "publish";
    if (!maybeValue) return "none";
    maybeValue = false;
  }
  return extraArgs ? "ambiguous" : "none";
}

function skipOptions(args: ReadonlyArray<Field>, options: WrapperOptions): ReadonlyArray<Field> {
  let index = 0;
  while (index < args.length) {
    const value = fieldValue(args[index]!);
    if (value === undefined) break;
    if (value === "--") {
      index++;
      break;
    }
    if (options.values.has(value)) index += 2;
    else if (value.startsWith("-") && value.length > 1) index++;
    else break;
  }
  return args.slice(index + (options.operands ?? 0));
}

const urlHost = (word: string) =>
  /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^/?#@]*@)?([^/?#:]*)/i.exec(word)?.[1]?.replace(/\.$/, "") ?? "";

const PAGES_HOST =
  /^(?:vibecoded-apps\.s3(?:[.-][a-z0-9.-]*)?|pages\.starkfuture\.com|pages-ext\.starkfuture\.com)$/i;

/** Whether a word, or the value of a `--name=value` word, is a Pages URL. */
function isPagesUrl(word: string): boolean {
  const url = /^--[A-Za-z0-9-]+=/.test(word) ? word.slice(word.indexOf("=") + 1) : word;
  const host = urlHost(url);
  return (
    PAGES_HOST.test(host) ||
    (/^s3[.-][a-z0-9.-]*amazonaws\.com$/i.test(host) &&
      /amazonaws\.com\/vibecoded-apps(?:\/|$)/i.test(url))
  );
}

/** curl short options whose value follows in the same word or the next one. */
const CURL_SHORT_VALUE = new Set("dFHouAebcXTxmwKrECUzYyPDtQ");

/** The value of `--name=value` or `--name value`. */
const longValue = (args: ReadonlyArray<string>, index: number) => {
  const word = args[index]!;
  return word.includes("=") ? word.slice(word.indexOf("=") + 1) : (args[index + 1] ?? "");
};

function curlSendsData(args: ReadonlyArray<string>): boolean {
  for (let index = 0; index < args.length; index++) {
    const word = args[index]!;
    if (/^--(?:upload-file|data[a-z-]*|form[a-z-]*|json)(?:=|$)/.test(word)) return true;
    if (/^--request(?:=|$)/.test(word) && /^(?:PUT|POST|PATCH)$/i.test(longValue(args, index)))
      return true;
    if (!/^-[A-Za-z]/.test(word)) continue;
    // A cluster of short options; the first that takes a value takes the rest of the word.
    for (let at = 1; at < word.length; at++) {
      const flag = word[at]!;
      if (flag === "T" || flag === "d" || flag === "F") return true;
      if (!CURL_SHORT_VALUE.has(flag)) continue;
      const value = at + 1 < word.length ? word.slice(at + 1) : (args[index + 1] ?? "");
      if (flag === "X" && /^(?:PUT|POST|PATCH)$/i.test(value)) return true;
      break;
    }
  }
  return false;
}

const wgetSendsData = (args: ReadonlyArray<string>) =>
  args.some(
    (word, index) =>
      /^--(?:post-data|post-file|body-[a-z-]+)(?:=|$)/.test(word) ||
      (/^--method(?:=|$)/.test(word) && /^(?:PUT|POST|PATCH)$/i.test(longValue(args, index))),
  );

/** printf's output: the format with escapes decoded and conversions filled from the arguments. */
function printfOutput(format: string, args: ReadonlyArray<string>): string {
  const decoded = decodeEscapes(format);
  const conversion = /%(%|[-+ #0]*\d*(?:\.\d+)?[a-zA-Z])/g;
  let output = "";
  let next = 0;
  for (let round = 0; round < 16; round++) {
    output += decoded.replace(conversion, (_match, spec: string) =>
      spec === "%" ? "%" : (args[next++] ?? ""),
    );
    if (next >= args.length || !/%[^%]/.test(decoded)) break;
  }
  return output;
}

/** What a command writes to stdout, when the guard can tell: echo, printf, cat, tee and lookups. */
function commandOutput(
  fields: ReadonlyArray<Field>,
  stdin: Output | undefined,
): Output | undefined {
  let start = 0;
  while (start < fields.length && SHELL_KEYWORDS.has(fieldValue(fields[start]!) ?? "")) start++;
  const head = fields[start];
  const args = fields.slice(start + 1);
  const name = head === undefined ? undefined : executableName(head);
  const options = (pattern: RegExp) => {
    let index = 0;
    while (index < args.length && pattern.test(fieldValue(args[index]!) ?? "")) index++;
    return index;
  };
  switch (name) {
    case "echo": {
      const index = options(/^-[neE]+$/);
      const escapes = args.slice(0, index).some((arg) => fieldText(arg).includes("e"));
      const output = joinFields(args.slice(index));
      return { ...output, text: `${escapes ? decodeEscapes(output.text) : output.text}\n` };
    }
    case "printf": {
      const index = options(/^-/);
      const format = args[index];
      if (format === undefined) return undefined;
      const rest = args.slice(index + 1);
      return {
        ...joinFields(args.slice(index)),
        text: printfOutput(fieldText(format), rest.map(fieldText)),
      };
    }
    case "cat":
    case "tee":
      return name === "tee" || args.every((arg) => fieldValue(arg) === "-") ? stdin : undefined;
    case "which":
    case "realpath":
    case "readlink": {
      const target = args.at(-1);
      return target === undefined
        ? undefined
        : { ...joinFields([target]), text: `${fieldText(target)}\n` };
    }
    case "command":
    case "type": {
      const index = options(/^-[a-zA-Z]+$/);
      const target = args[index];
      return index > 0 && target !== undefined
        ? { ...joinFields([target]), text: `${fieldText(target)}\n` }
        : undefined;
    }
    default:
      return undefined;
  }
}

class PublishAnalysis {
  verdict: StarkPagesPublishVerdict = "none";
  private readonly outputs = new Map<ShellCommand, Output | undefined>();
  private readonly upstreams = new Map<ShellCommand, string>();
  private steps = 0;

  raise(verdict: StarkPagesPublishVerdict): void {
    if (RANK[verdict] > RANK[this.verdict]) this.verdict = verdict;
  }

  /** Counts work; aliases and nested xargs can multiply it, so past the budget the call is ambiguous. */
  private spend(steps: number): boolean {
    this.steps += steps;
    if (this.steps <= MAX_STEPS) return true;
    this.raise("ambiguous");
    return false;
  }

  runSource(source: string, env: Env, depth: number): Output | undefined {
    if (!this.spend(Math.ceil(source.length / 64))) return undefined;
    if (depth > MAX_DEPTH) {
      this.raise("ambiguous");
      return undefined;
    }
    return this.runScript(new ShellParser(source, 0, 0).script(false), env, depth);
  }

  /** Runs each command; returns the output of a script that is a single command. */
  runScript(script: ShellScript, env: Env, depth: number): Output | undefined {
    if (script.tooDeep || depth > MAX_DEPTH) this.raise("ambiguous");
    if (depth > MAX_DEPTH) return undefined;
    let output: Output | undefined;
    for (const command of script.commands) output = this.runCommand(command, env, depth);
    return script.commands.length === 1 ? output : undefined;
  }

  private runCommand(command: ShellCommand, env: Env, depth: number): Output | undefined {
    if (this.verdict === "publish" || !this.spend(1)) return undefined;
    let stdin: Output | undefined;
    let upstream = "";
    const source = command.stdin;
    if (source?.kind === "text") {
      const body = this.joined(source.word, env, depth);
      stdin = source.hereString ? { ...body, text: `${body.text}\n` } : body;
      upstream = `${body.text} ${body.mention}`;
    } else if (source?.kind === "pipe") {
      stdin = this.outputs.get(source.from);
      upstream = `${source.from.raw} ${this.upstreams.get(source.from) ?? ""}`;
    }
    this.upstreams.set(command, upstream);
    for (const target of command.redirects) this.expand(target, env, depth, false);

    let index = 0;
    const assigned: Array<readonly [string, Value]> = [];
    for (; index < command.words.length; index++) {
      const assignment = assignmentOf(command.words[index]!);
      if (assignment === undefined) break;
      assigned.push([assignment.name, this.assignedValue(assignment, env, depth)]);
    }
    const words = command.words.slice(index);
    const alias = words[0] === undefined ? undefined : plainText(words[0]);
    const aliasValue = alias === undefined ? undefined : env.aliases.get(alias);
    if (alias !== undefined && aliasValue !== undefined) {
      const inner = cloneEnv(env);
      inner.aliases.delete(alias);
      this.runSource(
        [aliasValue, ...words.slice(1).map((word) => word.raw)].join(" "),
        inner,
        depth + 1,
      );
      this.outputs.set(command, undefined);
      return undefined;
    }
    const fields = words.flatMap((word) => this.expand(word, env, depth, true));
    if (fields.length === 0) {
      for (const [name, value] of assigned) env.vars.set(name, value);
      this.outputs.set(command, undefined);
      return undefined;
    }
    const context: CommandContext = {
      env,
      depth,
      stdin,
      upstream,
      electron:
        env.vars.has("ELECTRON_RUN_AS_NODE") ||
        assigned.some(([name]) => name === "ELECTRON_RUN_AS_NODE"),
      extraArgs: false,
    };
    this.command(fields, context);
    this.sideEffects(fields, context);
    const output = commandOutput(fields, stdin);
    this.outputs.set(command, output);
    return output;
  }

  private assignedValue(
    assignment: NonNullable<ReturnType<typeof assignmentOf>>,
    env: Env,
    depth: number,
  ): Value {
    if (assignment.value.array !== undefined) {
      const fields = assignment.value.array.flatMap((word) => this.expand(word, env, depth, true));
      if (fields.every((field) => fieldValue(field) !== undefined)) {
        return { kind: "list", values: fields.map(fieldText) };
      }
      const joined = joinFields(fields);
      return { kind: "dynamic", text: joined.text, mention: joined.mention };
    }
    const value = this.joined(assignment.value, env, depth);
    const previous = assignment.append ? env.vars.get(assignment.name) : undefined;
    if (previous !== undefined && previous.kind !== "static") {
      return { kind: "dynamic", text: value.text, mention: `${value.text} ${value.mention}` };
    }
    const text = (previous?.value ?? "") + value.text;
    return value.dynamic
      ? { kind: "dynamic", text, mention: `${text} ${value.mention}` }
      : { kind: "static", value: text };
  }

  private joined(word: ShellWord, env: Env, depth: number): Output {
    return joinFields(this.expand(word, env, depth, false));
  }

  /** Expands a word into fields; `split` applies word splitting and globbing as for a command's words. */
  private expand(word: ShellWord, env: Env, depth: number, split: boolean): Field[] {
    const fields: Segment[][] = [];
    let current: Segment[] = [];
    let keep = false;
    const close = () => {
      if (current.length > 0 || keep) fields.push(current);
      current = [];
      keep = false;
    };
    const add = (text: string, quoted: boolean) => {
      if (!split || quoted) {
        current.push({ text, dynamic: false });
        keep = true;
        return;
      }
      text.split(/[ \t\n]+/).forEach((piece, index) => {
        if (index > 0) close();
        if (piece !== "") current.push({ text: piece, dynamic: false });
      });
    };
    for (const part of word.parts) {
      if (part.kind === "text") {
        current.push({ text: part.text, dynamic: split && !part.quoted && GLOB.test(part.text) });
        keep = true;
      } else if (part.kind === "param") {
        const value = this.param(part, env, depth);
        if (value.kind === "static") add(value.value, part.quoted);
        else if (value.kind === "list") {
          value.values.forEach((item, index) => {
            if (index > 0) close();
            add(item, part.quoted);
          });
        } else {
          current.push({ text: value.text, dynamic: true, mention: value.mention });
          keep = true;
        }
      } else if (part.kind === "command") {
        const output = this.runScript(part.script, cloneEnv(env), depth + 1);
        const text = output?.text.replace(/\n+$/, "");
        if (output !== undefined && text !== undefined && !output.dynamic) add(text, part.quoted);
        else {
          current.push({
            text: text ?? part.raw,
            dynamic: true,
            mention: `${output?.mention ?? ""} ${part.raw}`,
          });
          keep = true;
        }
      } else {
        for (const script of part.scripts) this.runScript(script, cloneEnv(env), depth + 1);
        for (const inner of part.words) this.expand(inner, env, depth, false);
        current.push({ text: part.raw, dynamic: true, mention: part.raw });
        keep = true;
      }
    }
    close();
    return fields;
  }

  private param(part: ParamPart, env: Env, depth: number): Value {
    const arg = part.arg === undefined ? undefined : this.joined(part.arg, env, depth);
    const known = lookup(env, part.name);
    const plain = part.op === "" && part.index === undefined && part.prefix === "";
    const unresolved = (): Value => ({
      kind: "dynamic",
      text: known?.kind === "dynamic" && plain ? known.text : part.raw,
      mention: [
        known?.kind === "dynamic" ? known.mention : "",
        arg === undefined ? "" : `${arg.text} ${arg.mention}`,
      ].join(" "),
    });
    if (part.prefix !== "" || part.name === "" || known === undefined) return unresolved();
    if (part.index !== undefined) {
      if (part.op !== "" || (part.index !== "@" && part.index !== "*")) return unresolved();
      if (known.kind === "list" && part.index === "*" && part.quoted) {
        return { kind: "static", value: known.values.join(" ") };
      }
      return known.kind === "dynamic" ? unresolved() : known;
    }
    if (known.kind === "dynamic") return unresolved();
    const set = known.kind === "static" ? known.value !== "" : known.values.length > 0;
    switch (part.op) {
      case "":
      case "?":
      case ":?":
        return known.kind === "list" && part.name === "*" && part.quoted
          ? { kind: "static", value: known.values.join(" ") }
          : known;
      case "-":
      case "=":
        return known;
      case ":-":
      case ":=":
        if (set) return known;
        return arg !== undefined && !arg.dynamic
          ? { kind: "static", value: arg.text }
          : unresolved();
      case "+":
      case ":+":
        if (!set && part.op === ":+") return { kind: "static", value: "" };
        return arg !== undefined && !arg.dynamic
          ? { kind: "static", value: arg.text }
          : unresolved();
      default:
        return unresolved();
    }
  }

  /** Ambiguous when the unresolved command mentions spage, publishing or a Pages host. */
  private unresolved(fields: ReadonlyArray<Field>, context: CommandContext): void {
    if (MENTION.test(`${fields.map(fieldMention).join(" ")} ${context.upstream}`)) {
      this.raise("ambiguous");
    }
  }

  /** Judges the command that runs, after its keywords, prefixes and wrappers. */
  private command(input: ReadonlyArray<Field>, context: CommandContext): void {
    let fields = input;
    let electron = context.electron;
    for (let guard = 0; guard < 64 && fields.length > 0; guard++) {
      if (this.verdict === "publish" || !this.spend(1)) return;
      const head = fields[0]!;
      const value = fieldValue(head);
      if (value !== undefined && SHELL_KEYWORDS.has(value)) {
        fields = fields.slice(1);
        continue;
      }
      if (value === "function") {
        fields = fields.slice(2);
        continue;
      }
      if (ASSIGNMENT.test(fieldText(head))) {
        electron ||= fieldText(head).startsWith("ELECTRON_RUN_AS_NODE=");
        fields = fields.slice(1);
        continue;
      }
      const name = executableName(head);
      if (name === undefined) {
        this.unresolved(fields, context);
        return;
      }
      const args = fields.slice(1);
      if (SPAGE_NAME.test(name)) {
        this.raise(spageVerdict(args, context.extraArgs));
        return;
      }
      if (SHELLS.has(name)) {
        this.shell(args, context);
        return;
      }
      if (name === "eval") {
        this.runSource(args.map(fieldText).join(" "), context.env, context.depth + 1);
        return;
      }
      if (name === "find") {
        this.find(args, context);
        return;
      }
      if (name === "curl" || name === "wget" || name === "wget2") {
        this.upload(name, args);
        return;
      }
      if (name === "xargs") {
        this.xargs(args, context);
        return;
      }
      if (name === "watch") {
        const watched = this.watch(args, context);
        if (watched === undefined) return;
        fields = watched;
        continue;
      }
      if (name === "env") {
        const run = this.env(args, context);
        electron ||= run.electron;
        fields = run.fields;
        continue;
      }
      if (name === "command" && /^-[A-Za-z]*[vV]/.test(fieldValue(args[0] ?? []) ?? "")) return;
      const options = Object.hasOwn(WRAPPERS, name) ? WRAPPERS[name] : undefined;
      if (options !== undefined) {
        fields = skipOptions(args, options);
        continue;
      }
      const runner = this.packageRunner(name, args, context);
      if (runner === "handled") return;
      if (runner !== undefined) {
        fields = runner;
        continue;
      }
      if (INTERPRETER.test(name) || electron) this.interpreter(name, args, context);
      return;
    }
  }

  private env(
    args: ReadonlyArray<Field>,
    context: CommandContext,
  ): { readonly fields: ReadonlyArray<Field>; readonly electron: boolean } {
    let queue = args;
    let electron = false;
    for (let guard = 0; guard < 64 && queue.length > 0; guard++) {
      const value = fieldValue(queue[0]!);
      if (value === undefined) break;
      if (value === "--") {
        queue = queue.slice(1);
        break;
      }
      if (ASSIGNMENT.test(value)) {
        electron ||= value.startsWith("ELECTRON_RUN_AS_NODE=");
        queue = queue.slice(1);
        continue;
      }
      const split =
        /^-[iv0]*S([\s\S]*)$/.exec(value) ?? /^--split-string(?:=([\s\S]*))?$/.exec(value);
      if (split) {
        const inline = split[1] ?? "";
        const text = inline !== "" ? inline : queue[1] === undefined ? "" : fieldText(queue[1]);
        queue = [...this.splitWords(text, context), ...queue.slice(inline !== "" ? 1 : 2)];
        continue;
      }
      if (ENV_VALUE_OPTIONS.has(value)) queue = queue.slice(2);
      else if (value.startsWith("-")) queue = queue.slice(1);
      else break;
    }
    return { fields: queue, electron };
  }

  /** `env -S` splitting: the string's words, quotes and expansions applied. */
  private splitWords(text: string, context: CommandContext): Field[] {
    return new ShellParser(text, 0, 0)
      .script(false)
      .commands.flatMap((command) => command.words)
      .flatMap((word) => this.expand(word, context.env, context.depth + 1, true));
  }

  /** watch runs its arguments through `sh -c`, or directly with -x. */
  private watch(
    args: ReadonlyArray<Field>,
    context: CommandContext,
  ): ReadonlyArray<Field> | undefined {
    let index = 0;
    let exec = false;
    while (index < args.length) {
      const value = fieldValue(args[index]!);
      if (value === undefined) break;
      if (value === "-x" || value === "--exec") {
        exec = true;
        index++;
      } else if (value === "-n" || value === "--interval") index += 2;
      else if (value.startsWith("-")) index++;
      else break;
    }
    const rest = args.slice(index);
    if (exec) return rest;
    this.runSource(rest.map(fieldText).join(" "), cloneEnv(context.env), context.depth + 1);
    return undefined;
  }

  private packageRunner(
    name: string,
    args: ReadonlyArray<Field>,
    context: CommandContext,
  ): ReadonlyArray<Field> | "handled" | undefined {
    let rest = args;
    if (name === "npm" || name === "pnpm" || name === "yarn" || name === "bun") {
      let index = 0;
      while (index < rest.length) {
        const value = fieldValue(rest[index]!) ?? "";
        if (PACKAGE_GLOBAL_OPTIONS.has(value)) index += 2;
        else if (value.startsWith("-")) index++;
        else break;
      }
      rest = rest.slice(index);
      const subcommand = fieldValue(rest[0] ?? []);
      const runs =
        (name === "npm" && (subcommand === "exec" || subcommand === "x")) ||
        ((name === "pnpm" || name === "yarn") && (subcommand === "exec" || subcommand === "dlx")) ||
        (name === "bun" && subcommand === "x");
      if (!runs) {
        const bin = rest[0] === undefined ? undefined : executableName(rest[0]);
        return (name === "pnpm" || name === "yarn") && bin !== undefined && SPAGE_NAME.test(bin)
          ? rest
          : undefined;
      }
      rest = rest.slice(1);
    } else if (name !== "npx" && name !== "bunx" && name !== "pnpx") return undefined;
    let index = 0;
    while (index < rest.length) {
      const value = fieldValue(rest[index]!);
      if (value === undefined) break;
      if (value === "--") {
        index++;
        break;
      }
      const call = /^--call=([\s\S]*)$/.exec(value);
      if (call || value === "-c" || value === "--call") {
        const script =
          call?.[1] ?? (rest[index + 1] === undefined ? "" : fieldText(rest[index + 1]!));
        this.runSource(script, cloneEnv(context.env), context.depth + 1);
        return "handled";
      }
      if (RUNNER_VALUE_OPTIONS.has(value)) index += 2;
      else if (value.startsWith("-")) index++;
      else break;
    }
    return rest.slice(index);
  }

  private shell(args: ReadonlyArray<Field>, context: CommandContext): void {
    let index = 0;
    let command = false;
    let fromStdin = false;
    while (index < args.length) {
      const value = fieldValue(args[index]!);
      if (value === undefined) break;
      if (value === "--" || value === "-") {
        fromStdin = value === "-";
        index++;
        break;
      }
      const inline = /^--command=([\s\S]*)$/.exec(value);
      if (inline) {
        this.runSource(inline[1]!, cloneEnv(context.env), context.depth + 1);
        return;
      }
      if (/^[-+][oO]$/.test(value) || /^--(?:rcfile|init-file|init-command)$/.test(value)) {
        index += 2;
        continue;
      }
      if (value === "--command" || /^-[A-Za-z]*c[A-Za-z]*$/.test(value)) command = true;
      else if (/^-[A-Za-z]*s[A-Za-z]*$/.test(value)) fromStdin = true;
      else if (!/^[-+]/.test(value)) break;
      index++;
    }
    const operand = args[index];
    if (command) {
      if (operand !== undefined) {
        this.runSource(fieldText(operand), cloneEnv(context.env), context.depth + 1);
      } else if (context.extraArgs) this.unresolved(args, context);
      return;
    }
    if (operand === undefined || fromStdin) {
      if (context.stdin !== undefined) {
        this.runSource(context.stdin.text, cloneEnv(context.env), context.depth + 1);
      } else if (MENTION.test(context.upstream)) this.raise("ambiguous");
      return;
    }
    const script = executableName(operand);
    if (script === undefined) this.unresolved(args.slice(index), context);
    else if (SPAGE_NAME.test(script))
      this.raise(spageVerdict(args.slice(index + 1), context.extraArgs));
  }

  /** Code an interpreter runs inline: ambiguous when it names a publish and a way to run it. */
  private inlineCode(code: string): void {
    if (
      (/spage/i.test(code) && /publish|upload/i.test(code) && PROCESS_CALL.test(code)) ||
      (PAGES_MENTION.test(code) && UPLOAD_METHOD.test(code))
    ) {
      this.raise("ambiguous");
    }
  }

  private interpreter(name: string, args: ReadonlyArray<Field>, context: CommandContext): void {
    const python = /^(?:python|pypy)/.test(name);
    const inline = python ? new Set(["-c"]) : new Set(["-e", "--eval", "-p", "--print"]);
    let index = 0;
    const first = fieldValue(args[0] ?? []);
    if ((name === "bun" || name === "deno") && first === "run") index = 1;
    if (name === "deno" && first === "eval") {
      this.inlineCode(args.slice(1).map(fieldMention).join(" "));
      return;
    }
    while (index < args.length) {
      const value = fieldValue(args[index]!);
      if (value === undefined) break;
      if (value === "--") {
        index++;
        break;
      }
      const attached = /^--(?:eval|print)=([\s\S]*)$/.exec(value);
      if (attached || inline.has(value)) {
        this.inlineCode(attached?.[1] ?? fieldMention(args[index + 1] ?? []));
        return;
      }
      if (value === "-") {
        if (context.stdin !== undefined)
          this.inlineCode(`${context.stdin.text} ${context.stdin.mention}`);
        return;
      }
      if (python && value === "-m") {
        index++;
        break;
      }
      if (INTERPRETER_VALUE_OPTIONS.has(value)) index += 2;
      else if (value.startsWith("-")) index++;
      else break;
    }
    const script = args[index];
    if (script === undefined) {
      if (context.stdin !== undefined)
        this.inlineCode(`${context.stdin.text} ${context.stdin.mention}`);
      return;
    }
    const scriptName = executableName(script);
    if (scriptName === undefined) this.unresolved(args.slice(index), context);
    else if (SPAGE_NAME.test(scriptName)) {
      this.raise(spageVerdict(args.slice(index + 1), context.extraArgs));
    }
  }

  private xargs(args: ReadonlyArray<Field>, context: CommandContext): void {
    let index = 0;
    let replace: string | undefined;
    let fromFile = false;
    while (index < args.length) {
      const value = fieldValue(args[index]!);
      if (value === undefined) break;
      if (value === "--") {
        index++;
        break;
      }
      const attached = /^-I([\s\S]+)$|^-i([\s\S]*)$|^--replace(?:=([\s\S]*))?$/.exec(value);
      if (value === "-I") {
        replace = fieldValue(args[index + 1] ?? []) ?? "{}";
        index += 2;
      } else if (attached) {
        replace = attached[1] ?? (attached[2] || attached[3] || "{}");
        index++;
      } else if (value === "-a" || value === "--arg-file") {
        fromFile = true;
        index += 2;
      } else if (value.startsWith("--arg-file=")) {
        fromFile = true;
        index++;
      } else if (XARGS_VALUE_OPTIONS.has(value)) index += 2;
      else if (value.startsWith("-")) index++;
      else break;
    }
    const command = args.slice(index);
    if (command.length === 0) return;
    const input = fromFile ? undefined : context.stdin;
    const nested: CommandContext = { ...context, stdin: undefined };
    if (input !== undefined && !input.dynamic) {
      if (replace === undefined) {
        const items = input.text.split(/\s+/).filter(Boolean).slice(0, 256).map(staticField);
        this.command([...command, ...items], nested);
        return;
      }
      const token = replace;
      for (const line of input.text.split("\n").filter(Boolean).slice(0, 16)) {
        this.command(
          command.map((field) =>
            fieldText(field).includes(token) && fieldValue(field) !== undefined
              ? staticField(fieldText(field).replaceAll(token, line))
              : field,
          ),
          nested,
        );
      }
      return;
    }
    if (replace === undefined) {
      this.command(command, { ...nested, extraArgs: true });
      return;
    }
    const token = replace;
    this.command(
      command.map((field) => withInput(field, token, context.upstream)),
      inputContext(nested, context.upstream),
    );
  }

  /** find -exec, -execdir, -ok and -okdir run the words up to `;` or `{} +`. */
  private find(args: ReadonlyArray<Field>, context: CommandContext): void {
    for (let index = 0; index < args.length; index++) {
      if (!/^-(?:exec|execdir|ok|okdir)$/.test(fieldValue(args[index]!) ?? "")) continue;
      const command: Field[] = [];
      let end = index + 1;
      for (; end < args.length; end++) {
        const value = fieldValue(args[end]!);
        if (value === ";" || (value === "+" && fieldText(command.at(-1) ?? []) === "{}")) break;
        command.push(withInput(args[end]!, "{}", ""));
      }
      this.command(command, inputContext({ ...context, stdin: undefined, upstream: "" }, ""));
      index = end;
    }
  }

  /** curl or wget: a publish when it sends data to a Pages host. */
  private upload(name: string, args: ReadonlyArray<Field>): void {
    let pages = 0;
    let sends = 0;
    for (const arg of args) {
      const text = fieldText(arg);
      if (isPagesUrl(text)) pages = 2;
      else if (fieldValue(arg) === undefined) {
        // An unresolved word may be the URL or an option that sends data.
        pages = Math.max(pages, 1);
        sends = Math.max(sends, 1);
      }
    }
    const texts = args.map(fieldText);
    if (name === "curl" ? curlSendsData(texts) : wgetSendsData(texts)) sends = 2;
    if (name === "curl" && texts.some((text) => /^(?:-K|--config(?:=|$))/.test(text))) {
      sends = Math.max(sends, 1);
      pages = Math.max(pages, 1);
    }
    if (sends === 2 && pages === 2) this.raise("publish");
    else if (sends > 0 && pages > 0 && PAGES_MENTION.test(args.map(fieldMention).join(" "))) {
      this.raise("ambiguous");
    }
  }

  /** Assignments a builtin makes: export/declare/local, read, for, unset, alias and set. */
  private sideEffects(fields: ReadonlyArray<Field>, context: CommandContext): void {
    let start = 0;
    while (start < fields.length && SHELL_KEYWORDS.has(fieldValue(fields[start]!) ?? "")) start++;
    const head = fieldValue(fields[start] ?? []);
    const args = fields.slice(start + 1);
    const vars = context.env.vars;
    const dynamic = (name: string, mention: string): Value => ({
      kind: "dynamic",
      text: `\${${name}}`,
      mention,
    });
    switch (head) {
      case "export":
      case "declare":
      case "typeset":
      case "local":
      case "readonly":
        for (const arg of args) {
          const match = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(fieldText(arg));
          if (!match) continue;
          vars.set(
            match[1]!,
            fieldValue(arg) === undefined
              ? { kind: "dynamic", text: match[2]!, mention: fieldMention(arg) }
              : { kind: "static", value: match[2]! },
          );
        }
        return;
      case "read": {
        const mention =
          context.stdin === undefined
            ? context.upstream
            : `${context.stdin.text} ${context.stdin.mention}`;
        for (const arg of args) {
          const name = fieldValue(arg);
          if (name !== undefined && IDENTIFIER.test(name)) vars.set(name, dynamic(name, mention));
        }
        return;
      }
      case "for":
      case "select": {
        const name = fieldValue(args[0] ?? []);
        if (name !== undefined && IDENTIFIER.test(name)) {
          vars.set(name, dynamic(name, args.slice(1).map(fieldMention).join(" ")));
        }
        return;
      }
      case "unset":
        for (const arg of args) {
          const name = fieldValue(arg);
          if (name !== undefined && IDENTIFIER.test(name))
            vars.set(name, { kind: "static", value: "" });
        }
        return;
      case "alias":
        for (const arg of args) {
          const match = /^([^=\s]+)=([\s\S]*)$/.exec(fieldValue(arg) ?? "");
          if (match) context.env.aliases.set(match[1]!, match[2]!);
        }
        return;
      case "set": {
        const first = fieldValue(args[0] ?? []);
        if (first === undefined || (first !== "--" && /^[-+]/.test(first))) return;
        const items = args.slice(first === "--" ? 1 : 0);
        vars.set(
          "@",
          items.every((item) => fieldValue(item) !== undefined)
            ? { kind: "list", values: items.map(fieldText) }
            : dynamic("@", items.map(fieldMention).join(" ")),
        );
        return;
      }
      default:
        return;
    }
  }
}

/** The verdict for a shell command line. */
function shellCommandVerdict(command: string): StarkPagesPublishVerdict {
  if (command.length > MAX_COMMAND_LENGTH) return "ambiguous";
  const analysis = new PublishAnalysis();
  try {
    analysis.runSource(command, { vars: new Map(), aliases: new Map() }, 0);
  } catch {
    // A command the guard cannot read to the end is put to the user.
    analysis.raise("ambiguous");
  }
  return analysis.verdict;
}

/** The shell text a shell tool runs: a command string, or an argv array quoted word by word. */
function shellScriptOf(toolInput: unknown): string | undefined {
  if (typeof toolInput === "string") return toolInput;
  if (typeof toolInput !== "object" || toolInput === null) return undefined;
  const command = Reflect.get(toolInput, "command");
  if (typeof command === "string") return command;
  if (Array.isArray(command) && command.every((part) => typeof part === "string")) {
    return command.map((part) => `'${part.replaceAll("'", "'\\''")}'`).join(" ");
  }
  return undefined;
}

/** How a tool call relates to Stark Pages publishing (the StarkPagesGuard check). */
export function starkPagesPublishVerdict(input: StarkPagesToolCall): StarkPagesPublishVerdict {
  if (
    isPagesWrite(mcpPagesTool(input.toolName, input.mcpServer !== undefined)) ||
    isPagesWrite(proxiedPagesTool(input.toolInput))
  )
    return "publish";
  if (!SHELL_COMMAND_TOOLS.has(input.toolName.toLowerCase())) return "none";
  const script = shellScriptOf(input.toolInput);
  return script === undefined ? "none" : shellCommandVerdict(script);
}

/** Whether a tool call publishes to Stark Pages: the calls an SDK chat denies. */
export const isStarkPagesPublish = (input: StarkPagesToolCall): boolean =>
  starkPagesPublishVerdict(input) === "publish";

/**
 * Whether a tool call publishes or may publish to Stark Pages: the calls that
 * never get a remembered, session or always allow.
 */
export const mayPublishToStarkPages = (input: StarkPagesToolCall): boolean =>
  starkPagesPublishVerdict(input) !== "none";
