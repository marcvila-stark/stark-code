import { describe, expect, it } from "vite-plus/test";
import type { Root } from "mdast";
import { readerScreenshotPath, remarkReaderScreenshots } from "./readerScreenshots";

describe("Reader screenshot containment", () => {
  it.each([
    ["/work/project/screens/before.png", "/work/project", "screens/before.png"],
    ["./screens/../after.webp", "/work/project", "after.webp"],
    ["Screenshot 2026-10-17.png", "/work/project", "Screenshot 2026-10-17.png"],
    ["C:\\Work\\Project\\shots\\after.png", "c:\\work\\project", "shots/after.png"],
    ["/work/project-extra/secret.png", "/work/project", null],
    ["/work/project/../private/secret.png", "/work/project", null],
    ["../private/secret.png", "/work/project", null],
    ["~/private/secret.png", "/work/project", null],
    ["https://images.test/secret.png", "/work/project", null],
    ["//images.test/secret.png", "/work/project", null],
    ["file:///work/project/after.png", "/work/project", null],
    ["D:\\private\\secret.png", "C:\\work", null],
    ["file.png?token=123", "/work/project", null],
  ])("resolves %s within %s", (candidate, cwd, expected) => {
    expect(readerScreenshotPath(candidate, cwd)).toBe(expected);
  });

  it("retains source nodes and adds only one preview per workspace screenshot", () => {
    const original: Root = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [{ type: "text", value: 'Before: "/repo/screens/before view.png".' }],
        },
        { type: "paragraph", children: [{ type: "inlineCode", value: "screens/after.png" }] },
        {
          type: "paragraph",
          children: [{ type: "text", value: "Again: /repo/screens/after.png" }],
        },
        { type: "code", value: "screens/example.png", lang: "sh" },
        {
          type: "paragraph",
          children: [{ type: "image", url: "screens/authored.png", alt: "Authored" }],
        },
        {
          type: "paragraph",
          children: [{ type: "inlineCode", value: "/repo/screens/authored.png" }],
        },
      ],
    };
    const tree = structuredClone(original);
    remarkReaderScreenshots({ cwd: "/repo" })(tree);
    const images = tree.children.flatMap((child) =>
      child.type === "paragraph" ? child.children.filter((item) => item.type === "image") : [],
    );
    expect(images.map((image) => image.url)).toEqual([
      "screens/before view.png",
      "screens/after.png",
      "screens/authored.png",
    ]);
    for (const child of original.children) expect(tree.children).toContainEqual(child);
  });

  it("bounds automatic previews and skips source expressions, remote URLs, and outside files", () => {
    const tree: Root = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            {
              type: "text",
              value:
                "/other/private.png https://images.test/x.png src=logo.png dev@x.png " +
                Array.from({ length: 20 }, (_, index) => `screens/${index}.png`).join(" "),
            },
          ],
        },
      ],
    };
    remarkReaderScreenshots({ cwd: "/repo" })(tree);
    expect(tree.children).toHaveLength(13);
    expect(tree.children[1]).toMatchObject({ children: [{ url: "screens/0.png" }] });
    expect(tree.children[12]).toMatchObject({ children: [{ url: "screens/11.png" }] });
  });
});
