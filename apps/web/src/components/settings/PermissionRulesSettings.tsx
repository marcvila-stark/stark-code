import { useState } from "react";
import { ThreadId, type SavedPermissionRuleFile } from "@starkfuture/contracts";
import { squashAtomCommandFailure } from "@starkfuture/client-runtime/state/runtime";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsPageContainer } from "./settingsLayout";
import { useThreadShells } from "../../state/entities";
import { useEnvironmentScope } from "../../state/session";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOpenInPreferredEditor } from "../../editorPreferences";
import { Button } from "../ui/button";

export function PermissionRuleFileList({
  files,
  canForget,
  canOpen,
  busy,
  onOpen,
  onForget,
}: {
  files: ReadonlyArray<SavedPermissionRuleFile>;
  canForget: boolean;
  canOpen: boolean;
  busy: boolean;
  onOpen: (path: string) => void;
  onForget: (file: SavedPermissionRuleFile, id: string) => void;
}) {
  return (
    <div className="space-y-6">
      {files.map((file) => (
        <section
          key={`${file.providerInstanceId}:${file.path}`}
          className="space-y-3 rounded-xl border p-4"
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-medium">
                {file.provider === "codex" ? "Codex" : "Claude"} ·{" "}
                {file.scope === "user"
                  ? "Every project"
                  : file.scope === "worktree"
                    ? "This worktree"
                    : "This project"}
              </h3>
              <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{file.path}</p>
            </div>
            <Button
              size="xs"
              variant="outline"
              disabled={!file.exists || !canOpen}
              onClick={() => {
                if (canOpen && file.exists) onOpen(file.path);
              }}
            >
              Open file
            </Button>
          </div>
          {file.warning ? <p className="text-xs text-warning">{file.warning}</p> : null}
          {file.rules.length === 0 ? (
            <p className="text-xs text-muted-foreground">No saved rules.</p>
          ) : (
            <ul className="space-y-2">
              {file.rules.map((rule) => (
                <li
                  key={rule.id}
                  className="flex items-start justify-between gap-3 rounded-lg bg-muted/40 p-3"
                >
                  <code className="min-w-0 whitespace-pre-wrap break-all text-xs">{rule.text}</code>
                  {canForget ? (
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={busy}
                      onClick={() => {
                        if (!busy) onForget(file, rule.id);
                      }}
                    >
                      Forget rule
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}

export function PermissionRulesSettings() {
  const { environment, scope } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  const threads = useThreadShells().filter(
    (thread) =>
      thread.environmentId === environmentId &&
      ((scope.kind !== "project" && scope.kind !== "checkout") ||
        scope.members.some(
          (member) => member.environmentId === environmentId && member.id === thread.projectId,
        )),
  );
  const [selectedId, setSelectedId] = useState<ThreadId | null>(null);
  const thread = threads.find((entry) => entry.id === selectedId) ?? threads[0];
  const result = useEnvironmentQuery(
    environmentId && thread
      ? serverEnvironment.readPermissionRules({ environmentId, input: { threadId: thread.id } })
      : null,
  );
  const forget = useAtomCommand(serverEnvironment.forgetPermissionRule, { reportFailure: false });
  const canForget = useEnvironmentScope(environmentId, "settings:write");
  const canOpen = useEnvironmentScope(environmentId, "orchestration:operate");
  const open = useOpenInPreferredEditor(
    environmentId,
    environment?.serverConfig?.availableEditors ?? [],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const forgetRule = async (file: SavedPermissionRuleFile, ruleId: string) => {
    if (!environmentId || !thread || !canForget || busy) return;
    setBusy(true);
    setError(null);
    try {
      const answer = await forget({
        environmentId,
        input: { threadId: thread.id, providerInstanceId: file.providerInstanceId, ruleId },
      });
      if (answer._tag === "Failure") throw squashAtomCommandFailure(answer);
      result.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not forget this rule.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsPageContainer>
      <div className="space-y-5 py-6">
        <div>
          <h2 className="text-base font-semibold">Permissions</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Review saved provider rules for a thread's project. New rules can only be saved from an
            approval card. Changes apply on the next provider turn.
          </p>
        </div>
        {!environment ? (
          <p className="text-sm text-muted-foreground">
            Connect an environment to view its permission rules.
          </p>
        ) : threads.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Create a project thread to view saved rules.
          </p>
        ) : (
          <>
            <label className="flex flex-col gap-2 text-sm">
              Project thread
              <select
                aria-label="Project thread"
                className="rounded-lg border bg-background px-3 py-2"
                value={thread?.id ?? ""}
                onChange={(event) => setSelectedId(ThreadId.make(event.target.value))}
              >
                {threads.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.title}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex justify-end">
              <Button size="xs" variant="outline" onClick={() => result.refresh()}>
                Refresh
              </Button>
            </div>
            {result.isPending && !result.data ? (
              <p className="text-sm text-muted-foreground">Reading saved rules…</p>
            ) : null}
            {error || result.error ? (
              <p role="alert" className="text-sm text-destructive">
                {error ?? result.error}
              </p>
            ) : null}
            <PermissionRuleFileList
              files={result.data?.files ?? []}
              canForget={canForget}
              canOpen={canOpen}
              busy={busy}
              onForget={(file, id) => {
                void forgetRule(file, id);
              }}
              onOpen={(path) => {
                void open(path).then((answer) => {
                  if (answer._tag === "Failure") setError(String(squashAtomCommandFailure(answer)));
                });
              }}
            />
          </>
        )}
      </div>
    </SettingsPageContainer>
  );
}
