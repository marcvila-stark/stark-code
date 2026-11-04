import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { BrowserCapture, BrowserCaptureTarget, browserCaptureComment } from "./browserCapture.ts";

const capture = {
  version: 1,
  id: "capture",
  kind: "text",
  pageUrl: "https://example.com/source",
  pageTitle: "Example",
  capturedAt: "2026-11-02T00:00:00.000Z",
  text: "Selected text",
  note: "A note",
} as const;
const validCapture = Schema.is(BrowserCapture);
const validTarget = Schema.is(BrowserCaptureTarget);

describe("browser capture contract", () => {
  it("preserves opaque existing environment and chat identifiers without file-name restrictions", () => {
    expect(
      validTarget({
        kind: "thread",
        environmentId: "environment/remote",
        projectId: "project:日本語",
        threadId: "thread.local.1",
      }),
    ).toBe(true);
    expect(
      validTarget({
        kind: "draft",
        environmentId: "environment/remote",
        projectId: "project:日本語",
        draftId: `browser-capture-${"a".repeat(128)}`,
      }),
    ).toBe(true);
  });
  it("requires a source URL without embedded credentials and an actual text/image payload", () => {
    expect(validCapture(capture)).toBe(true);
    expect(validCapture({ ...capture, pageUrl: "javascript:alert(1)" })).toBe(false);
    expect(validCapture({ ...capture, pageUrl: "https://name:password@example.com" })).toBe(false);
    expect(validCapture({ ...capture, text: "" })).toBe(false);
    expect(validCapture({ ...capture, kind: "image" })).toBe(false);
  });
  it("keeps a maximum multiline quote exact and within the page-annotation comment boundary", () => {
    const text = "a\n".repeat(3_000),
      note = "n".repeat(1_000);
    const selected = { ...capture, text, note };
    expect(validCapture(selected)).toBe(true);
    const comment = browserCaptureComment(selected);
    expect(comment).toContain(text);
    expect(comment).toContain(note);
    expect(comment.length).toBeLessThanOrEqual(8_000);
  });
});
