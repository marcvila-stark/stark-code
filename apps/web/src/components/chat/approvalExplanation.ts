import {
  classifyReadOnlyShellCommand,
  describeReadOnlyCommand,
  literalShellWord,
  shellProgramName as programName,
  unwrapShellCommand,
  type ReadOnlyShellCommand,
  type UnwrappedShellCommand,
} from "@starkfuture/shared/readOnlyShellCommand";
import { parse, type Command, type PipelineNode } from "unbash";

export interface ApprovalExplanationStep {
  readonly command: string;
  readonly explanation: string;
  readonly caution: boolean;
  readonly unknown: boolean;
}

export interface ApprovalExplanation {
  readonly steps: readonly ApprovalExplanationStep[];
  /** Warnings that bear on the decision, most important first. */
  readonly notes: readonly string[];
  /** How the parts connect; shown with the details, never as a warning. */
  readonly context: readonly string[];
  /** Set when every part is expected to only read; its summary leads the approval card. */
  readonly readOnly: Extract<ReadOnlyShellCommand, { readOnly: true }> | undefined;
  /** The outer `zsh -lc '…'` style wrapper, when the command has one. */
  readonly wrapper: UnwrappedShellCommand | undefined;
}

const MAX_LENGTH = 8_192;
const MAX_STEPS = 6;
const UNKNOWN = "This app cannot reliably explain this command. Review the original command.";
export const APPROVAL_EXPLANATION_LIMIT =
  "Based on command text only. Aliases, configuration, hooks and scripts may do more. Affected files have not been checked.";
/** Replaces the general limit when the card carries the "Read-only command" badge. */
export const READ_ONLY_APPROVAL_LIMIT =
  "The read-only label is based on the command text only. Aliases, shell startup files, environment variables and repository settings such as Git helpers can still run other programs.";

const literal = literalShellWord;

const sentence = (phrase: string) => `${phrase[0]!.toUpperCase()}${phrase.slice(1)}.`;

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
  if (name === "pwd" && args.every((arg) => ["-L", "-P"].includes(arg)))
    return known("Prints the current working directory.");
  if (name === "node" && args.length === 1 && ["--version", "-v"].includes(args[0]!))
    return known("Asks Node.js to print its version.");
  if (
    name === "sed" &&
    args.length >= 2 &&
    args[0] === "-n" &&
    /^\d+(?:,\d+)?p$/u.test(args[1]!) &&
    args.slice(2).every((arg) => !arg.startsWith("-"))
  )
    return known("Prints the requested line range from the input files.");
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
  if (name === "find" && args.includes("-delete")) {
    return known("Deletes every file and folder this search matches.", true);
  }
  if (name === "find" && args.some((arg) => /^-(?:exec|execdir|ok|okdir)$/u.test(arg))) {
    const index = args.findIndex((arg) => /^-(?:exec|execdir|ok|okdir)$/u.test(arg));
    const program = args[index + 1];
    return known(
      `Searches for files and runs ${program ? `"${program}"` : "another program"} on each match. That program decides what happens to them.`,
    );
  }
  if (name === "sed" && args.some((arg) => /^-[^-]*i|^--in-place/u.test(arg))) {
    return known("Edits the selected files in place.", true);
  }
  const readOnly = describeReadOnlyCommand([name, ...args]);
  if (name !== "git") return readOnly ? known(sentence(readOnly)) : unknown();
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
  return readOnly ? known(sentence(readOnly)) : unknown();
}

/**
 * Informational, never a permission policy. No execution, filesystem inspection,
 * expansion or model calls. Opaque syntax stays opaque; we never assign a safe label.
 */
export function explainApprovalCommand(source: string | undefined): ApprovalExplanation {
  const steps: ApprovalExplanationStep[] = [];
  const notes = new Set<string>();
  const writeNotes = new Set<string>();
  const context = new Set<string>();
  const done = () => ({
    steps,
    notes: [...writeNotes, ...notes],
    context: [...context],
    readOnly: undefined,
    wrapper: undefined,
  });
  const unknown = (command: string, explanation = UNKNOWN) => {
    if (steps.length < MAX_STEPS)
      steps.push({ command, explanation, caution: false, unknown: true });
    else notes.add("More command parts are present. Review the complete original command.");
  };
  if (!source?.trim()) {
    unknown("", "Command details are unavailable. Review the request before deciding.");
    return done();
  }
  if (source.length > MAX_LENGTH) {
    unknown(
      "",
      "This command is too long to explain reliably. Review the complete original command.",
    );
    return done();
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
      context.add("The shell's startup settings may also run commands.");
      visitScript(values[1]!, depth + 1);
      return;
    }
    steps.push({ command: raw, ...explainKnown([name, ...values]) });
  };
  const visit = (node: PipelineNode, text: string, depth: number) => {
    if (node.type === "Command") command(node, text, depth);
    else if (node.type === "Pipeline") {
      context.add("These commands form a pipeline; output from one becomes input to another.");
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
        context.add("Later commands run conditionally, depending on earlier exit codes.");
        for (const child of statement.command.commands) visit(child, text, depth);
      } else visit(statement.command, text, depth);
    }
  };
  try {
    visitScript(source, 0);
  } catch {
    steps.length = 0;
    notes.clear();
    writeNotes.clear();
    context.clear();
    unknown("", "This command could not be parsed reliably. Review the original command.");
    return done();
  }
  if (steps.length === 0) unknown(source);
  const readOnly = classifyReadOnlyShellCommand(source);
  return {
    ...done(),
    readOnly: readOnly.readOnly ? readOnly : undefined,
    wrapper: unwrapShellCommand(source),
  };
}
