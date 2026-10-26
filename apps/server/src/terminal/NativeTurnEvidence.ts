// @effect-diagnostics globalDate:off -- Serialized into the standalone Node hook, which cannot import Effect at runtime.
import type { NativeTurnEvidence } from "@starkfuture/contracts";

/**
 * Serialized into the standalone hook. Keep dependencies inside the function.
 * Native JSONL is a versioned, best-effort input: unknown records never imply success.
 * Only labels, exit results, timestamps and relative paths leave this boundary.
 */
export function projectNativeTurnEvidence(input: {
  provider: "claude" | "codex";
  sessionId: string;
  turnId: string | null;
  replyText: string;
  cwd: string;
  records: readonly unknown[];
  truncated: boolean;
}): NativeTurnEvidence {
  const object = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  const time = (value: unknown): string | null => {
    if (typeof value !== "string" && typeof value !== "number") return null;
    const n = typeof value === "number" ? value : Date.parse(value);
    return Number.isFinite(n) && n >= 0 && n <= 8_640_000_000_000_000
      ? new Date(n).toISOString()
      : null;
  };
  const result: NativeTurnEvidence = {
    coverage: input.truncated ? "partial" : "available",
    commands: [],
    changes: [],
    unconfirmedChanges: 0,
  };
  const commands: Array<NativeTurnEvidence["commands"][number]> = [];
  const changes = new Map<string, string | null>();
  let partial = input.truncated;
  let unconfirmedChanges = 0;
  const relativePath = (value: unknown): string | null => {
    const raw = text(value).replaceAll("\\", "/");
    const cwd = input.cwd.replaceAll("\\", "/").replace(/\/$/, "");
    const relative = raw.startsWith(`${cwd}/`) ? raw.slice(cwd.length + 1) : raw;
    if (
      !relative ||
      relative.length > 512 ||
      // Paths are shown in UI; control bytes must not survive the projection.
      // eslint-disable-next-line no-control-regex
      /[\x00-\x1f\x7f]/.test(relative) ||
      relative.startsWith("/") ||
      /^[A-Za-z]:/.test(relative) ||
      relative.split("/").includes("..")
    )
      return null;
    return relative;
  };
  const addChange = (value: unknown, completedAt: string | null) => {
    const path = relativePath(value);
    if (!path) {
      partial = true;
      return;
    }
    if (!changes.has(path) && changes.size >= 200) {
      partial = true;
      return;
    }
    const previous = changes.get(path);
    changes.set(
      path,
      previous === null || completedAt === null
        ? null
        : previous && previous > completedAt
          ? previous
          : completedAt,
    );
  };
  const describe = (value: unknown) => {
    const argv =
      Array.isArray(value) && value.every((arg): arg is string => typeof arg === "string")
        ? value
        : null;
    const shellWrapper =
      argv?.length === 3 &&
      ["sh", "bash", "zsh", "dash", "ksh", "fish"].includes(argv[0]!.split(/[\\/]/).at(-1) ?? "") &&
      ["-c", "-lc"].includes(argv[1]!);
    // Codex rollouts contain argv, including the actual shell wrapper, while
    // Claude records the command string. Unwrap only a known exact shell form;
    // direct argv keeps its argument boundaries instead of guessing shell text.
    const command = (shellWrapper ? argv[2]! : text(value)).trim();
    // No raw command arguments: even ordinary commands can contain credentials.
    const directArgs = argv && !shellWrapper ? argv : null;
    const simple = !/[\n\r;&|<>`$]/.test(directArgs ? directArgs.join(" ") : command);
    const words = directArgs
      ? [...directArgs]
      : command.replace(/^(?:[A-Za-z_][\w]*=[^\s]+\s+)*/, "").split(/\s+/);
    const inspectionOnly = words.some((word) =>
      /^(?:-h|-V|--help|--version|--list(?:Tests|-tests|-tests-only|FilesOnly)?|--collect-?only|--show-?config|--showConfig|--print-config|--dry-?run|-list)(?:=|$)/i.test(
        word,
      ),
    );
    const executable = (words.shift()?.split(/[\\/]/).at(-1) ?? "").replace(/\.exe$/, "");
    const safeExecutable = /^[a-zA-Z0-9_.-]{1,64}$/.test(executable) ? executable : "Command";
    const prefix = [safeExecutable];
    if (
      ["npm", "pnpm", "yarn", "bun", "vp", "npx", "bunx"].includes(executable) &&
      ["run", "exec", "x"].includes(words[0] ?? "")
    )
      prefix.push(words.shift()!);
    const subcommand = words[0] ?? "";
    const packageCheck =
      ["npm", "pnpm", "yarn", "bun", "vp", "npx", "bunx"].includes(executable) &&
      (/^(?:test|lint|typecheck|check)(?::[\w-]+)?$/.test(subcommand) ||
        ["vitest", "jest", "pytest", "tsc", "tsc-rs", "eslint", "oxlint"].includes(subcommand));
    const directCheck = ["vitest", "jest", "pytest", "tsc", "tsc-rs", "eslint", "oxlint"].includes(
      executable,
    );
    const otherChecks: Record<string, readonly string[]> = {
      cargo: ["test", "check", "clippy"],
      go: ["test", "vet"],
      dotnet: ["test"],
      swift: ["test"],
      make: ["test", "check", "lint"],
      mvn: ["test", "verify"],
    };
    const otherCheck = otherChecks[executable]?.includes(subcommand) === true;
    const pythonCheck =
      ["python", "python3"].includes(executable) &&
      subcommand === "-m" &&
      ["pytest", "unittest"].includes(words[1] ?? "");
    const nodeCheck = executable === "node" && subcommand === "--test";
    const isCheck =
      simple &&
      !inspectionOnly &&
      words[0] !== "list" &&
      (packageCheck || directCheck || otherCheck || pythonCheck || nodeCheck);
    if (isCheck && (packageCheck || otherCheck)) prefix.push(words.shift()!);
    if (isCheck && pythonCheck) prefix.push(words.shift()!, words.shift()!);
    if (isCheck && nodeCheck) prefix.push(words.shift()!);
    return {
      isCheck,
      label: (simple
        ? `${prefix.join(" ")}${words.length ? " …" : ""}`
        : "Shell command (arguments hidden)"
      ).slice(0, 256),
    };
  };
  const addCommand = (command: NativeTurnEvidence["commands"][number]) => {
    const existing = commands.findIndex((item) => item.id === command.id);
    if (existing >= 0) {
      commands[existing] = command;
      return;
    }
    if (commands.length >= 100) {
      partial = true;
      return;
    }
    commands.push(command);
  };
  const rows = input.records.map(object);
  if (input.provider === "codex") {
    if (!input.turnId) return { ...result, coverage: "unavailable" };
    let foundTurn = false;
    for (const row of rows) {
      if (row.type !== "event_msg") continue;
      const event = object(row.payload);
      if (event.turn_id !== input.turnId) continue;
      foundTurn = true;
      if (event.type !== "item_completed") continue;
      if (event.thread_id !== undefined && event.thread_id !== input.sessionId) continue;
      const item = object(event.item);
      const start = time(event.started_at_ms);
      const end = time(event.completed_at_ms) ?? time(row.timestamp);
      if (item.type === "CommandExecution" || item.type === "commandExecution") {
        const exit = Number.isInteger(item.exit_code) ? (item.exit_code as number) : null;
        const failed =
          ["failed", "declined", "interrupted", "cancelled"].includes(text(item.status)) ||
          (exit !== null && exit !== 0);
        addCommand({
          id: text(item.id).slice(0, 256),
          ...describe(item.command),
          exitCode: exit,
          outcome: failed
            ? "failed"
            : item.status === "completed" && exit === 0
              ? "exit-zero"
              : "unknown",
          startedAt: start,
          completedAt: end,
        });
      } else if (item.type === "FileChange" || item.type === "fileChange") {
        if (item.status !== "completed") {
          unconfirmedChanges += 1;
          continue;
        }
        // Native rollout maps paths to typed patch changes; API variants use an array.
        if (Array.isArray(item.changes)) {
          for (const change of item.changes) addChange(object(change).path, end);
        } else {
          for (const [path, change] of Object.entries(object(item.changes))) {
            addChange(path, end);
            const moved = object(change).move_path;
            if (moved) addChange(moved, end);
          }
        }
      }
    }
    if (!foundTurn) return { ...result, coverage: "unavailable" };
  } else {
    const records = rows.filter(
      (row) => row.sessionId === input.sessionId && row.isSidechain !== true,
    );
    const content = (row: Record<string, unknown>) =>
      array(object(row.message).content).map(object);
    const byId = new Map(records.map((row) => [text(row.uuid), row]));
    // The Stop hook can arrive after another turn starts. Follow the matched
    // reply's parent chain; never accidentally attribute the next turn's work.
    const matchingReplies = records.filter(
      (row) =>
        row.type === "assistant" &&
        content(row)
          .filter((block) => block.type === "text")
          .map((block) => text(block.text))
          .join("\n")
          .trim() === input.replyText.trim(),
    );
    // Repeated final text cannot disambiguate delayed async Stop hooks. Do not
    // attribute the latest "Done." to an earlier turn just because it matches.
    const final = matchingReplies.length === 1 ? matchingReplies[0] : undefined;
    if (!final || !text(final.uuid)) return { ...result, coverage: "unavailable" };
    const chain: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    let cursor: Record<string, unknown> | undefined = final;
    let foundPrompt = false;
    while (cursor && chain.length < 5000) {
      const id = text(cursor.uuid);
      if (!id || seen.has(id)) break;
      seen.add(id);
      const blocks = content(cursor);
      if (
        cursor.type === "user" &&
        !blocks.some((block) => block.type === "tool_result") &&
        cursor.isMeta !== true
      ) {
        foundPrompt = true;
        break;
      }
      chain.push(cursor);
      cursor = byId.get(text(cursor.parentUuid));
    }
    if (!foundPrompt) partial = true;
    const uses = new Map<
      string,
      { row: Record<string, unknown>; block: Record<string, unknown> }
    >();
    const completions = new Map<
      string,
      { row: Record<string, unknown>; block: Record<string, unknown> }
    >();
    for (const row of chain.toReversed()) {
      for (const block of content(row)) {
        if (block.type === "tool_use") uses.set(text(block.id), { row, block });
        if (block.type === "tool_result") completions.set(text(block.tool_use_id), { row, block });
      }
    }
    for (const [id, use] of uses) {
      const name = text(use.block.name);
      const args = object(use.block.input);
      const completion = completions.get(id);
      const response = object(completion?.row.toolUseResult);
      const end = time(completion?.row.timestamp);
      const failed = completion?.block.is_error === true || response.interrupted === true;
      if (name === "Bash") {
        const background =
          response.backgroundTaskId !== undefined ||
          response.backgroundedByUser === true ||
          response.timedOutAfterMs !== undefined;
        const exit = Number.isInteger(response.exitCode) ? (response.exitCode as number) : null;
        addCommand({
          id: id.slice(0, 256),
          ...describe(args.command),
          exitCode: exit,
          outcome:
            failed || (exit !== null && exit !== 0)
              ? "failed"
              : !completion || background
                ? "unknown"
                : exit === 0
                  ? "exit-zero"
                  : typeof response.stdout === "string" && response.interrupted === false
                    ? "tool-completed"
                    : "unknown",
          startedAt: time(use.row.timestamp),
          completedAt: end,
        });
        const diff = object(response.bashEditDiff);
        if (diff.unavailable === true || (typeof diff.moreFiles === "number" && diff.moreFiles > 0))
          partial = true;
        for (const file of array(diff.files))
          addChange(object(file).filePath ?? object(file).path, end);
      } else if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(name)) {
        if (!completion || failed) {
          unconfirmedChanges += 1;
          continue;
        }
        addChange(response.filePath ?? args.file_path ?? args.notebook_path, end);
      }
    }
  }
  return {
    coverage: partial ? "partial" : "available",
    commands,
    changes: [...changes].map(([path, completedAt]) => ({ path, completedAt })),
    unconfirmedChanges,
  };
}
