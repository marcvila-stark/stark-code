import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  OrchestrationMessageContext,
  type BrowserCapture,
  type BrowserCaptureDelivery,
} from "@starkfuture/contracts";
import { scopeProjectRef, scopeThreadRef } from "@starkfuture/client-runtime/environment";
import { serializeLegacyContextMessage } from "@starkfuture/shared/composerContextLegacySend";
import { makeThreadFixture } from "../test-fixtures";
import {
  DraftId,
  useComposerDraftStore,
  COMPOSER_DRAFT_STORAGE_KEY,
  verifyBrowserCaptureDraftPersisted,
} from "../composerDraftStore";
import { readProject, readThreadShell, readThreadShells } from "../state/entities";
import { readEnvironmentScope } from "../state/session";
import { buildMessageContext } from "./composerContextRecords";
import { deriveComposerSendState } from "../components/ChatView.logic";
import {
  browserCaptureAnnotation,
  browserCaptureAnnotationId,
  deliverBrowserCapture,
} from "./browserCapture";

const decodeMessageContext = Schema.decodeSync(OrchestrationMessageContext);

const storage = vi.hoisted(() => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
    removeItem: (key: string) => {
      values.delete(key);
    },
    clear: () => values.clear(),
  };
  vi.stubGlobal("localStorage", storage);
  return storage;
});
vi.mock("../state/entities", async (original) => ({
  ...(await original<typeof import("../state/entities")>()),
  readProject: vi.fn(),
  readThreadShell: vi.fn(),
  readThreadShells: vi.fn(),
}));
vi.mock("../state/session", async (original) => ({
  ...(await original<typeof import("../state/session")>()),
  readEnvironmentScope: vi.fn(),
}));
vi.mock("./starkProjectFileDefaults", () => ({ readStarkProjectFile: vi.fn(async () => null) }));

const environmentId = EnvironmentId.make("capture-environment");
const projectId = ProjectId.make("capture-project");
const threadId = ThreadId.make("capture-thread");
const ref = scopeThreadRef(environmentId, threadId);
const project = {
  id: projectId,
  environmentId,
  title: "Capture project",
  workspaceRoot: "/workspace/capture",
  defaultThreadEnvMode: "local" as const,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-11-02T12:00:00.000Z",
  updatedAt: "2026-11-02T12:00:00.000Z",
};
const thread = makeThreadFixture({ environmentId, id: threadId, projectId });
const capture: BrowserCapture = {
  version: 1,
  id: "capture-id",
  kind: "text",
  pageUrl: "https://docs.example.test/payments?retry=1",
  pageTitle: "Payments",
  capturedAt: "2026-11-02T12:00:00.000Z",
  text: "Keep every line.\nIncluding Unicode: café, ✓, 東京.",
  note: "Compare with the retry handler.",
};
const delivery = (patch: Partial<BrowserCapture> = {}): BrowserCaptureDelivery => ({
  capture: { ...capture, ...patch },
  target: { kind: "thread", environmentId, projectId, threadId },
});

beforeEach(() => {
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("window", {
    localStorage: storage,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  });
  storage.clear();
  storage.setItem.mockClear();
  useComposerDraftStore.setState({
    browserCaptureReceipts: {},
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    stickyModelSelectionByProvider: {},
    stickyActiveProvider: null,
  });
  vi.mocked(readProject).mockReturnValue(project);
  vi.mocked(readThreadShell).mockImplementation((target) =>
    target.environmentId === environmentId && target.threadId === threadId ? thread : null,
  );
  vi.mocked(readThreadShells).mockReturnValue([thread]);
  vi.mocked(readEnvironmentScope).mockReturnValue(true);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("browser capture draft delivery", () => {
  it("preserves the chosen chat's prompt and permissions and saves exact source context", async () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(ref, "Keep my existing message.");
    store.setRuntimeMode(ref, "approval-required");
    await deliverBrowserCapture(delivery());
    const draft = store.getComposerDraft(ref)!;
    expect(draft.prompt).toBe("Keep my existing message.");
    expect(draft.runtimeMode).toBe("approval-required");
    expect(draft.previewAnnotations).toHaveLength(1);
    expect(draft.previewAnnotations[0]).toMatchObject({
      pageUrl: capture.pageUrl,
      pageTitle: capture.pageTitle,
    });
    expect(draft.previewAnnotations[0]!.comment).toContain(capture.text);
    expect(draft.previewAnnotations[0]!.comment).toContain(capture.note);
    expect(verifyBrowserCaptureDraftPersisted(ref, draft.previewAnnotations[0]!)).toBe(true);
    const saved = JSON.parse(storage.getItem(COMPOSER_DRAFT_STORAGE_KEY)!);
    expect(saved.state.browserCaptureReceipts[capture.id]).toMatch(/^[a-f0-9]{64}$/);
    expect(saved.state.draftsByThreadKey).toBeDefined();
  });

  it.each(["Keep this existing prompt intact.", ""])(
    "restores the exact prompt %j and browser source after a restart",
    async (prompt) => {
      const store = useComposerDraftStore.getState();
      store.setPrompt(ref, prompt);
      await deliverBrowserCapture(delivery());
      const annotation = store.getComposerDraft(ref)!.previewAnnotations[0]!;

      await useComposerDraftStore.persist.rehydrate();

      const restored = useComposerDraftStore.getState().getComposerDraft(ref)!;
      expect(restored.prompt).toBe(prompt);
      expect(restored.previewAnnotations).toEqual([annotation]);
      expect(verifyBrowserCaptureDraftPersisted(ref, annotation)).toBe(true);
      expect(useComposerDraftStore.getState().browserCaptureReceipts[capture.id]).toMatch(
        /^[a-f0-9]{64}$/,
      );
    },
  );

  it("keeps capture-only drafts sendable and includes exact text/URL in modern and legacy payloads", async () => {
    await deliverBrowserCapture(delivery());
    const draft = useComposerDraftStore.getState().getComposerDraft(ref)!;
    expect(
      deriveComposerSendState({
        prompt: draft.prompt,
        imageCount: 0,
        terminalContexts: [],
        elementContextCount: draft.previewAnnotations.length,
      }).hasSendableContent,
    ).toBe(true);
    expect(draft.prompt).toBe("");
    const context = buildMessageContext({
      terminalContexts: [],
      reviewComments: [],
      previewAnnotations: draft.previewAnnotations,
    })!;
    const decoded = decodeMessageContext(context);
    expect(decoded.records).toHaveLength(1);
    const legacy = serializeLegacyContextMessage({ text: "", records: decoded.records });
    expect(legacy).toContain(capture.text);
    expect(legacy).toContain(capture.pageUrl);
    expect(legacy).toContain(capture.note);
  });

  it("preserves multiline selections at the boundary without losing the structured record", async () => {
    const text = "  leading space\n" + "\n".repeat(5_850) + "final line  \n\n  ";
    await deliverBrowserCapture(delivery({ text, note: "" }));
    const draft = useComposerDraftStore.getState().getComposerDraft(ref)!;
    const context = buildMessageContext({
      terminalContexts: [],
      reviewComments: [],
      previewAnnotations: draft.previewAnnotations,
    })!;
    const decoded = decodeMessageContext(context);
    expect(decoded.records).toHaveLength(1);
    expect(serializeLegacyContextMessage({ text: "", records: decoded.records })).toContain(text);
  });

  it("suppresses a saved-before-ack retry even after the user sends and clears the draft", async () => {
    await deliverBrowserCapture(delivery());
    useComposerDraftStore.getState().clearComposerContent(ref);
    await deliverBrowserCapture(delivery());
    expect(
      useComposerDraftStore.getState().getComposerDraft(ref)?.previewAnnotations ?? [],
    ).toEqual([]);
  });

  it("rejects the same id with changed content or destination", async () => {
    await deliverBrowserCapture(delivery());
    await expect(deliverBrowserCapture(delivery({ note: "Different" }))).rejects.toThrow(
      "different destination or payload",
    );
  });

  it("does not redirect when the chosen chat disappears or project permission is revoked", async () => {
    vi.mocked(readThreadShell).mockReturnValue(null);
    await expect(deliverBrowserCapture(delivery())).rejects.toThrow("no longer available");
    vi.mocked(readThreadShell).mockReturnValue(thread);
    vi.mocked(readEnvironmentScope).mockReturnValue(false);
    await expect(deliverBrowserCapture(delivery())).rejects.toThrow("no longer available");
    expect(useComposerDraftStore.getState().getComposerDraft(ref)).toBeNull();
  });

  it("retries after a real draft-storage failure without duplicating the source", async () => {
    storage.setItem.mockImplementationOnce(() => {
      throw new Error("Quota exceeded");
    });
    await expect(deliverBrowserCapture(delivery())).rejects.toMatchObject({
      message: "Quota exceeded",
      receiptState: "pending",
    });
    await deliverBrowserCapture(delivery());
    expect(useComposerDraftStore.getState().getComposerDraft(ref)?.previewAnnotations).toHaveLength(
      1,
    );
  });

  it("creates a deterministic named draft without changing an existing project's draft", async () => {
    const store = useComposerDraftStore.getState();
    const existing = DraftId.make("existing-draft");
    store.setProjectDraftThreadId(scopeProjectRef(environmentId, projectId), existing);
    store.setPrompt(existing, "Existing work");
    const incoming: BrowserCaptureDelivery = {
      capture,
      target: { kind: "new", environmentId, projectId, title: "Payment reference" },
    };
    await deliverBrowserCapture(incoming);
    const draftId = DraftId.make(`browser-capture-${capture.id}`);
    const session = store.getDraftSession(draftId)!;
    expect(session.title).toBe("Payment reference");
    expect(session.environmentId).toBe(environmentId);
    expect(session.projectId).toBe(projectId);
    expect(session.envMode).toBe("local");
    expect(store.getComposerDraft(existing)?.prompt).toBe("Existing work");
    const saved = JSON.parse(storage.getItem(COMPOSER_DRAFT_STORAGE_KEY)!);
    expect(saved.state.draftThreadsByThreadKey[draftId].title).toBe("Payment reference");
    await deliverBrowserCapture(incoming);
    expect(store.getComposerDraft(draftId)?.previewAnnotations).toHaveLength(1);
  });

  it("keeps a promoted draft bound to the same server chat", async () => {
    const store = useComposerDraftStore.getState(),
      draftId = DraftId.make("promoted-draft");
    store.setProjectDraftThreadId(scopeProjectRef(environmentId, projectId), draftId, { threadId });
    store.markDraftThreadPromoting(draftId, ref);
    await deliverBrowserCapture({
      capture,
      target: { kind: "draft", draftId, environmentId, projectId },
    });
    expect(store.getComposerDraft(ref)?.previewAnnotations).toHaveLength(1);
  });

  it("persists image bytes and binds the source record to that image", async () => {
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => ({ width: 1, height: 1, close: vi.fn() })),
    );
    const imageDataUrl =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aTmcAAAAASUVORK5CYII=";
    const imageDelivery = delivery({ kind: "region", text: "", imageDataUrl });
    await deliverBrowserCapture(imageDelivery);
    const draft = useComposerDraftStore.getState().getComposerDraft(ref)!;
    const id = browserCaptureAnnotationId(capture.id);
    expect(draft.images).toHaveLength(1);
    expect(draft.persistedAttachments[0]).toMatchObject({ id, dataUrl: imageDataUrl });
    expect(draft.previewAnnotations[0]).toEqual(
      browserCaptureAnnotation(imageDelivery.capture, { width: 1, height: 1 }),
    );
    expect(verifyBrowserCaptureDraftPersisted(ref, draft.previewAnnotations[0]!, id)).toBe(true);
    const context = buildMessageContext({
      terminalContexts: [],
      reviewComments: [],
      previewAnnotations: draft.previewAnnotations,
      attachments: [{ attachment: draft.images[0]!, attachmentId: "uploaded-image" }],
    })!;
    const record = context.records.find((item) => item.kind === "preview-annotation");
    expect(record).toMatchObject({ screenshotContextId: `image_${id}` });

    await useComposerDraftStore.persist.rehydrate();
    const restored = useComposerDraftStore.getState().getComposerDraft(ref)!;
    expect(restored.prompt).toBe("");
    expect(restored.images[0]).toMatchObject({ id, previewUrl: imageDataUrl });
    expect(restored.previewAnnotations).toEqual(draft.previewAnnotations);
  });
});
