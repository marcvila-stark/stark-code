import { useCallback, useEffect, useState } from "react";
import type { ProviderContextBreakdown, ScopedThreadRef } from "@starkfuture/contracts";
import { serverEnvironment } from "../../state/server";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { Button } from "../ui/button";
import { formatContextWindowTokens } from "~/lib/contextWindow";

const palette = {
  used: "var(--color-primary)",
  free: "var(--color-muted)",
  buffer: "var(--color-warning)",
  deferred: "var(--color-muted-foreground)",
};

export function ContextBreakdownPanel({ threadRef }: { threadRef: ScopedThreadRef }) {
  const { environmentId, threadId } = threadRef;
  const read = useAtomQueryRunner(serverEnvironment.readContextUsage, {
    reportFailure: false,
    refresh: true,
  });
  const [value, setValue] = useState<ProviderContextBreakdown | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(
    async (detail: "summary" | "full") => {
      try {
        const result = await read({
          environmentId,
          input: { threadId, detail },
        });
        if (result._tag === "Success") setValue(result.value);
        else if (result._tag === "Failure") setError("Could not read context usage. Try again.");
      } finally {
        setBusy(false);
      }
    },
    [read, environmentId, threadId],
  );
  useEffect(() => {
    void load("summary");
  }, [load]);
  return (
    <section
      className="max-h-[70vh] w-[min(36rem,85vw)] overflow-auto p-4 text-xs"
      aria-label="Context breakdown"
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="font-medium">Context breakdown</h3>
        <Button
          variant="outline"
          size="xs"
          disabled={busy || value?.provider !== "claudeAgent" || value.kind === "unavailable"}
          onClick={() => {
            setBusy(true);
            setError(null);
            void load("full");
          }}
        >
          Count exactly
        </Button>
      </div>
      {value?.provider === "claudeAgent" ? (
        <p className="mb-3 text-muted-foreground">
          {value.detail === "summary"
            ? "Quick estimate. Count exactly makes token-count API calls on your account."
            : "Detailed token count requested."}
        </p>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      {busy ? <p className="text-muted-foreground">Measuring context…</p> : null}
      {value ? (
        <>
          {value.kind === "unavailable" ? (
            <p>{value.message ?? "Send a message to measure context"}</p>
          ) : (
            <>
              <p className="mb-3 tabular-nums">
                {formatContextWindowTokens(value.totalTokens)} /{" "}
                {formatContextWindowTokens(value.rawMaxTokens)}{" "}
                {value.windowLabel ?? "context window"} · {Math.round(value.percentage)}%
              </p>
              {value.kind === "tokens-only" ? (
                <>
                  <p className="mb-3 text-muted-foreground">
                    Codex gives no per-category breakdown.
                  </p>
                  <TokenRows
                    title="Last turn"
                    rows={
                      value.lastTurn
                        ? Object.entries(value.lastTurn)
                            .filter(([name]) => name !== "modelContextWindow")
                            .map(([name, tokens]) => ({ name, tokens }))
                        : []
                    }
                  />
                  {value.threadTotals ? (
                    <TokenRows
                      title="Thread totals (live session)"
                      rows={Object.entries(value.threadTotals)
                        .filter(([name]) => name !== "modelContextWindow")
                        .map(([name, tokens]) => ({ name, tokens }))}
                    />
                  ) : null}
                </>
              ) : (
                <>
                  <div
                    className="mb-3 flex h-3 overflow-hidden rounded bg-muted"
                    aria-label="Context categories"
                  >
                    {value.categories
                      .filter((row) => row.kind !== "deferred")
                      .map((row, index) => (
                        <span
                          key={`${row.kind}:${row.name}`}
                          aria-label={`${row.name}: ${row.tokens}`}
                          style={{
                            width: `${(100 * row.tokens) / Math.max(1, value.maxTokens)}%`,
                            backgroundColor: palette[row.kind],
                            opacity: row.kind === "used" ? Math.max(0.35, 1 - index * 0.08) : 1,
                          }}
                        />
                      ))}
                  </div>
                  <TokenRows
                    title="Categories"
                    rows={value.categories.map((row) => ({
                      name: `${row.name}${row.kind === "deferred" ? " (deferred, outside window)" : ""}`,
                      tokens: row.tokens,
                    }))}
                  />
                  <TokenRows
                    title="Memory files"
                    rows={value.memoryFiles.map((row) => ({ name: row.path, tokens: row.tokens }))}
                  />
                  <TokenRows
                    title="MCP tools"
                    rows={value.mcpTools.map((row) => ({
                      name: `${row.serverName} / ${row.name}${row.isLoaded === false ? " (deferred)" : ""}`,
                      tokens: row.tokens,
                    }))}
                  />
                  <TokenRows title="System tools" rows={value.systemTools ?? []} />
                  <TokenRows title="System prompt" rows={value.systemPromptSections ?? []} />
                  <TokenRows
                    title="Custom agents"
                    rows={value.agents.map((row) => ({
                      name: `${row.agentType} · ${row.source}`,
                      tokens: row.tokens,
                    }))}
                  />
                  <TokenRows title="Skills" rows={value.skills?.skillFrontmatter ?? []} />
                  {value.messageBreakdown ? (
                    <TokenRows
                      title="Messages"
                      rows={Object.entries(value.messageBreakdown).flatMap(([name, tokens]) =>
                        typeof tokens === "number" ? [{ name, tokens }] : [],
                      )}
                    />
                  ) : null}
                </>
              )}
            </>
          )}
        </>
      ) : null}
    </section>
  );
}

function TokenRows({
  title,
  rows,
}: {
  title: string;
  rows: readonly { name: string; tokens: number | undefined }[];
}) {
  if (rows.length === 0) return null;
  return (
    <details className="border-t border-border/60 py-2">
      <summary className="cursor-pointer font-medium">{title}</summary>
      <dl className="mt-2 space-y-1">
        {rows.map((row) => (
          <div key={row.name} className="flex justify-between gap-4">
            <dt className="min-w-0 break-all text-muted-foreground">{row.name}</dt>
            <dd className="shrink-0 tabular-nums">
              {formatContextWindowTokens(row.tokens ?? null)}
            </dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
