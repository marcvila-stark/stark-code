import { MessageId, RunId } from "@starkfuture/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { TimelineEntry, WorkLogEntry } from "../../session-logic";
import {
  computeStableMessagesTimelineRows,
  deriveMessagesTimelineRows,
} from "./MessagesTimeline.logic";

const at = "2026-10-26T12:00:00.000Z";
const page = (id: string, run: string | null = "turn"): TimelineEntry => ({
  kind: "html-render",
  id,
  createdAt: at,
  runId: run === null ? null : RunId.make(run),
  htmlRender: { attachmentId: id, title: id, height: 400 },
});
const rows = (timelineEntries: TimelineEntry[], expanded = false) =>
  deriveMessagesTimelineRows({
    timelineEntries,
    isWorking: false,
    turnDiffSummaries: [],
    supportsConversationRollback: false,
    expandedRunIds: expanded ? new Set([RunId.make("turn")]) : new Set(),
  });
const activity = (
  status: NonNullable<WorkLogEntry["toolLifecycleStatus"]>,
  itemType: NonNullable<WorkLogEntry["itemType"]> = "approval_request",
  detail = 'Allow the stark-code MCP server to run tool "html_render"?',
): TimelineEntry => ({
  kind: "work",
  id: "approval",
  createdAt: at,
  entry: {
    id: "approval",
    createdAt: at,
    runId: RunId.make("turn"),
    label: "Approval requested",
    tone: "tool",
    toolLifecycleStatus: status,
    itemType,
    detail,
  },
});

describe("inline HTML preview grouping", () => {
  it("groups adjacent pages from one turn in their original order", () => {
    const result = rows([page("desktop"), page("mobile")]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      kind: "html-render",
      id: "desktop",
      htmlRenders: [{ attachmentId: "desktop" }, { attachmentId: "mobile" }],
    });
  });

  it("keeps separate turns and unknown-turn previews separate", () => {
    expect(rows([page("first", "one"), page("second", "two")])).toHaveLength(2);
    expect(rows([page("first", null), page("second", null)])).toHaveLength(2);
  });

  it("groups across a completed approval while retaining the approval in Activity", () => {
    const result = rows([page("before"), activity("completed"), page("after")]);
    expect(result.filter((row) => row.kind === "html-render")).toMatchObject([
      { htmlRenders: [{ attachmentId: "before" }, { attachmentId: "after" }] },
    ]);
    expect(result.some((row) => row.kind === "turn-fold")).toBe(true);
    const expanded = rows([page("before"), activity("completed"), page("after")], true);
    const entries = expanded.flatMap((row) =>
      row.kind === "work" || row.kind === "work-live" ? row.groupedEntries : [],
    );
    expect(entries).toContainEqual(
      expect.objectContaining({ id: "approval", itemType: "approval_request" }),
    );
  });

  it.each(["inProgress", "declined", "failed", "stopped"] as const)(
    "does not group across a %s approval",
    (status) => {
      expect(
        rows([page("before"), activity(status), page("after")]).filter(
          (row) => row.kind === "html-render",
        ),
      ).toHaveLength(2);
    },
  );

  it("does not group across unrelated completed work", () => {
    expect(
      rows([page("before"), activity("completed", "command_execution"), page("after")]).filter(
        (row) => row.kind === "html-render",
      ),
    ).toHaveLength(2);
  });

  it("does not group across an unrelated completed approval", () => {
    expect(
      rows([
        page("before"),
        activity(
          "completed",
          "approval_request",
          'Allow the stark-code MCP server to run tool "publish_page"?',
        ),
        page("after"),
      ]).filter((row) => row.kind === "html-render"),
    ).toHaveLength(2);
  });

  it("does not move captions or prose between previews", () => {
    const result = rows([
      page("before"),
      {
        kind: "message",
        id: "caption",
        createdAt: at,
        message: {
          id: MessageId.make("caption"),
          role: "assistant",
          text: "The next preview is the mobile version.",
          runId: RunId.make("turn"),
          streaming: true,
          createdAt: at,
          updatedAt: at,
        },
      },
      page("after"),
    ]);
    expect(
      result
        .filter((row) => row.kind === "html-render" || row.kind === "message")
        .map((row) => row.kind),
    ).toEqual(["html-render", "message", "html-render"]);
    expect(
      result.filter((row) => row.kind === "html-render").every((row) => !row.htmlRenders),
    ).toBe(true);
  });

  it("retains the mounted gallery for equal references but updates when another page arrives", () => {
    const first = computeStableMessagesTimelineRows(rows([page("one"), page("two")]), {
      byId: new Map(),
      result: [],
    });
    expect(computeStableMessagesTimelineRows(rows([page("one"), page("two")]), first)).toBe(first);
    const appended = computeStableMessagesTimelineRows(
      rows([page("one"), page("two"), page("three")]),
      first,
    );
    expect(appended.result[0]).not.toBe(first.result[0]);
    expect(appended.result[0]).toMatchObject({
      htmlRenders: [{ title: "one" }, { title: "two" }, { title: "three" }],
    });
  });
});
