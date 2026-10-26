import { ProviderDriverKind } from "@starkfuture/contracts";

export interface HookRunDisplay {
  readonly id: string;
  readonly provider: ProviderDriverKind;
  readonly eventName: string;
  readonly hookName: string;
  readonly matcher?: string;
  readonly source?: string;
  readonly outcome: "blocked" | "failed" | "notice" | "ran";
  readonly level: "info" | "notice" | "suggestion" | "warning";
  readonly summary: string;
  readonly detail: string;
  readonly exitCode?: number;
  readonly durationMs?: number;
}

/** Hook text is display data, never Markdown or model context. */
/* eslint-disable no-control-regex -- this boundary intentionally removes terminal control characters */
export function cleanHookText(value: string, limit = 8_192): string {
  return value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
    .slice(0, limit);
}
/* eslint-enable no-control-regex */

const textField = (value: Record<string, unknown>, name: string) =>
  typeof value[name] === "string" ? value[name] : undefined;

function hookDecision(text: string): { blocked: boolean; reason?: string | undefined } {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null) return { blocked: false };
    const fields = value as Record<string, unknown>;
    const specifics = fields.hookSpecificOutput;
    const output =
      typeof specifics === "object" && specifics !== null
        ? (specifics as Record<string, unknown>)
        : {};
    return {
      blocked: output.permissionDecision === "deny" || fields.decision === "block",
      reason:
        textField(output, "permissionDecisionReason") ??
        textField(fields, "reason") ??
        textField(fields, "stopReason"),
    };
  } catch {
    return { blocked: false };
  }
}

/** Stores only pending run metadata; each completed run is returned once. */
export function makeClaudeHookEventMapper() {
  const pending = new Map<
    string,
    {
      startedAt: number;
      stdout?: string | undefined;
      stderr?: string | undefined;
      output?: string | undefined;
      source?: string | undefined;
      matcher?: string | undefined;
    }
  >();
  return {
    map(message: unknown, now: number): readonly HookRunDisplay[] {
      if (typeof message !== "object" || message === null) return [];
      const fields = message as Record<string, unknown>;
      if (fields.type !== "system") return [];
      if (fields.subtype === "informational") {
        const detail = cleanHookText(textField(fields, "content") ?? "");
        if (detail.trim().length === 0) return [];
        const level =
          fields.level === "warning" || fields.level === "suggestion" || fields.level === "notice"
            ? fields.level
            : "info";
        return [
          {
            id: textField(fields, "uuid") ?? `informational:${now}`,
            provider: ProviderDriverKind.make("claudeAgent"),
            eventName: fields.prevent_continuation === true ? "Stop" : "Informational",
            hookName: "Claude Code",
            outcome: "notice",
            level,
            summary: detail.replace(/\s+/g, " ").slice(0, 300),
            detail,
          },
        ];
      }
      const id = textField(fields, "hook_id");
      if (id === undefined) return [];
      if (fields.subtype === "hook_started") {
        pending.set(id, {
          startedAt: now,
          ...(textField(fields, "source") === undefined
            ? {}
            : { source: textField(fields, "source") }),
          ...(textField(fields, "matcher") === undefined
            ? {}
            : { matcher: textField(fields, "matcher") }),
        });
        return [];
      }
      if (fields.subtype === "hook_progress") {
        const previous = pending.get(id) ?? { startedAt: now };
        pending.set(id, {
          ...previous,
          stdout: textField(fields, "stdout"),
          stderr: textField(fields, "stderr"),
          output: textField(fields, "output"),
        });
        return [];
      }
      if (fields.subtype !== "hook_response") return [];
      const previous = pending.get(id);
      pending.delete(id);
      const stdout = textField(fields, "stdout") ?? previous?.stdout ?? "";
      const stderr = textField(fields, "stderr") ?? previous?.stderr ?? "";
      const output = textField(fields, "output") ?? previous?.output ?? "";
      const decision = [hookDecision(stdout), hookDecision(output)].find((value) => value.blocked);
      const exitCode =
        typeof fields.exit_code === "number" && Number.isInteger(fields.exit_code)
          ? fields.exit_code
          : undefined;
      const blocked = exitCode === 2 || decision?.blocked === true;
      const failed =
        !blocked &&
        (fields.outcome === "error" ||
          fields.outcome === "cancelled" ||
          (exitCode !== undefined && exitCode !== 0));
      const eventName = cleanHookText(textField(fields, "hook_event") ?? "Hook", 100);
      const hookName = cleanHookText(textField(fields, "hook_name") ?? eventName, 200);
      const detail = cleanHookText(
        [...new Set([stdout, stderr, output].filter((text) => text.length > 0))].join("\n"),
      );
      const reason = cleanHookText(
        decision?.reason ?? (stderr.trim() || stdout.trim() || output.trim()),
        200,
      ).replace(/\s+/g, " ");
      const summary = (
        blocked
          ? `Blocked by ${eventName} hook${reason ? `: ${reason}` : ""}`
          : failed
            ? `${eventName} hook failed${exitCode === undefined ? "" : ` (exit ${exitCode})`}`
            : `${eventName} hook ran`
      ).slice(0, 300);
      return [
        {
          id,
          provider: ProviderDriverKind.make("claudeAgent"),
          eventName,
          hookName,
          ...(previous?.matcher === undefined ? {} : { matcher: previous.matcher }),
          ...(previous?.source === undefined
            ? {}
            : { source: cleanHookText(previous.source, 300) }),
          outcome: blocked ? "blocked" : failed ? "failed" : "ran",
          level: failed ? "warning" : blocked ? "notice" : "info",
          summary,
          detail,
          ...(exitCode === undefined ? {} : { exitCode }),
          ...(previous === undefined ? {} : { durationMs: Math.max(0, now - previous.startedAt) }),
        },
      ];
    },
  };
}
