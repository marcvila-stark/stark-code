import { expect, it } from "vite-plus/test";
import { MAX_PAGE_QUOTE_LENGTH, pageSelectionText, readPageSelection } from "./starkPageQuote";

it("preserves quote text as text, normalizes line endings and bounds payloads", () => {
  expect(pageSelectionText("  <script>not markup</script>\r\nNext\u0000  ")).toBe(
    "<script>not markup</script>\nNext",
  );
  expect(pageSelectionText("  ")).toBe("");
  expect(pageSelectionText("x".repeat(MAX_PAGE_QUOTE_LENGTH + 1))).toBeNull();
  expect(pageSelectionText({ text: "not a string" })).toBeNull();
});

it("accepts only the expected selection channel and per-frame token", () => {
  const data = {
    source: "stark-published-page",
    type: "selection",
    selectionToken: "current",
    text: "Quote",
  };
  expect(readPageSelection(data, "stark-published-page", "current")).toEqual({
    text: "Quote",
    tooLong: false,
  });
  expect(readPageSelection(data, "stark-pages", "current")).toBeNull();
  expect(readPageSelection(data, "stark-published-page", "old")).toBeNull();
  expect(
    readPageSelection({ ...data, type: "send" }, "stark-published-page", "current"),
  ).toBeNull();
});

it("accepts an explicit bounded oversize state without accepting any truncated text", () => {
  const packet = {
    source: "stark-pages",
    type: "selection",
    selectionToken: "current",
    text: "",
    tooLong: true,
  };
  expect(readPageSelection(packet, "stark-pages", "current")).toEqual({ text: "", tooLong: true });
  expect(readPageSelection({ ...packet, text: "truncated" }, "stark-pages", "current")).toBeNull();
});
