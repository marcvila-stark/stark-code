// @vitest-environment jsdom
import { expect, it } from "vite-plus/test";
import { publishedHtmlDocument } from "./publishedPageDocument";

it("removes scripts, navigation, forms and active embeds while retaining readable HTML and styles", () => {
  const source = `<html><head><meta http-equiv="refresh" content="0;url=https://evil.example"><link rel="stylesheet" href="https://evil.example/style"><style>h1 { color: red }</style></head><body><h1>Report</h1><p onclick="fetch('https://evil.example')">Body</p><script>parent.stolen=true</script><form action="https://evil.example"><input></form><iframe src="https://evil.example"></iframe><a href="https://pages.starkfuture.com/report">Read</a><img src="https://evil.example/image" onerror="parent.stolen=true"></body></html>`;
  const doc = new DOMParser().parseFromString(publishedHtmlDocument(source), "text/html");
  expect(doc.querySelector("h1")?.textContent).toBe("Report");
  expect(
    doc.querySelectorAll("form,iframe,object,embed,link,[onclick],[onerror],[href]"),
  ).toHaveLength(0);
  expect(doc.querySelectorAll("script")).toHaveLength(1);
  expect(doc.querySelector("script")?.textContent).not.toContain("stolen");
  const csp = doc
    .querySelector('meta[http-equiv="Content-Security-Policy"]')
    ?.getAttribute("content");
  expect(csp).toContain("connect-src 'none'");
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain("img-src data:");
  expect(csp).toContain(`script-src 'nonce-${doc.querySelector("script")?.getAttribute("nonce")}'`);
  expect(doc.querySelector('meta[http-equiv="refresh"]')).toBeNull();
  expect(doc.querySelector("a")?.getAttribute("data-stark-link")).toBe(
    "https://pages.starkfuture.com/report",
  );
  expect(doc.querySelector("a")?.getAttribute("tabindex")).toBe("0");
  expect(doc.querySelector("a")?.getAttribute("role")).toBe("link");
});

it("escapes document-breaking payloads and gives every read a fresh CSP nonce", () => {
  const source =
    '<style></style><script nonce="known">fetch("https://evil.example")</script><div id="report">Safe</div>';
  const first = new DOMParser().parseFromString(publishedHtmlDocument(source), "text/html");
  const second = new DOMParser().parseFromString(publishedHtmlDocument(source), "text/html");
  expect(first.querySelector("#report")?.textContent).toBe("Safe");
  expect(first.querySelectorAll("script")).toHaveLength(1);
  expect(first.querySelector("script")?.getAttribute("nonce")).not.toBe("known");
  expect(first.querySelector("script")?.getAttribute("nonce")).not.toBe(
    second.querySelector("script")?.getAttribute("nonce"),
  );
});

import { publishedPageLink } from "./publishedPageDocument";
import type { StarkPublishedPageDocument } from "@starkfuture/contracts";

const bundle: StarkPublishedPageDocument = {
  root: "demo",
  path: "guide/index.html",
  mimeType: "text/html",
  source: "",
  publicUrl: null,
  warnings: [],
  assets: [
    {
      path: "_stark/main.css",
      mimeType: "text/css",
      encoding: "utf8",
      content:
        '@import "theme.css"; body.readable {background: url("../images/cover.svg")} @font-face {font-family:Test;src:url("test.woff2")}',
    },
    {
      path: "_stark/theme.css",
      mimeType: "text/css",
      encoding: "utf8",
      content: '@import "main.css"; html[data-theme="light"] h1 {color:rgb(1,2,3)}',
    },
    {
      path: "images/cover.svg",
      mimeType: "image/svg+xml",
      encoding: "utf8",
      content: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
    },
    { path: "_stark/test.woff2", mimeType: "font/woff2", encoding: "base64", content: "AAEC" },
  ],
};

it("preserves document selectors and embeds linked styles, nested imports, fonts and relative images", () => {
  const html =
    '<html lang="en" data-theme="light"><head><link rel="stylesheet" href="../_stark/main.css"><title>Guide</title></head><body class="readable"><h1>Guide</h1><img alt="Cover" src="../images/cover.svg"><img src="/_stark/missing.png"><p style="background-image:url(../images/cover.svg)">Text</p></body></html>';
  const doc = new DOMParser().parseFromString(publishedHtmlDocument(html, bundle), "text/html");
  expect(doc.documentElement.lang).toBe("en");
  expect(doc.documentElement.dataset.theme).toBe("light");
  expect(doc.body.className).toBe("readable");
  expect(doc.title).toBe("Guide");
  const styles = [...doc.querySelectorAll("style")].map((node) => node.textContent).join("\n");
  expect(styles).toContain('html[data-theme="light"] h1{color:rgb(1,2,3)}');
  expect(styles).toContain("data:font/woff2;base64,AAEC");
  expect(styles).toContain("data:image/svg+xml;");
  expect(styles).not.toContain("@import");
  expect(doc.querySelector('img[alt="Cover"]')?.getAttribute("src")).toMatch(
    /^data:image\/svg\+xml/,
  );
  expect(doc.querySelectorAll("img")[1]?.hasAttribute("src")).toBe(false);
  expect(doc.querySelector("p")?.getAttribute("style")).toContain("data:image/svg+xml");
});

it("keeps CSS escapes, imports, forms and remote resources inside the offline frame boundary", () => {
  const html = `<style>@import 'https://evil.example/import.css'; .x{background:u\\72l('https://evil.example/track')} .y{background:url('/_stark/test.woff2')}</style><img src="https://evil.example/tracker"><img src="../images/cover.svg" onload="alert(1)"><a href="javascript:alert(1)">Bad</a><a href="../next.html">Next</a><svg><script>alert(1)</script></svg>`;
  const doc = new DOMParser().parseFromString(publishedHtmlDocument(html, bundle), "text/html");
  expect(
    [...doc.querySelectorAll("style")].map((node) => node.textContent).join("\n"),
  ).not.toContain("evil.example");
  expect(doc.querySelectorAll("img")[0]?.hasAttribute("src")).toBe(false);
  expect(doc.querySelectorAll("[onload],[href],link,iframe")).toHaveLength(0);
  expect(doc.querySelectorAll("script")).toHaveLength(1);
  expect(doc.querySelectorAll("a")[0]?.hasAttribute("data-stark-link")).toBe(false);
  expect(doc.querySelectorAll("a")[1]?.getAttribute("data-stark-link")).toBe("../next.html");
  expect(
    doc.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content"),
  ).toContain("font-src data:");
});

it("routes same-project HTML links to Pages and validates browser handoffs", () => {
  expect(publishedPageLink("../next.html", bundle)).toEqual({ kind: "page", path: "next.html" });
  expect(publishedPageLink("https://pages.starkfuture.com/demo/other/", bundle)).toEqual({
    kind: "page",
    path: "other/index.html",
  });
  expect(publishedPageLink("#section", bundle)).toEqual({ kind: "anchor", url: "#section" });
  expect(publishedPageLink("https://example.com/report", bundle)).toEqual({
    kind: "external",
    url: "https://example.com/report",
  });
  expect(publishedPageLink("../images/cover.svg", bundle)).toEqual({
    kind: "external",
    url: "https://pages.starkfuture.com/demo/images/cover.svg",
  });
  expect(publishedPageLink("javascript:alert(1)", bundle)).toBeNull();
  expect(publishedPageLink("https://user:secret@example.com", bundle)).toBeNull();
  expect(publishedPageLink("file:///etc/passwd", bundle)).toBeNull();
  expect(publishedPageLink("/other/index.html", bundle)).toEqual({
    kind: "external",
    url: "https://pages.starkfuture.com/other/index.html",
  });
  expect(publishedPageLink("/", bundle)).toEqual({
    kind: "external",
    url: "https://pages.starkfuture.com/",
  });
});

it.each([
  "../_stark/main.css",
  "/_stark/main.css",
  "/demo/_stark/main.css",
  "https://pages.starkfuture.com/demo/_stark/main.css",
])("uses the same project asset for %s", (href) => {
  const doc = new DOMParser().parseFromString(
    publishedHtmlDocument(`<link rel="stylesheet" href="${href}"><h1>Guide</h1>`, bundle),
    "text/html",
  );
  expect([...doc.querySelectorAll("style")].map((node) => node.textContent).join("\n")).toContain(
    "body.readable",
  );
});

import { preparePublishedHtml } from "./publishedPageDocument";

it("bounds repeated image expansion and import DAGs before they can amplify a small bundle", () => {
  const large: StarkPublishedPageDocument = {
    ...bundle,
    assets: [
      {
        path: "large.png",
        mimeType: "image/png",
        encoding: "base64",
        content: "A".repeat(2 * 1024 * 1024),
      },
      ...Array.from({ length: 8 }, (_, index) => ({
        path: `level${index}.css`,
        mimeType: "text/css",
        encoding: "utf8" as const,
        content: index === 7 ? "p{color:red}" : `@import "level${index + 1}.css";`.repeat(10),
      })),
    ],
  };
  const result = preparePublishedHtml(
    `<style>${Array.from({ length: 256 }, (_, i) => `.r${i}{background:url(../large.png)}`).join("")}</style><link rel="stylesheet" href="../level0.css">`,
    large,
  );
  expect(result.html.length).toBeLessThan(16 * 1024 * 1024);
  expect(result.warnings).toContain(
    "Some repeated or large resources were omitted to keep this page responsive.",
  );
});
