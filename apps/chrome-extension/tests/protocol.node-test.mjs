import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import { cleanSourceUrl, assertCapture, cropPixels, checkPendingBudget } from "../src/protocol.js";
const capture = {
  version: 1,
  id: "fixture-1",
  kind: "text",
  pageUrl: "https://example.com/docs?lang=en#retries",
  pageTitle: "Docs",
  capturedAt: "2026-11-02T00:00:00.000Z",
  text: "Quoted text\nwith Unicode: ✓",
  note: "Compare this.",
};
NodeTest.test(
  "source preserves ordinary parameters while removing credentials and OAuth fragments",
  () => {
    NodeAssert.equal(
      cleanSourceUrl(
        "https://user:password@example.com/docs?lang=en&access_token=private#id_token=private&section=retry",
      ),
      "https://example.com/docs?lang=en#section=retry",
    );
    NodeAssert.throws(() => cleanSourceUrl("chrome://settings"));
  },
);
NodeTest.test(
  "text and note limits reject excess content without shortening valid selection",
  () => {
    NodeAssert.equal(assertCapture(capture).text, capture.text);
    NodeAssert.throws(
      () => assertCapture({ ...capture, text: "x".repeat(6001) }),
      /Nothing was shortened/,
    );
    NodeAssert.throws(() => assertCapture({ ...capture, note: "x".repeat(1001) }));
    NodeAssert.throws(() =>
      assertCapture({ ...capture, pageUrl: "https://example.com/?token=hidden" }),
    );
  },
);
NodeTest.test(
  "Retina crop derives pixels from the screenshot dimensions, independently of page scale",
  () => {
    NodeAssert.deepEqual(
      cropPixels(
        { x: 10, y: 20, width: 200, height: 80 },
        { width: 1000, height: 700 },
        { width: 2000, height: 1400 },
      ),
      { x: 20, y: 40, width: 400, height: 160 },
    );
  },
);
NodeTest.test(
  "zoomed fractional crop includes the selected visible pixels and clips viewport edges",
  () => {
    NodeAssert.deepEqual(
      cropPixels(
        { x: 10.3, y: 20.1, width: 4.4, height: 5.3 },
        { width: 800, height: 600 },
        { width: 1200, height: 900 },
      ),
      { x: 15, y: 30, width: 8, height: 9 },
    );
    NodeAssert.deepEqual(
      cropPixels(
        { x: -4, y: 590, width: 30, height: 20 },
        { width: 800, height: 600 },
        { width: 800, height: 600 },
      ),
      { x: 0, y: 590, width: 26, height: 10 },
    );
    NodeAssert.throws(() =>
      cropPixels(
        { x: 1, y: 1, width: 0, height: 4 },
        { width: 800, height: 600 },
        { width: 800, height: 600 },
      ),
    );
  },
);
NodeTest.test(
  "full pending queue refuses new captures but permits updating an existing one",
  () => {
    const records = Array.from({ length: 20 }, (_, i) => ({
      capture: { ...capture, id: `id-${i}` },
    }));
    NodeAssert.throws(() => checkPendingBudget(records, { capture }), /20 pending/);
    NodeAssert.doesNotThrow(() =>
      checkPendingBudget(records, { capture: { ...capture, id: "id-3", note: "Updated" } }),
    );
  },
);
