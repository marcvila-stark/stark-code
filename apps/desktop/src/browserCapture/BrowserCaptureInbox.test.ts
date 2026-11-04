// @effect-diagnostics nodeBuiltinImport:off -- Tests exercise actual atomic inbox files in private temporary directories.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { BrowserCaptureDelivery, BrowserCaptureCatalog } from "@starkfuture/contracts";
import { BrowserCaptureInbox } from "./BrowserCaptureInbox.ts";

const target = {
  kind: "thread",
  environmentId: "environment",
  projectId: "project",
  threadId: "thread",
} as const;
const catalog: BrowserCaptureCatalog = {
  destinations: [
    {
      target,
      label: "A chat",
      projectLabel: "A project",
      environmentLabel: "This Mac",
      current: true,
    },
  ],
  projects: [
    {
      environmentId: "environment",
      projectId: "project",
      label: "A project",
      environmentLabel: "This Mac",
    },
  ],
};
const delivery = (id = "capture"): BrowserCaptureDelivery => ({
  capture: {
    version: 1,
    id,
    kind: "text",
    pageUrl: "https://example.com/source",
    pageTitle: "Source",
    capturedAt: "2026-11-02T00:00:00.000Z",
    text: "An exact quote.\nWith a second line.",
    note: "Compare this.",
  },
  target,
});
const directories: string[] = [];
async function fixture() {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "stark-inbox-test-"));
  directories.push(directory);
  const path = NodePath.join(directory, "inbox.json"),
    inbox = new BrowserCaptureInbox(path);
  await inbox.load();
  inbox.publish(catalog);
  return { directory, path, inbox };
}
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => NodeFSP.rm(directory, { recursive: true, force: true })),
  );
});

describe("browser capture durable inbox", () => {
  it("persists before acknowledging and recovers exact pinned payload after restart", async () => {
    const { path, inbox } = await fixture();
    const item = delivery();
    expect((await inbox.submit(item)).state).toBe("pending");
    const restored = new BrowserCaptureInbox(path);
    await restored.load();
    expect(await restored.takePending()).toEqual([item]);
    expect(await restored.takePending()).toEqual([]);
    await restored.complete({ id: "capture", state: "saved", message: "Saved to A chat." });
    const again = new BrowserCaptureInbox(path);
    await again.load();
    again.publish(catalog);
    expect((await again.submit(item)).state).toBe("saved");
    expect(again.listPending()).toEqual([]);
    expect((await NodeFSP.stat(path)).mode & 0o777).toBe(0o600);
  });
  it("deduplicates canonical payloads and refuses an id reused for another destination or quote", async () => {
    const { inbox } = await fixture();
    const item = delivery();
    await inbox.submit(item);
    await inbox.submit({
      target: {
        threadId: "thread",
        projectId: "project",
        environmentId: "environment",
        kind: "thread",
      },
      capture: item.capture,
    });
    expect(inbox.listPending()).toHaveLength(1);
    await expect(
      inbox.submit({ ...item, target: { ...target, threadId: "other" } }),
    ).rejects.toThrow("another payload or destination");
    await expect(
      inbox.submit({ ...item, capture: { ...item.capture, text: "Changed quote" } }),
    ).rejects.toThrow("another payload or destination");
  });
  it("rejects stale or wrong-environment destinations before accepting bytes", async () => {
    const { inbox } = await fixture();
    await expect(
      inbox.submit({ ...delivery(), target: { ...target, environmentId: "other" } }),
    ).rejects.toThrow("destination is unavailable");
    await expect(
      inbox.submit({
        ...delivery(),
        target: { kind: "new", environmentId: "other", projectId: "project", title: "New" },
      }),
    ).rejects.toThrow("destination is unavailable");
    expect(inbox.listPending()).toEqual([]);
  });
  it("pauses failed deliveries until explicit retry and keeps bytes through restart", async () => {
    const { path, inbox } = await fixture();
    const item = delivery();
    await inbox.submit(item);
    await inbox.takePending();
    await inbox.complete({ id: "capture", state: "error", message: "Draft storage is full." });
    expect(await inbox.takePending()).toEqual([]);
    expect(inbox.listPending()).toEqual([item]);
    const restored = new BrowserCaptureInbox(path);
    await restored.load();
    expect(restored.getReceipt("capture").state).toBe("error");
    expect(await restored.takePending()).toEqual([]);
    expect((await restored.submit(item)).state).toBe("pending");
    expect(await restored.takePending()).toEqual([item]);
  });
  it("refuses cancellation once handed to the renderer, then preserves a saved draft", async () => {
    const { inbox } = await fixture();
    await inbox.submit(delivery());
    const [taken, discarded] = await Promise.all([inbox.takePending(), inbox.discard("capture")]);
    expect(taken).toHaveLength(1);
    expect(discarded.state).toBe("pending");
    await inbox.complete({ id: "capture", state: "saved", message: "Saved" });
    expect((await inbox.discard("capture")).state).toBe("saved");
  });
  it("does not falsely cancel a potentially saved capture after restart", async () => {
    const { path, inbox } = await fixture();
    await inbox.submit(delivery());
    await inbox.takePending();
    const restored = new BrowserCaptureInbox(path);
    await restored.load();
    expect((await restored.discard("capture")).state).toBe("pending");
    expect(await restored.takePending()).toEqual([delivery()]);
    await restored.complete({
      id: "capture",
      state: "saved",
      message: "Renderer receipt recovered",
    });
    expect((await restored.discard("capture")).state).toBe("saved");
  });
  it("releases a failed receipt claim for retry while its durable attempt still prevents false cancellation", async () => {
    const { path, inbox } = await fixture();
    await inbox.submit(delivery());
    await inbox.takePending();
    const backup = path + ".backup";
    await NodeFSP.rename(path, backup);
    await NodeFSP.mkdir(path);
    try {
      await expect(
        inbox.complete({ id: "capture", state: "saved", message: "Saved" }),
      ).rejects.toThrow();
    } finally {
      await NodeFSP.rm(path, { recursive: true });
      await NodeFSP.rename(backup, path);
    }
    expect((await inbox.discard("capture")).state).toBe("pending");
    expect(await inbox.takePending()).toEqual([delivery()]);
    await inbox.complete({ id: "capture", state: "saved", message: "Recovered" });
    expect(inbox.getReceipt("capture").state).toBe("saved");
  });
  it("pauses an uncertain renderer save while retaining the durable attempt and allowing explicit retry", async () => {
    const { path, inbox } = await fixture();
    const item = delivery();
    await inbox.submit(item);
    await inbox.takePending();
    await inbox.complete({
      id: "capture",
      state: "pending",
      message: "The draft may be saved. Retry to verify it.",
    });
    expect(inbox.getReceipt("capture")).toEqual({
      id: "capture",
      state: "error",
      message: "The draft may be saved. Retry to verify it.",
    });
    expect(await inbox.takePending()).toEqual([]);
    expect((await inbox.discard("capture")).state).toBe("pending");
    const restored = new BrowserCaptureInbox(path);
    await restored.load();
    expect(await restored.takePending()).toEqual([]);
    expect((await restored.discard("capture")).state).toBe("pending");
    expect((await restored.submit(item)).state).toBe("pending");
    expect(await restored.takePending()).toEqual([item]);
    await restored.complete({ id: "capture", state: "saved", message: "Verified" });
    expect(restored.getReceipt("capture").state).toBe("saved");
  });
  it("atomically cancels queued or failed captures without allowing a late take or old-id retry", async () => {
    const { path, inbox } = await fixture();
    const item = delivery();
    await inbox.submit(item);
    const [discarded, taken] = await Promise.all([inbox.discard("capture"), inbox.takePending()]);
    expect(discarded.state).toBe("discarded");
    expect(taken).toEqual([]);
    await inbox.complete({ id: "capture", state: "saved", message: "Late acknowledgement" });
    expect(inbox.getReceipt("capture").state).toBe("error");
    expect((await inbox.submit(item)).state).toBe("error");
    const restored = new BrowserCaptureInbox(path);
    await restored.load();
    expect(restored.listPending()).toEqual([]);
  });
  it("rejects oversize and invalid image payloads without accepting them", async () => {
    const { inbox } = await fixture();
    await expect(
      inbox.submit({ ...delivery(), capture: { ...delivery().capture, text: "x".repeat(6_001) } }),
    ).rejects.toThrow("invalid or exceeds");
    await expect(
      inbox.submit({
        ...delivery(),
        capture: {
          ...delivery().capture,
          kind: "image",
          imageDataUrl: "data:image/png;base64,aGVsbG8=",
        },
      }),
    ).rejects.toThrow("format is invalid");
    const tooLarge = Buffer.alloc(4 * 1024 * 1024 + 1);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(tooLarge);
    await expect(
      inbox.submit({
        ...delivery(),
        capture: {
          ...delivery().capture,
          kind: "image",
          imageDataUrl: "data:image/png;base64," + tooLarge.toString("base64"),
        },
      }),
    ).rejects.toThrow("size limit");
    expect(inbox.listPending()).toEqual([]);
  });
  it("does not acknowledge or retain an accepted item when persistence fails", async () => {
    const { directory } = await fixture();
    const parent = NodePath.join(directory, "not-a-directory");
    await NodeFSP.writeFile(parent, "x");
    const inbox = new BrowserCaptureInbox(NodePath.join(parent, "inbox.json"));
    inbox.publish(catalog);
    await expect(inbox.submit(delivery())).rejects.toThrow();
    expect(inbox.listPending()).toEqual([]);
    expect(inbox.getReceipt("capture").state).toBe("error");
  });
  it("leaves disconnected environments unclaimed until the renderer is ready", async () => {
    const { inbox } = await fixture();
    await inbox.submit(delivery());
    expect(await inbox.takePending([])).toEqual([]);
    expect(await inbox.takePending(["other"])).toEqual([]);
    expect(await inbox.takePending(["environment"])).toEqual([delivery()]);
  });
  it("preserves a corrupted existing inbox rather than overwriting pending user data", async () => {
    const { path } = await fixture();
    const raw = "{broken capture data";
    await NodeFSP.writeFile(path, raw);
    const inbox = new BrowserCaptureInbox(path);
    await expect(inbox.load()).rejects.toThrow();
    inbox.publish(catalog);
    await expect(inbox.submit(delivery())).rejects.toThrow("needs recovery");
    expect(await NodeFSP.readFile(path, "utf8")).toBe(raw);
  });
  it("enforces the pending count while preserving existing captures", async () => {
    const { inbox } = await fixture();
    for (let index = 0; index < 20; index++) await inbox.submit(delivery(`capture-${index}`));
    await expect(inbox.submit(delivery("too-many"))).rejects.toThrow("inbox is full");
    expect(inbox.listPending()).toHaveLength(20);
  });
});
