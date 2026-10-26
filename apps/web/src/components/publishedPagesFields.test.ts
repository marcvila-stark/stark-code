import { describe, expect, it } from "vite-plus/test";
import {
  decodePublishedPageText,
  publishedPageArguments,
  publishedPageFields,
} from "./publishedPagesFields";

describe("published Pages read fields", () => {
  it("uses live schema fields and omits unfilled optional arguments", () => {
    const fields = publishedPageFields({
      type: "object",
      properties: {
        root: { type: "string", title: "Project" },
        path: { type: "string" },
        limit: { type: "integer" },
        recursive: { type: "boolean" },
      },
      required: ["root", "path"],
    });
    expect(fields?.map((field) => field.label)).toEqual(["Project", "Path", "Limit", "Recursive"]);
    expect(publishedPageArguments(fields!, { root: "team", path: "report/index.html" })).toEqual({
      root: "team",
      path: "report/index.html",
    });
    expect(
      publishedPageArguments(fields!, {
        root: "team",
        path: "report",
        limit: "5",
        recursive: "false",
      }),
    ).toEqual({ root: "team", path: "report", limit: 5, recursive: false });
  });
  it("does not guess complex required arguments", () => {
    expect(
      publishedPageFields({
        type: "object",
        properties: { filter: { type: "object" } },
        required: ["filter"],
      }),
    ).toBeNull();
    expect(publishedPageFields({ type: "object", required: ["missing"] })).toBeNull();
    expect(publishedPageFields({ type: "object", oneOf: [] })).toBeNull();
  });
  it("shows nullable scalar fields from MCP schemas without guessing union shapes", () => {
    const fields = publishedPageFields({
      type: "object",
      properties: {
        root: { anyOf: [{ type: "string" }, { type: "null" }], title: "Project" },
        limit: { type: ["integer", "null"] },
      },
    });
    expect(fields?.map((field) => field.type)).toEqual(["string", "integer"]);
    expect(publishedPageArguments(fields!, { root: "company", limit: "10" })).toEqual({
      root: "company",
      limit: 10,
    });
  });
  it("rejects missing fields, invalid booleans and nonfinite or fractional integers", () => {
    const field = {
      name: "limit",
      label: "Limit",
      type: "integer" as const,
      required: true,
      description: "",
    };
    for (const value of ["", "NaN", "Infinity", "1.5"])
      expect(() => publishedPageArguments([field], { limit: value })).toThrow();
    expect(() =>
      publishedPageArguments([{ ...field, type: "boolean" }], { limit: "yes" }),
    ).toThrow();
  });
  it("supports string choices and parses JSON text without corrupting markdown", () => {
    const fields = publishedPageFields({
      type: "object",
      properties: { format: { type: "string", enum: ["html", "markdown"] } },
    });
    expect(publishedPageArguments(fields!, { format: "html" })).toEqual({ format: "html" });
    expect(() => publishedPageArguments(fields!, { format: "javascript" })).toThrow();
    expect(decodePublishedPageText('[{"title":"Report"}]')).toEqual([{ title: "Report" }]);
    expect(decodePublishedPageText("[Report](https://pages.starkfuture.com)")).toBe(
      "[Report](https://pages.starkfuture.com)",
    );
  });
});
