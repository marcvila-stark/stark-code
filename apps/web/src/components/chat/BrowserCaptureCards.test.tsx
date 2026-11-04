import { renderToStaticMarkup } from "react-dom/server";
import { EnvironmentId, ThreadId, type PreviewAnnotationPayload } from "@starkfuture/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { BrowserCaptureCards } from "./BrowserCaptureCards";

const state = vi.hoisted(() => ({
  draft: {
    previewAnnotations: [] as PreviewAnnotationPayload[],
    images: [] as Array<{ id: string; previewUrl: string }>,
  },
}));
vi.mock("../../composerDraftStore", () => ({
  useComposerDraftStore: (
    selector: (store: { getComposerDraft: () => typeof state.draft }) => unknown,
  ) => selector({ getComposerDraft: () => state.draft }),
}));
vi.mock("../../localApi", () => ({ ensureLocalApi: vi.fn() }));

const target = {
  environmentId: EnvironmentId.make("capture-preview-environment"),
  threadId: ThreadId.make("capture-preview-thread"),
};
const annotation: PreviewAnnotationPayload = {
  id: "browser-capture-image",
  pageUrl: "https://example.test/source",
  pageTitle: "Captured source",
  comment: "Compare this region.",
  elements: [],
  regions: [],
  strokes: [],
  styleChanges: [],
  screenshot: { dataUrl: "", width: 1, height: 1, cropRect: { x: 0, y: 0, width: 1, height: 1 } },
  createdAt: "2026-11-02T12:00:00.000Z",
};

beforeEach(() => {
  state.draft = { previewAnnotations: [annotation], images: [] };
});

describe("BrowserCaptureCards", () => {
  it("shows the matching persisted image in expandable source details", () => {
    state.draft.images = [
      { id: "another-image", previewUrl: "data:image/png;base64,BQ==" },
      { id: annotation.id, previewUrl: "data:image/png;base64,AA==" },
    ];
    const markup = renderToStaticMarkup(<BrowserCaptureCards target={target} />);
    expect(markup).toContain('src="data:image/png;base64,AA=="');
    expect(markup).not.toContain("BQ==");
    expect(markup).toContain("View captured image and note");
    expect(markup).toContain('alt="Captured image from Captured source"');
    expect(markup).toContain(annotation.comment);
  });

  it("does not fetch a remote image URL for a local capture preview", () => {
    state.draft.images = [{ id: annotation.id, previewUrl: "https://example.test/private-image" }];
    const markup = renderToStaticMarkup(<BrowserCaptureCards target={target} />);
    expect(markup).not.toContain("private-image");
    expect(markup).not.toContain("<img");
  });
});
