import { assertCapture, checkPendingBudget } from "./protocol.js";
let database;
function open() {
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open("stark-browser-captures", 1);
    request.addEventListener("upgradeneeded", () =>
      request.result.createObjectStore("pending", { keyPath: "capture.id" }),
    );
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () =>
      reject(new Error("Chrome could not open pending capture storage.")),
    );
  });
  return database;
}
async function transaction(mode, operation) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(
      "pending",
      mode,
      mode === "readwrite" ? { durability: "strict" } : undefined,
    );
    let result;
    tx.addEventListener("complete", () => resolve(result));
    const fail = () =>
      reject(tx.error || new Error("Chrome could not save the capture. Nothing was sent."));
    tx.addEventListener("error", fail);
    tx.addEventListener("abort", fail);
    operation(
      tx.objectStore("pending"),
      (value) => {
        result = value;
      },
      tx,
    );
  });
}
export const listPending = () =>
  transaction("readonly", (store, done) => {
    const r = store.getAll();
    r.addEventListener("success", () => done(r.result.sort((a, b) => b.updatedAt - a.updatedAt)));
  });
export const readPending = (id) =>
  transaction("readonly", (store, done) => {
    const r = store.get(id);
    r.addEventListener("success", () => done(r.result || null));
  });
export async function savePending(record, replaceId = null, expectedReplacement = null) {
  assertCapture(record.capture);
  let budgetError;
  try {
    await transaction("readwrite", (store, done, tx) => {
      const request = store.getAll();
      request.addEventListener("success", () => {
        try {
          if (replaceId) {
            const existing = request.result.find((item) => item.capture.id === replaceId);
            if (
              !existing ||
              (expectedReplacement
                ? JSON.stringify(existing) !== JSON.stringify(expectedReplacement)
                : existing.stage !== "review")
            )
              throw new Error("The earlier capture changed. Nothing was replaced.");
          }
          checkPendingBudget(
            replaceId
              ? request.result.filter((item) => item.capture.id !== replaceId)
              : request.result,
            record,
          );
          store.put(record);
          if (replaceId && replaceId !== record.capture.id) store.delete(replaceId);
          done(record);
        } catch (error) {
          budgetError = error;
          tx.abort();
        }
      });
    });
  } catch (error) {
    throw budgetError || error;
  }
  return record;
}
export const deletePending = (id) =>
  transaction("readwrite", (store, done) => {
    store.delete(id);
    done();
  });
