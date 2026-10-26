import { parse, type Command, type PipelineNode, type Word, type WordPart } from "unbash";

export interface ApprovalExplanationStep {
  readonly command: string;
  readonly explanation: string;
  readonly caution: boolean;
  readonly unknown: boolean;
}

export interface ApprovalExplanation {
  readonly steps: readonly ApprovalExplanationStep[];
  readonly notes: readonly string[];
}

const MAX_LENGTH = 8_192;
const MAX_STEPS = 6;
const UNKNOWN = "This app cannot reliably explain this command. Review the original command.";
export const APPROVAL_EXPLANATION_LIMIT =
  "Based on command text only. Aliases, configuration, hooks and scripts may do more. Affected files have not been checked.";

function isLiteralPart(part: WordPart): boolean {
  if (part.type === "SingleQuoted" || part.type === "AnsiCQuoted") return true;
  if (part.type === "DoubleQuoted") return part.parts.every((child) => child.type === "Literal");
  // Globs/tilde are shell expansions even though the parser represents them as literals.
  return part.type === "Literal" && !/[*?[\]]|^~/u.test(part.text);
}

function literal(word: Word): string | undefined {
  return word.parts
    ? word.parts.every(isLiteralPart)
      ? word.value
      : undefined
    : /[*?[\]]|^~/u.test(word.text)
      ? undefined
      : word.value;
}

function programName(value: string): string {
  return value.replace(/^\/(?:usr\/)?bin\//u, "");
}

function cleanRequestsPreview(args: readonly string[]): boolean {
  let preview = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--") break;
    if (arg === "-e" || arg === "--exclude") {
      // An exclusion value beginning with -n is still a value, not dry-run.
      if (!args[++index]) return false;
    } else if (arg.startsWith("--exclude=") || /^-e./u.test(arg)) {
      continue;
    } else if (arg === "--dry-run") {
      preview = true;
    } else if (/^-[dfinqxX]+$/u.test(arg)) {
      preview ||= arg.includes("n");
    } else if (arg.startsWith("-") && !["--force", "--quiet", "--interactive"].includes(arg)) {
      return false;
    }
  }
  return preview;
}

function explainKnown(words: readonly string[]): Omit<ApprovalExplanationStep, "command"> {
  const name = programName(words[0] ?? "");
  let args = words.slice(1);
  const known = (explanation: string, caution = false) => ({
    explanation,
    caution,
    unknown: false,
  });
  const unknown = () => ({ explanation: UNKNOWN, caution: false, unknown: true });
  if (name === "rm") {
    return known(
      "Deletes the selected files or folders without moving them to the Trash. Recursive flags also delete their contents.",
      true,
    );
  }
  if (name === "rmdir") return known("Deletes the selected directories if they are empty.", true);
  if (name === "mv") {
    return known(
      "Moves or renames files or folders. An existing destination may be overwritten.",
      true,
    );
  }
  if (name !== "git") return unknown();
  // Only consume unambiguous location options. -c, --exec-path and other overrides
  // can change what runs; guessing which word is the subcommand would be misleading.
  while (args[0] === "-C") {
    if (!args[1]) return unknown();
    args = args.slice(2);
  }
  const operation = args[0];
  const rest = args.slice(1);
  const separator = rest.indexOf("--");
  const options = separator < 0 ? rest : rest.slice(0, separator);
  const has = (...flags: string[]) => flags.some((flag) => options.includes(flag));
  const short = (flag: string) =>
    options.some((option) => /^-[^-]/u.test(option) && option.includes(flag));
  if (operation === "diff" || operation === "log" || operation === "show") {
    if (options.some((option) => option === "--output" || option.startsWith("--output="))) {
      return known(
        "Shows Git differences or history and writes output to a file. Existing file contents may be overwritten.",
        true,
      );
    }
    if (has("--ext-diff", "--textconv")) {
      return known(
        "Shows Git differences or history using configured external tools. Those tools can run additional code.",
        true,
      );
    }
  }
  if (operation === "status")
    return known("Shows which files Git considers changed, staged or untracked.");
  if (operation === "diff")
    return known("Shows differences between files, staged changes or commits.");
  if (operation === "log" || operation === "show")
    return known("Shows Git history or the selected Git objects.");
  if (operation === "add") return known("Stages file changes for a later commit.");
  if (operation === "commit")
    return known("Creates or replaces a local Git commit. Commit hooks may also run.");
  if (operation === "push") {
    return known(
      "Sends commits or reference changes to a remote repository. Force or delete flags can replace or remove remote history.",
      true,
    );
  }
  if (operation === "restore") {
    if (has("--staged", "-S") && !has("--worktree", "-W") && !short("W")) {
      return known(
        "Replaces the staged version of the selected paths; the working files are not the target of this restore.",
      );
    }
    return known(
      "Replaces selected working files with a Git version. Uncommitted edits in those files can be lost.",
      true,
    );
  }
  if (operation === "reset") {
    if (has("--hard"))
      return known(
        "Resets Git history, staging and working files to the selected commit. Uncommitted changes can be lost, and obstructing untracked files may be deleted.",
        true,
      );
    if (has("--soft"))
      return known(
        "Moves the current Git branch to the selected commit while retaining staged and working changes.",
      );
    if (has("--mixed") || options.every((arg) => !arg.startsWith("-"))) {
      return known(
        "Resets Git staging, and may move the current branch to a selected commit. Review the revision and paths.",
      );
    }
    return unknown();
  }
  if (operation === "checkout") {
    if (has("--force", "-f") || short("f") || separator >= 0) {
      return known(
        "Checks out a Git version or selected paths. This form can overwrite working files and discard uncommitted edits.",
        true,
      );
    }
    return known(
      "Switches branches or restores paths, depending on the arguments. Restoring paths can discard uncommitted edits.",
      true,
    );
  }
  if (operation === "clean") {
    if (cleanRequestsPreview(rest))
      return known("Requests a preview of untracked files Git would delete.");
    return known(
      "Deletes untracked files. Directory flags include folders; -x also includes ignored files. Git may have no copy to restore.",
      true,
    );
  }
  if (operation === "rm") {
    return has("--cached")
      ? known("Removes selected paths from Git staging/tracking while leaving the working files.")
      : known(
          "Removes selected tracked files from the working folder and stages their deletion.",
          true,
        );
  }
  if (operation === "branch" && (has("--delete", "-d", "-D") || short("D") || short("d"))) {
    return known(
      "Deletes local branches. Forced deletion can remove a branch whose work has not been merged.",
      true,
    );
  }
  return unknown();
}

/**
 * Informational, never a permission policy. No execution, filesystem inspection,
 * expansion or model calls. Opaque syntax stays opaque; we never assign a safe label.
 */
export function explainApprovalCommand(source: string | undefined): ApprovalExplanation {
  const steps: ApprovalExplanationStep[] = [];
  const notes = new Set<string>();
  const writeNotes = new Set<string>();
  const unknown = (command: string, explanation = UNKNOWN) => {
    if (steps.length < MAX_STEPS)
      steps.push({ command, explanation, caution: false, unknown: true });
    else notes.add("More command parts are present. Review the complete original command.");
  };
  if (!source?.trim()) {
    unknown("", "Command details are unavailable. Review the request before deciding.");
    return { steps, notes: [] };
  }
  if (source.length > MAX_LENGTH) {
    unknown(
      "",
      "This command is too long to explain reliably. Review the complete original command.",
    );
    return { steps, notes: [] };
  }
  const command = (node: Command, text: string, depth: number) => {
    const raw = text.slice(node.pos, node.end);
    if (steps.length >= MAX_STEPS) {
      notes.add("More command parts are present. Review the complete original command.");
      return;
    }
    const name = node.name ? literal(node.name) : undefined;
    const args = node.args.map((arg) => (arg.type === "Word" ? literal(arg) : undefined));
    if (node.prefix.some((part) => part.type === "Assignment")) {
      notes.add("Environment assignments may change the command's behavior.");
    }
    for (const redirect of node.redirects) {
      if (redirect.type !== "Redirect") {
        notes.add("Embedded input is not explained; it may be interpreted as commands.");
        continue;
      }
      if ([">", ">|", "&>", "<>"].includes(redirect.operator)) {
        writeNotes.add("Output redirection can create or overwrite a file.");
      } else if ([">>", "&>>"].includes(redirect.operator)) {
        writeNotes.add("Output redirection appends to or creates a file.");
      } else if (redirect.operator === ">&" || redirect.operator === "<&") {
        notes.add("File descriptor redirection changes where input or output goes.");
      }
      if (redirect.target && literal(redirect.target) === undefined) {
        notes.add("A redirection target is computed by the shell and may run other commands.");
      }
    }
    if (!name || args.some((arg) => arg === undefined)) {
      const deletion = name && ["rm", "rmdir"].includes(programName(name));
      steps.push({
        command: raw,
        explanation: deletion
          ? "Deletes files or folders. Shell expansions determine the targets and may run other commands; their effect is unknown."
          : "Shell expansions or assignments prevent a reliable explanation and may run other commands.",
        caution: Boolean(deletion),
        unknown: true,
      });
      return;
    }
    const values = args as string[];
    if (
      ["sh", "bash", "zsh"].includes(programName(name)) &&
      values.length === 2 &&
      /^-(?:[il]*c|c[il]*)$/u.test(values[0]!) &&
      depth < 2
    ) {
      notes.add("The shell's startup settings may also run commands.");
      visitScript(values[1]!, depth + 1);
      return;
    }
    steps.push({ command: raw, ...explainKnown([name, ...values]) });
  };
  const visit = (node: PipelineNode, text: string, depth: number) => {
    if (node.type === "Command") command(node, text, depth);
    else if (node.type === "Pipeline") {
      notes.add("These commands form a pipeline; output from one becomes input to another.");
      for (const child of node.commands) visit(child, text, depth);
    } else
      unknown(
        text.slice(node.pos, node.end),
        "This shell construct is not explained. It may run additional commands.",
      );
  };
  const visitScript = (text: string, depth: number) => {
    const parsed = parse(text);
    if (parsed.errors?.length) {
      unknown(text, "This command could not be parsed reliably. Review the original command.");
      return;
    }
    for (const statement of parsed.commands) {
      if (statement.background) notes.add("A command is launched in the background.");
      if (statement.command.type === "AndOr") {
        notes.add("Later commands run conditionally, depending on earlier exit codes.");
        for (const child of statement.command.commands) visit(child, text, depth);
      } else visit(statement.command, text, depth);
    }
  };
  try {
    visitScript(source, 0);
  } catch {
    return {
      steps: [
        {
          command: "",
          explanation: "This command could not be parsed reliably. Review the original command.",
          caution: false,
          unknown: true,
        },
      ],
      notes: [],
    };
  }
  if (steps.length === 0) unknown(source);
  return { steps, notes: [...writeNotes, ...notes] };
}
