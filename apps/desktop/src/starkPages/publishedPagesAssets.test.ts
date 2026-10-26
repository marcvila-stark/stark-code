// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it, vi } from "vite-plus/test";
import {
  downloadPageAsset,
  isPagesDownloadUrl,
  loadPublishedPage,
  pageAssetPath,
  pageResourcePath,
  PAGES_ASSET_BYTES,
  PAGES_DOCUMENT_BYTES,
} from "./publishedPagesAssets.ts";
import { PublishedPagesFailure } from "./publishedPagesPolicy.ts";

const signed =
  "https://vibecoded-apps.s3.eu-west-1.amazonaws.com/apps/pages-dd380189/objects/c7/1234-abcd?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=secret";
const result = (structuredContent: Record<string, string | number | boolean>) => ({
  content: [],
  structuredContent,
  isError: false,
});
const text = (source: string, type = "text/html") =>
  result({ kind: "text", text: source, content_type: type, truncated: false });

describe("Published Pages asset boundary", () => {
  it("resolves shared relative assets while rejecting traversal and URL schemes", () => {
    expect(pageAssetPath("../_stark/theme.css?v=2#font", "guide/index.html")).toBe(
      "_stark/theme.css",
    );
    expect(pageAssetPath("img/space%20name.png", "guide/index.html")).toBe(
      "guide/img/space name.png",
    );
    expect(pageAssetPath("/_stark/theme.css", "guide/index.html")).toBe("_stark/theme.css");
    for (const path of [
      "../../private",
      "../%2e%2e/private",
      "%252e%252e/private",
      "https://other.invalid/steal",
      "//other.invalid/img",
      "file:///secret",
      "data:image/png,a",
      "img\\file",
      "%00.png",
      "%2f%2fevil/x",
    ])
      expect(pageAssetPath(path, "guide/index.html")).toBeNull();
  });

  it("resolves only the selected project in absolute published URLs", () => {
    expect(
      pageResourcePath(
        "https://pages.starkfuture.com/handbook/_stark/theme.css?v=2",
        "guide/index.html",
        "handbook",
      ),
    ).toBe("_stark/theme.css");
    expect(pageResourcePath("/handbook/_stark/theme.css", "guide/index.html", "handbook")).toBe(
      "_stark/theme.css",
    );
    expect(pageResourcePath("/_stark/theme.css", "guide/index.html", "handbook")).toBe(
      "_stark/theme.css",
    );
    for (const path of [
      "https://pages.starkfuture.com/other/secret.png",
      "https://pages.starkfuture.com/handbook/../other/secret.png",
      "https://pages.starkfuture.com/handbook/%2e%2e/other/secret.png",
      "https://user@pages.starkfuture.com/handbook/photo.png",
    ])
      expect(pageResourcePath(path, "index.html", "handbook")).toBeNull();
  });

  it("accepts only signed object downloads from the pinned storage host", () => {
    expect(isPagesDownloadUrl(signed)).toBe(true);
    for (const url of [
      signed.replace("https:", "http:"),
      signed.replace(".com/", ".com.evil/"),
      signed.replace("https://", "https://secret@"),
      `${signed}#hash`,
      signed.replace("/objects/", "/private/"),
      signed.replace("AWS4-HMAC-SHA256", "none"),
      "https://127.0.0.1/private",
    ])
      expect(isPagesDownloadUrl(url)).toBe(false);
  });

  it("downloads without cookies/authentication and refuses redirects or streamed oversize data", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(new Uint8Array([1, 2, 3])));
    expect(Array.from(await downloadPageAsset(signed, fetcher))).toEqual([1, 2, 3]);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      credentials: "omit",
      redirect: "manual",
    });
    expect(fetcher.mock.calls[0]?.[1]).not.toHaveProperty("headers");
    await expect(
      downloadPageAsset(
        signed,
        async () =>
          new Response(null, { status: 302, headers: { location: "https://evil.invalid" } }),
      ),
    ).rejects.toThrow();
    await expect(
      downloadPageAsset(signed, async () => new Response(new Uint8Array(PAGES_ASSET_BYTES + 1))),
    ).rejects.toThrow("too large");
    const unused = vi.fn();
    await expect(downloadPageAsset("https://other.invalid", unused)).rejects.toThrow(
      "not supported",
    );
    expect(unused).not.toHaveBeenCalled();
  });

  it("loads nested styles, images and fonts from the same root and leaves scripts and external URLs alone", async () => {
    const files: Record<string, ReturnType<typeof text>> = {
      "guide/index.html": text(
        `<link rel="stylesheet" href="../_stark/theme.css"><script src="../secret.js"></script><iframe src="../frame.html"></iframe><img src="img/photo.jpg"><img srcset="img/photo.jpg 1x, img/photo-2.jpg 2x"><style>.hero{background:url('img/bg.png')}</style><link rel="stylesheet" href="https://fonts.invalid/theme.css">`,
      ),
      "_stark/theme.css": text(
        `@import "more.css"; @font-face{src:url('../font.woff2')} .x{background:url('../guide/img/photo.jpg')}`,
        "text/css",
      ),
      "_stark/more.css": text(`@import 'theme.css'; p{color:red}`, "text/css"),
      "guide/img/photo.jpg": result({ kind: "download", content_type: "image/jpeg", url: signed }),
      "guide/img/photo-2.jpg": result({
        kind: "download",
        content_type: "image/jpeg",
        url: signed,
      }),
      "guide/img/bg.png": result({ kind: "download", content_type: "image/png", url: signed }),
      "font.woff2": result({ kind: "download", content_type: "font/woff2", url: signed }),
    };
    const read = vi.fn(async (tool: string, args: Record<string, string>) => {
      expect(args.root).toBe("handbook");
      if (tool === "pages_get_public_url")
        return result({ url: "https://pages.starkfuture.com/handbook/guide/index.html" });
      if (!files[args.path!]) throw new Error("not found");
      return files[args.path!]!;
    });
    const document = await loadPublishedPage({
      root: "handbook",
      path: "guide/index.html",
      read,
      download: async () => new Uint8Array([1, 2, 3]),
    });
    expect(document.assets.map((asset) => asset.path).sort()).toEqual(
      Object.keys(files)
        .filter((path) => path !== "guide/index.html")
        .sort(),
    );
    expect(document.assets.find((asset) => asset.path === "font.woff2")).toMatchObject({
      encoding: "base64",
      content: "AQID",
    });
    expect(document.assets.find((asset) => asset.path === "_stark/theme.css")).toMatchObject({
      encoding: "utf8",
    });
    expect(document.warnings).toHaveLength(1);
    expect(document.publicUrl).toContain("pages.starkfuture.com");
    expect(JSON.stringify(document)).not.toContain("X-Amz-");
    expect(
      read.mock.calls.some(
        ([, args]) =>
          args.path?.includes("secret") ||
          args.path?.includes("frame") ||
          args.path?.startsWith("https"),
      ),
    ).toBe(false);
  });

  it("keeps a readable page if an asset fails, but propagates sign-out cancellation", async () => {
    const read = vi.fn(async (_tool: string, args: Record<string, string>) => {
      if (args.path === "index.html")
        return text('<p>Readable</p><img src="missing.png"><link rel="stylesheet" href="bad.css">');
      if (args.path === "bad.css") return text("<script>not CSS</script>", "text/html");
      throw new Error("private upstream details");
    });
    const document = await loadPublishedPage({
      root: "project",
      path: "index.html",
      read,
      download: vi.fn(),
    });
    expect(document.source).toContain("Readable");
    expect(document.assets).toEqual([]);
    expect(document.warnings).toHaveLength(1);
    expect(JSON.stringify(document)).not.toContain("private upstream");
    await expect(
      loadPublishedPage({
        root: "project",
        path: "index.html",
        read: async (_tool, args) => {
          if (args.path === "index.html") return text('<img src="image.png">');
          throw new PublishedPagesFailure("cancelled");
        },
        download: vi.fn(),
      }),
    ).rejects.toThrow("cancelled");
  });

  it("caps failed resource reads as well as successful downloads", async () => {
    const paths: string[] = [];
    const document = await loadPublishedPage({
      root: "project",
      path: "index.html",
      read: async (tool, args) => {
        if (tool === "pages_get_public_url")
          return result({ url: "https://pages.starkfuture.com/project/index.html" });
        if (args.path === "index.html")
          return text(Array.from({ length: 80 }, (_, i) => `<img src="${i}.png">`).join(""));
        paths.push(args.path!);
        throw new Error("missing");
      },
      download: vi.fn(),
    });
    expect(paths).toHaveLength(64);
    expect(document.warnings.some((warning) => warning.includes("preview limit"))).toBe(true);
  });

  it("keeps the aggregate asset bundle bounded even when every individual file fits", async () => {
    const document = await loadPublishedPage({
      root: "project",
      path: "index.html",
      read: async (tool, args) => {
        if (tool === "pages_get_public_url")
          return result({ url: "https://pages.starkfuture.com/project/index.html" });
        if (args.path === "index.html")
          return text(Array.from({ length: 6 }, (_, i) => `<img src="${i}.png">`).join(""));
        return result({ kind: "download", content_type: "image/png", url: signed });
      },
      download: async () => new Uint8Array(PAGES_ASSET_BYTES),
    });
    expect(document.assets).toHaveLength(4);
    expect(document.warnings).toHaveLength(1);
  });

  it("rejects oversized or truncated documents rather than displaying incomplete HTML", async () => {
    for (const page of [
      text("a".repeat(PAGES_DOCUMENT_BYTES + 1)),
      result({ kind: "text", text: "<html>", truncated: true }),
    ])
      await expect(
        loadPublishedPage({
          root: "project",
          path: "index.html",
          read: async () => page,
          download: vi.fn(),
        }),
      ).rejects.toThrow("too large");
  });
});
