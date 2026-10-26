import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { type ChangesetCheckResult, type ScopedThreadRef } from "@starkfuture/contracts";
import { squashAtomCommandFailure } from "@starkfuture/client-runtime/state/runtime";
import { useAtomCommand } from "../../state/use-atom-command";
import { checkChangesets } from "../../state/changesetCheck";
import { Button } from "../ui/button";

export function ChangesetCheckPanel(props: {
  threadRef: ScopedThreadRef;
  cwd: string;
  onDraftFix: (prompt: string) => void;
}) {
  const check = useAtomCommand(checkChangesets, { reportFailure: false });
  const canCheck = useAtomValue(checkChangesets.permissionAtom(props.threadRef.environmentId));
  const [result, setResult] = useState<ChangesetCheckResult | null>(null);
  const [repository, setRepository] = useState(props.cwd);
  const [baseRef, setBaseRef] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const missing =
    result?.packages.filter(
      (p) => (p.changesets.length === 0 && !p.stagedCovered) || (p.staged && !p.stagedCovered),
    ) ?? [];
  async function run() {
    if (busy || !canCheck || !repository.trim()) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const response = await check({
        environmentId: props.threadRef.environmentId,
        input: { cwd: repository.trim(), ...(baseRef.trim() ? { baseRef: baseRef.trim() } : {}) },
      });
      if (response._tag === "Failure") {
        const cause = squashAtomCommandFailure(response);
        setError(cause instanceof Error ? cause.message : "The check failed.");
      } else setResult(response.value);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="space-y-4 p-4 text-sm" aria-label="Changeset check">
      <div>
        <h3 className="font-medium">Release notes</h3>
        <p className="mt-1 text-muted-foreground">
          Check changed publishable packages for a changeset. Reads files and Git; uses no AI
          tokens.
        </p>
      </div>
      <label className="block space-y-1">
        <span>Repository folder</span>
        <input
          name="repository"
          className="w-full rounded border bg-background p-2"
          disabled={busy}
          value={repository}
          onChange={(event) => {
            setRepository(event.target.value);
            setResult(null);
            setError(null);
          }}
          maxLength={4096}
        />
        <span className="block text-xs text-muted-foreground">
          Choose the repository to check inside your workspace.
        </span>
      </label>
      <label className="block space-y-1">
        <span>Compare with branch (optional)</span>
        <input
          className="w-full rounded border bg-background p-2"
          disabled={busy}
          value={baseRef}
          onChange={(e) => {
            setBaseRef(e.target.value);
            setResult(null);
          }}
          placeholder="Leave empty for uncommitted changes"
          maxLength={200}
        />
      </label>
      <Button
        size="sm"
        variant="outline"
        disabled={busy || !canCheck || !repository.trim()}
        onClick={() => void run()}
      >
        {busy ? "Checking…" : "Check changesets"}
      </Button>
      {error ? <p role="alert">{error}</p> : null}
      {result ? (
        <div className="space-y-3" role="status">
          <p className="text-xs text-muted-foreground">
            {result.base} · checked {new Date(result.checkedAt).toLocaleTimeString()}. Refresh after
            edits.
          </p>
          {!result.packages.length ? (
            <p>No changed publishable package found under packages/.</p>
          ) : (
            result.packages.map((p) => (
              <div key={`${p.directory}:${p.name}`} className="rounded border p-3">
                <strong>{p.name}</strong>
                <p>
                  {!p.changesets.length && !p.stagedCovered
                    ? "Missing changeset"
                    : p.staged && !p.stagedCovered
                      ? "Changeset exists, but none covering this package is staged"
                      : !p.changesets.length
                        ? "Staged changeset found; working copy differs"
                        : "Changeset found"}
                </p>
                {p.changesets.length ? (
                  <p className="break-all text-xs text-muted-foreground">
                    {p.changesets.join(", ")}
                  </p>
                ) : null}
              </div>
            ))
          )}
          {result.warnings.map((w) => (
            <p key={w} className="text-warning-foreground">
              {w}
            </p>
          ))}
          {missing.length ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                props.onDraftFix(
                  `Review the changes in ${repository.trim()} and propose the missing changesets for these packages: ${missing.map((p) => p.name).join(", ")}. Explain the correct bump and user-facing summary. Ask me before writing or staging anything. Do not commit, publish, deploy, or send messages.`,
                )
              }
            >
              Draft a fix request
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
