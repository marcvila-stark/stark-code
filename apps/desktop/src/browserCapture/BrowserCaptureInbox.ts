// @effect-diagnostics nodeBuiltinImport:off -- Atomic native-host inbox persistence is isolated from the Effect lifecycle adapter.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import {
  BrowserCaptureDelivery,
  BrowserCaptureCatalog,
  BrowserCaptureReceipt,
  BROWSER_CAPTURE_MAX_IMAGE_BYTES,
  BROWSER_CAPTURE_MAX_PENDING,
  BROWSER_CAPTURE_MAX_PENDING_BYTES,
} from "@starkfuture/contracts";

const decodeDelivery = Schema.decodeUnknownSync(BrowserCaptureDelivery);
const decodeCatalog = Schema.decodeUnknownSync(BrowserCaptureCatalog);
const decodeReceipt = Schema.decodeUnknownSync(BrowserCaptureReceipt);
const fingerprintSchema = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const storedInbox = Schema.Struct({
  version: Schema.Literal(1),
  pending: Schema.Array(
    Schema.Struct({
      delivery: BrowserCaptureDelivery,
      fingerprint: fingerprintSchema,
      attempted: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  receipts: Schema.Array(
    Schema.Struct({ receipt: BrowserCaptureReceipt, fingerprint: fingerprintSchema }),
  ),
});
const decodeInbox = Schema.decodeUnknownSync(storedInbox);

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}
const fingerprint = (value: unknown) =>
  NodeCrypto.createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex");
type StoredDelivery = { delivery: BrowserCaptureDelivery; fingerprint: string; attempted: boolean };
type StoredReceipt = { receipt: BrowserCaptureReceipt; fingerprint: string };
export type BrowserCaptureDiscardResult = {
  id: string;
  state: "discarded" | "pending" | "saved";
  message: string;
};

function validateImage(delivery: BrowserCaptureDelivery) {
  const url = delivery.capture.imageDataUrl;
  if (!url) return;
  const encoded = url.slice(url.indexOf(",") + 1);
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length > BROWSER_CAPTURE_MAX_IMAGE_BYTES || bytes.toString("base64") !== encoded)
    throw new Error("The captured image exceeds the size limit or is invalid.");
  const png =
    url.startsWith("data:image/png;") &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg =
    url.startsWith("data:image/jpeg;") && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const webp =
    url.startsWith("data:image/webp;") &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP";
  if (!png && !jpeg && !webp) throw new Error("The captured image format is invalid.");
}

export async function writeBrowserCaptureJson(file: string, value: unknown) {
  await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${NodeCrypto.randomUUID()}.tmp`;
  try {
    const handle = await NodeFSP.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(value));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await NodeFSP.rename(temporary, file);
    const directory = await NodeFSP.open(NodePath.dirname(file), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    await NodeFSP.rm(temporary, { force: true });
    throw error;
  }
}

/** Serializes receipt, take and cancel decisions so a cancelled capture cannot land later. */
export class BrowserCaptureInbox {
  private pending = new Map<string, StoredDelivery>();
  private receipts = new Map<string, StoredReceipt>();
  private readonly claimed = new Set<string>();
  private catalog: BrowserCaptureCatalog = { destinations: [], projects: [] };
  private tail: Promise<unknown> = Promise.resolve();
  private storageReadable = true;
  private readonly path: string;
  constructor(path: string) {
    this.path = path;
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => undefined);
    return result;
  }

  async load() {
    this.storageReadable = false;
    let raw: unknown;
    try {
      raw = JSON.parse(await NodeFSP.readFile(this.path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.storageReadable = true;
        return;
      }
      throw new Error("The browser capture inbox could not be read.", { cause: error });
    }
    let stored: typeof storedInbox.Type;
    try {
      stored = decodeInbox(raw);
    } catch (error) {
      throw new Error("The browser capture inbox could not be read.", { cause: error });
    }
    if (
      stored.pending.length > BROWSER_CAPTURE_MAX_PENDING ||
      Buffer.byteLength(JSON.stringify(stored.pending)) > BROWSER_CAPTURE_MAX_PENDING_BYTES
    )
      throw new Error("The browser capture inbox exceeds its storage limit.");
    const pending = new Map<string, StoredDelivery>(),
      receipts = new Map<string, StoredReceipt>();
    for (const item of stored.pending) {
      validateImage(item.delivery);
      if (pending.has(item.delivery.capture.id) || fingerprint(item.delivery) !== item.fingerprint)
        throw new Error("The browser capture inbox could not be read.");
      pending.set(item.delivery.capture.id, { ...item, attempted: item.attempted ?? false });
    }
    for (const item of stored.receipts) {
      if (
        receipts.has(item.receipt.id) ||
        (item.receipt.state === "pending" && !pending.get(item.receipt.id)?.attempted) ||
        (item.receipt.state === "saved" && pending.has(item.receipt.id))
      )
        throw new Error("The browser capture inbox could not be read.");
      receipts.set(item.receipt.id, item);
    }
    this.pending = pending;
    this.receipts = receipts;
    this.claimed.clear();
    this.storageReadable = true;
  }

  publish(catalog: BrowserCaptureCatalog) {
    this.catalog = decodeCatalog(catalog);
  }
  getCatalog() {
    return this.catalog;
  }
  listPending() {
    return [...this.pending.values()].map((item) => item.delivery);
  }
  takePending(environmentIds?: ReadonlyArray<string>): Promise<BrowserCaptureDelivery[]> {
    return this.exclusive(async () => {
      const allowed = environmentIds ? new Set(environmentIds) : null;
      const deliveries = this.listPending().filter(
        ({ capture, target }) =>
          !this.claimed.has(capture.id) &&
          !this.receipts.has(capture.id) &&
          (allowed === null || allowed.has(target.environmentId)),
      );
      if (deliveries.length === 0) return deliveries;
      const selected = new Set(deliveries.map(({ capture }) => capture.id));
      const nextPending = new Map(
        [...this.pending].map(([id, item]) => [
          id,
          selected.has(id) ? { ...item, attempted: true } : item,
        ]),
      );
      // Survives saved-before-ACK crashes: cancellation waits until the renderer resolves an attempted delivery.
      await this.save(nextPending, this.receipts);
      this.pending = nextPending;
      for (const { capture } of deliveries) this.claimed.add(capture.id);
      return deliveries;
    });
  }
  getReceipt(id: string): BrowserCaptureReceipt {
    const receipt = this.receipts.get(id)?.receipt;
    // A paused uncertain save is actionable in Chrome, but remains attempted and cannot be discarded.
    if (receipt?.state === "pending") return { ...receipt, state: "error" };
    return (
      receipt ?? {
        id,
        state: this.pending.has(id) ? "pending" : "error",
        message: this.pending.has(id)
          ? "Waiting for the selected chat draft."
          : "This capture is not in the desktop inbox. Add it again.",
      }
    );
  }

  private ensureReadable() {
    if (!this.storageReadable)
      throw new Error(
        "The existing browser capture inbox needs recovery before new captures can be saved.",
      );
  }

  private save(pending: Map<string, StoredDelivery>, receipts: Map<string, StoredReceipt>) {
    return writeBrowserCaptureJson(this.path, {
      version: 1,
      pending: [...pending.values()],
      receipts: [...receipts.values()],
    });
  }

  submit(raw: unknown): Promise<BrowserCaptureReceipt> {
    return this.exclusive(async () => {
      this.ensureReadable();
      let delivery: BrowserCaptureDelivery;
      try {
        delivery = decodeDelivery(raw);
      } catch {
        throw new Error("The browser capture is invalid or exceeds a limit.");
      }
      validateImage(delivery);
      const id = delivery.capture.id,
        hash = fingerprint(delivery);
      const known = this.pending.get(id) ?? this.receipts.get(id);
      if (known && known.fingerprint !== hash)
        throw new Error(
          "This capture was already assigned to another payload or destination. Create a new capture to change it.",
        );
      const receipt = this.receipts.get(id)?.receipt;
      if (receipt?.state === "saved" || (receipt && !this.pending.has(id))) return receipt;
      if (this.pending.has(id)) {
        if (receipt && !this.claimed.has(id)) {
          const nextReceipts = new Map(this.receipts);
          nextReceipts.delete(id);
          await this.save(this.pending, nextReceipts);
          this.receipts = nextReceipts;
        }
        return this.getReceipt(id);
      }
      const target = delivery.target;
      const eligible =
        target.kind === "new"
          ? this.catalog.projects.some(
              (project) =>
                project.environmentId === target.environmentId &&
                project.projectId === target.projectId,
            ) && target.title.trim().length > 0
          : this.catalog.destinations.some(
              (destination) => fingerprint(destination.target) === fingerprint(target),
            );
      if (!eligible) throw new Error("That destination is unavailable. Choose a chat again.");
      if (this.pending.size >= BROWSER_CAPTURE_MAX_PENDING)
        throw new Error("The capture inbox is full. Finish or delete pending captures first.");
      const next = new Map(this.pending).set(id, { delivery, fingerprint: hash, attempted: false });
      if (Buffer.byteLength(JSON.stringify([...next.values()])) > BROWSER_CAPTURE_MAX_PENDING_BYTES)
        throw new Error("The capture inbox has reached its storage limit.");
      await this.save(next, this.receipts);
      this.pending = next;
      return this.getReceipt(id);
    });
  }

  complete(raw: unknown): Promise<void> {
    return this.exclusive(async () => {
      this.ensureReadable();
      const receipt = decodeReceipt(raw),
        item = this.pending.get(receipt.id);
      if (!item || !this.claimed.has(receipt.id)) return;
      const nextPending = new Map(this.pending);
      if (receipt.state === "saved") nextPending.delete(receipt.id);
      else if (receipt.state === "error")
        nextPending.set(receipt.id, { ...item, attempted: false });
      const nextReceipts = new Map(this.receipts).set(receipt.id, {
        receipt,
        fingerprint: item.fingerprint,
      });
      try {
        await this.save(nextPending, nextReceipts);
        this.pending = nextPending;
        this.receipts = nextReceipts;
      } finally {
        // The durable attempted flag still prevents cancellation after a failed receipt write.
        this.claimed.delete(receipt.id);
      }
    });
  }

  discard(id: string): Promise<BrowserCaptureDiscardResult> {
    return this.exclusive(async () => {
      this.ensureReadable();
      const receipt = this.receipts.get(id)?.receipt;
      if (receipt?.state === "saved") return { ...receipt, state: "saved" };
      if (this.claimed.has(id) || this.pending.get(id)?.attempted)
        return {
          id,
          state: "pending",
          message:
            "Stark is saving this capture. Wait for its receipt before changing the destination.",
        };
      const item = this.pending.get(id);
      if (!item) return { id, state: "discarded", message: "No pending capture remains." };
      const nextPending = new Map(this.pending);
      nextPending.delete(id);
      const nextReceipts = new Map(this.receipts).set(id, {
        receipt: {
          id,
          state: "error" as const,
          message: "This pending capture was deleted. Capture it again to add it.",
        },
        fingerprint: item.fingerprint,
      });
      await this.save(nextPending, nextReceipts);
      this.pending = nextPending;
      this.receipts = nextReceipts;
      return { id, state: "discarded", message: "Pending capture deleted." };
    });
  }
}
