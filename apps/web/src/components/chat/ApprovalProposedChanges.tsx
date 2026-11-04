import { FileDiff } from "@pierre/diffs/react";
import type { ProposedFileChangesSummary } from "@starkfuture/client-runtime/approvals/proposed-file-changes";
import { memo, useMemo, useState } from "react";

import { useTheme } from "~/hooks/useTheme";
import { DiffWorkerPoolProvider } from "../DiffWorkerPoolProvider";
import {
  DIFF_SURFACE_THEME_UNSAFE_CSS,
  getRenderablePatch,
  resolveDiffThemeName,
} from "~/lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "~/lib/syntaxHighlighting";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { MiddleTruncate } from "../ui/middle-truncate";
import { approvalPathMinWidth, approvalPathTailLength } from "./approvalProposedChanges.logic";
import { DiffStatLabel } from "./DiffStatLabel";

/** The proposed diff of one file, as the approval card shows it. */
const ApprovalPatchDiff = memo(function ApprovalPatchDiff({ patch }: { patch: string }) {
  const { resolvedTheme } = useTheme();
  const renderable = useMemo(() => getRenderablePatch(patch, "approval"), [patch]);
  const options = useMemo(
    () => ({
      diffStyle: "unified" as const,
      overflow: "scroll" as const,
      disableFileHeader: true,
      theme: resolveDiffThemeName(resolvedTheme),
      themeType: resolvedTheme,
      preferredHighlighter: PREFERRED_HIGHLIGHTER,
      unsafeCSS: DIFF_SURFACE_THEME_UNSAFE_CSS,
    }),
    [resolvedTheme],
  );
  if (renderable === null) return null;
  return (
    <span
      aria-label="Proposed diff"
      className="block max-h-64 w-full overflow-auto rounded-md border border-border/60 text-xs [scrollbar-width:thin]"
      tabIndex={0}
    >
      {renderable.kind === "raw" ? (
        <code className="block w-full whitespace-pre p-2 font-mono">{renderable.text}</code>
      ) : (
        <DiffWorkerPoolProvider>
          {renderable.files.map((file, index) => (
            <FileDiff key={file.cacheKey ?? index} fileDiff={file} options={options} />
          ))}
        </DiffWorkerPoolProvider>
      )}
    </span>
  );
});

/**
 * The files a file-change approval would write and the diff of the selected
 * one. Warnings about a partial preview sit beside it; the provider's prompt,
 * absolute paths and per-file notes stay under Technical details.
 */
export const ApprovalProposedChanges = memo(function ApprovalProposedChanges({
  summary,
  detail,
}: {
  summary: ProposedFileChangesSummary;
  detail: string | undefined;
}) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const selected =
    summary.files.find((file) => file.path === selectedPath) ?? summary.files[0] ?? null;
  const fileNotes = (file: ProposedFileChangesSummary["files"][number]) =>
    [
      file.patch === undefined ? "no diff" : null,
      file.patchTruncated ? "diff shortened" : null,
      file.approximate ? "line numbers are approximate" : null,
    ].filter((note) => note !== null);

  return (
    <span className="flex w-full min-w-0 flex-col gap-1.5">
      <span aria-label="Proposed change" className="text-xs font-medium text-foreground">
        {summary.headline}
      </span>
      <span
        aria-label="Files to change"
        className="flex max-h-24 w-full flex-col overflow-auto [scrollbar-width:thin]"
        role="list"
      >
        {summary.files.map((file) => {
          const isSelected = file === selected;
          return (
            <span key={file.path} role="listitem" className="flex w-full min-w-0">
              <button
                type="button"
                aria-pressed={summary.files.length > 1 ? isSelected : undefined}
                className={cn(
                  // Wraps only when the file name alone fills the row: the counts move below.
                  "flex w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 rounded-sm px-1 py-0.5 text-left text-xs",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
                  summary.files.length > 1 && "hover:bg-accent/60",
                  summary.files.length > 1 && isSelected && "bg-accent",
                )}
                onClick={() => setSelectedPath(file.path)}
              >
                <span className="shrink-0 text-muted-foreground">{file.operationLabel}</span>
                <ProposedFilePath
                  path={
                    file.oldDisplayPath === undefined
                      ? file.displayPath
                      : `${file.oldDisplayPath} → ${file.displayPath}`
                  }
                />
                {file.patch === undefined ? null : (
                  <DiffStatLabel
                    additions={file.additions}
                    deletions={file.deletions}
                    layout="inline"
                  />
                )}
              </button>
            </span>
          );
        })}
      </span>
      {summary.warnings.length > 0 ? (
        <span aria-label="Preview warnings" className="text-xs leading-relaxed text-warning">
          {summary.warnings.join(" ")}
        </span>
      ) : null}
      {selected?.patch === undefined ? null : <ApprovalPatchDiff patch={selected.patch} />}
      <span className="flex w-full flex-col items-start text-xs text-muted-foreground">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-expanded={detailsOpen}
          onClick={() => setDetailsOpen((open) => !open)}
        >
          Technical details
        </Button>
        {detailsOpen ? (
          <span
            aria-label="Technical details"
            className="flex max-h-48 w-full flex-col gap-1 overflow-auto py-1 [scrollbar-width:thin]"
          >
            {detail ? <span className="whitespace-pre-wrap wrap-break-word">{detail}</span> : null}
            {summary.files.map((file) => {
              const notes = fileNotes(file);
              return (
                <span key={file.path} className="font-mono break-all">
                  {file.oldPath === undefined ? file.path : `${file.oldPath} → ${file.path}`}
                  {notes.length > 0 ? ` (${notes.join(", ")})` : ""}
                </span>
              );
            })}
            {summary.omitted > 0 ? (
              <span>
                {summary.omitted} more {summary.omitted === 1 ? "file" : "files"} not listed by the
                preview.
              </span>
            ) : null}
          </span>
        ) : null}
      </span>
    </span>
  );
});

/** A file row's path: a narrow card cuts the directory, never the file name. */
function ProposedFilePath({ path }: { path: string }) {
  return (
    <span
      className="flex min-w-0 flex-1 font-mono"
      style={{ minWidth: approvalPathMinWidth(path) }}
    >
      <MiddleTruncate value={path} tail={approvalPathTailLength(path)} />
    </span>
  );
}
