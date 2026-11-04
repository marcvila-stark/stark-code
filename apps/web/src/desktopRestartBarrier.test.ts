import { scopeThreadRef } from "@starkfuture/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@starkfuture/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  COMPOSER_DRAFT_STORAGE_KEY,
  type ComposerFileAttachment,
  prepareComposerDraftsForRestart,
  useComposerDraftStore,
} from "./composerDraftStore";
import { buildDesktopRestartAck, prepareWindowForDesktopRestart } from "./desktopRestartBarrier";
import { preparePromptStashForRestart, usePromptStashStore } from "./promptStashStore";

const ENVIRONMENT_ID = EnvironmentId.make("restart-env");
const threadRef = scopeThreadRef(ENVIRONMENT_ID, ThreadId.make("restart-thread"));

function makeFile(id: string): ComposerFileAttachment {
  const file = new File([`report ${id}`], `${id}.pdf`, { type: "application/pdf" });
  return { type: "file", id, name: file.name, mimeType: file.type, sizeBytes: file.size, file };
}

/** What a reload would read: the draft store's own persisted storage. */
function storedPrompt(): string | null {
  const stored = useComposerDraftStore.persist
    .getOptions()
    .storage?.getItem(COMPOSER_DRAFT_STORAGE_KEY);
  const text = stored && !(stored instanceof Promise) ? JSON.stringify(stored) : "";
  return text.includes("typed a moment ago") ? "typed a moment ago" : null;
}

function resetStores() {
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    backgroundSubmissionThreadKeys: {},
  });
  usePromptStashStore.setState({ entries: [] });
}

describe("prepareComposerDraftsForRestart", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    resetStores();
    await vi.advanceTimersByTimeAsync(300);
  });
  afterEach(() => {
    resetStores();
    vi.useRealTimers();
  });

  it("writes the last keystrokes now instead of after the debounce", () => {
    useComposerDraftStore.getState().setPrompt(threadRef, "typed a moment ago");
    expect(storedPrompt()).toBeNull();

    const result = prepareComposerDraftsForRestart();
    expect(result.blockers).toEqual([]);
    expect(storedPrompt()).toBe("typed a moment ago");
  });

  it("blocks while a file only exists in memory, and keeps uploaded ones referenced", () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(threadRef, "with files");
    store.addFiles(threadRef, [makeFile("pending"), makeFile("uploaded")]);
    store.setFileUpload(threadRef, "uploaded", ENVIRONMENT_ID, "attachment-1");

    const result = prepareComposerDraftsForRestart();
    expect(result.blockers).toEqual([
      { kind: "upload-in-progress", message: "A file is still uploading.", count: 1 },
    ]);
    expect(result.referencedAttachmentIds).toEqual(["attachment-1"]);
  });

  it("blocks while a message is still sending", () => {
    useComposerDraftStore.setState({
      backgroundSubmissionThreadKeys: { "restart-env:restart-thread": true },
    });
    expect(prepareComposerDraftsForRestart().blockers).toEqual([
      { kind: "send-in-progress", message: "A message is still sending.", count: 1 },
    ]);
  });
});

describe("preparePromptStashForRestart", () => {
  afterEach(resetStores);

  it("blocks while a stashed image is still being encoded", () => {
    usePromptStashStore.setState({
      entries: [
        {
          id: "stash-1",
          createdAt: "2026-10-30T14:00:00.000Z",
          prompt: "stashed",
          attachments: [],
          droppedImageNames: [],
          pendingImageCount: 2,
        },
      ],
    });
    // Unit tests run on in-memory storage, which a restart would also lose.
    expect(preparePromptStashForRestart().blockers).toEqual([
      { kind: "image-encoding", message: "A stashed image is still being saved.", count: 2 },
      { kind: "storage-failed", message: "The prompt stash couldn't be saved." },
    ]);
  });
});

describe("prepareWindowForDesktopRestart", () => {
  const request = { requestId: "restart-1", version: "1.2.4" };

  it("answers saved only when nothing could be lost", async () => {
    const ack = await prepareWindowForDesktopRestart(request, {
      settle: async () => {},
      prepareDrafts: () => ({ blockers: [], referencedAttachmentIds: ["a", "b"] }),
      prepareStash: () => ({ blockers: [], referencedAttachmentIds: ["b", "c"] }),
    });
    expect(ack).toEqual({
      requestId: "restart-1",
      outcome: "saved",
      blockers: [],
      referencedAttachmentIds: ["a", "b", "c"],
    });
  });

  it("hands the stored drafts and stash to the backup", async () => {
    const ack = await prepareWindowForDesktopRestart(request, {
      settle: async () => {},
      prepareDrafts: () => ({
        blockers: [],
        referencedAttachmentIds: [],
        storedJson: '{"version":9}',
      }),
      prepareStash: () => ({ blockers: [], referencedAttachmentIds: [], storedJson: null }),
    });
    expect(ack.draftsJson).toBe('{"version":9}');
    expect(ack).not.toHaveProperty("stashJson");
  });

  it("answers failed when saving throws, which aborts the restart", async () => {
    const ack = await prepareWindowForDesktopRestart(request, {
      settle: async () => {},
      prepareDrafts: () => {
        throw new Error("quota exceeded");
      },
      prepareStash: () => ({ blockers: [], referencedAttachmentIds: [] }),
    });
    expect(ack.outcome).toBe("failed");
    expect(ack.blockers[0]?.kind).toBe("storage-failed");
  });

  it("merges every blocker into one failed answer", () => {
    expect(
      buildDesktopRestartAck("restart-1", [
        {
          blockers: [{ kind: "upload-in-progress", message: "uploading", count: 1 }],
          referencedAttachmentIds: [],
        },
        {
          blockers: [{ kind: "image-encoding", message: "encoding", count: 1 }],
          referencedAttachmentIds: [],
        },
      ]).blockers.map((blocker) => blocker.kind),
    ).toEqual(["upload-in-progress", "image-encoding"]);
  });
});
