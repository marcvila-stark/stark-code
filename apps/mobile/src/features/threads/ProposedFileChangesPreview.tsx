import {
  patchPreviewRows,
  type PatchPreviewRow,
  type ProposedFileChangesSummary,
} from "@starkfuture/client-runtime/approvals/proposed-file-changes";
import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { PullRequestDiffStats } from "../pull-requests/PullRequestPresentation";

/** Rows shown before "Show more"; the card sits above the composer, so it stays short. */
const PREVIEW_ROWS = 30;

const ROW_TONE: Record<PatchPreviewRow["kind"], string> = {
  add: "text-adaptive-emerald-600-400",
  remove: "text-danger-foreground",
  context: "text-foreground-secondary",
  hunk: "text-foreground-muted",
  note: "text-foreground-muted",
};

/**
 * The files a file-change approval would write and a text preview of the
 * selected file's diff. Warnings about a partial preview sit beside it; the
 * provider's prompt and absolute paths stay behind Technical details.
 */
export function ProposedFileChangesPreview(props: {
  readonly summary: ProposedFileChangesSummary;
  readonly detail: string | undefined;
}) {
  const { summary } = props;
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const selected =
    summary.files.find((file) => file.path === selectedPath) ?? summary.files[0] ?? null;
  const preview =
    selected?.patch === undefined
      ? null
      : patchPreviewRows(selected.patch, showAll ? Number.POSITIVE_INFINITY : PREVIEW_ROWS);

  return (
    <View className="gap-2">
      <View className="gap-1">
        {summary.files.map((file) => {
          const isSelected = file === selected;
          return (
            <Pressable
              key={file.path}
              accessibilityRole="button"
              accessibilityState={{ selected: summary.files.length > 1 && isSelected }}
              accessibilityLabel={`${file.operationLabel} ${file.displayPath}`}
              disabled={summary.files.length < 2}
              onPress={() => {
                setSelectedPath(file.path);
                setShowAll(false);
              }}
              className={cn(
                "flex-row items-center gap-2 rounded-lg px-2 py-1.5",
                summary.files.length > 1 && isSelected ? "bg-subtle-strong" : "bg-subtle",
              )}
            >
              <Text className="font-stark-medium text-xs text-foreground-muted">
                {file.operationLabel}
              </Text>
              <Text className="min-w-0 flex-1 font-mono text-xs text-foreground" numberOfLines={1}>
                {file.oldDisplayPath === undefined
                  ? file.displayPath
                  : `${file.oldDisplayPath} → ${file.displayPath}`}
              </Text>
              {file.patch === undefined ? null : (
                <PullRequestDiffStats additions={file.additions} deletions={file.deletions} />
              )}
            </Pressable>
          );
        })}
      </View>
      {summary.warnings.length > 0 ? (
        <Text className="font-sans text-xs leading-normal text-warning-foreground">
          {summary.warnings.join(" ")}
        </Text>
      ) : null}
      {preview ? (
        <View className="gap-1">
          <ScrollView
            nestedScrollEnabled
            className="max-h-60 rounded-xl border border-border bg-subtle px-2 py-1.5"
            accessibilityLabel="Proposed diff"
          >
            {preview.rows.map((row) => (
              <Text
                key={row.line}
                selectable
                className={cn("font-mono text-2xs leading-snug", ROW_TONE[row.kind])}
              >
                {row.text}
              </Text>
            ))}
          </ScrollView>
          {preview.hiddenRows > 0 ? (
            <Pressable accessibilityRole="button" onPress={() => setShowAll(true)}>
              <Text className="font-stark-medium text-xs text-foreground-secondary">
                Show {preview.hiddenRows} more lines
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: detailsOpen }}
        onPress={() => setDetailsOpen((open) => !open)}
      >
        <Text className="font-stark-medium text-xs text-foreground-secondary">
          {detailsOpen ? "Hide technical details" : "Technical details"}
        </Text>
      </Pressable>
      {detailsOpen ? (
        <View className="gap-1">
          {props.detail ? (
            <Text selectable className="font-sans text-xs leading-normal text-foreground-muted">
              {props.detail}
            </Text>
          ) : null}
          {summary.files.map((file) => (
            <Text key={file.path} selectable className="font-mono text-2xs text-foreground-muted">
              {file.oldPath === undefined ? file.path : `${file.oldPath} → ${file.path}`}
              {file.patchTruncated ? " (diff shortened)" : ""}
              {file.approximate ? " (line numbers are approximate)" : ""}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}
