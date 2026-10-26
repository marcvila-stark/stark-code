import { cleanHookText, type HookRunDisplay } from "./ClaudeHookEvents.ts";
import { ProviderDriverKind } from "@starkfuture/contracts";

export function codexHookRunDisplay(run: unknown): HookRunDisplay | null {
  if (typeof run !== "object" || run === null) return null;
  const fields = run as Record<string, unknown>;
  if (typeof fields.id !== "string") return null;
  const entries = Array.isArray(fields.entries)
    ? fields.entries.flatMap((entry) => {
        if (typeof entry !== "object" || entry === null) return [];
        const values = entry as Record<string, unknown>;
        return typeof values.text === "string" ? [{ kind: values.kind, text: values.text }] : [];
      })
    : [];
  const blocked = fields.status === "blocked" || entries.some((entry) => entry.kind === "stop");
  const failed = fields.status === "failed" || entries.some((entry) => entry.kind === "error");
  const visibleEntry = entries.find((entry) => entry.kind !== "context");
  const eventName = cleanHookText(
    typeof fields.eventName === "string" ? fields.eventName : "Hook",
    100,
  );
  const reason = cleanHookText(
    visibleEntry?.text ?? (typeof fields.statusMessage === "string" ? fields.statusMessage : ""),
    200,
  ).replace(/\s+/g, " ");
  const outcome = blocked
    ? "blocked"
    : failed
      ? "failed"
      : visibleEntry || fields.status === "stopped"
        ? "notice"
        : "ran";
  return {
    id: fields.id,
    provider: ProviderDriverKind.make("codex"),
    eventName,
    hookName: eventName,
    ...(typeof fields.sourcePath === "string"
      ? { source: cleanHookText(fields.sourcePath, 300) }
      : typeof fields.source === "string"
        ? { source: cleanHookText(fields.source, 300) }
        : {}),
    outcome,
    level:
      failed || entries.some((entry) => entry.kind === "warning")
        ? "warning"
        : outcome === "ran"
          ? "info"
          : "notice",
    summary: (blocked
      ? `Blocked by ${eventName} hook${reason ? `: ${reason}` : ""}`
      : failed
        ? `${eventName} hook failed${reason ? `: ${reason}` : ""}`
        : reason || `${eventName} hook ${fields.status === "stopped" ? "stopped" : "ran"}`
    ).slice(0, 300),
    detail: cleanHookText(entries.map((entry) => entry.text).join("\n")),
    ...(typeof fields.durationMs === "number"
      ? { durationMs: Math.max(0, fields.durationMs) }
      : {}),
  };
}
