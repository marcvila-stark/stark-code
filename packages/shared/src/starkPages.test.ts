import { describe, expect, it } from "vite-plus/test";
import {
  isMirrorFollowUrl,
  isOpenableStarkPageLink,
  isStarkPagesPanelUrl,
  parseStarkPagesMessage,
} from "./starkPages.ts";

describe("Stark Pages message boundaries", () => {
  it("opens only the active mirror's follower", () => {
    expect(isMirrorFollowUrl("http://127.0.0.1:4317/follow?slug=decision-one", 4317)).toBe(true);
    for (const url of [
      "http://127.0.0.1:4317@evil.example/follow?slug=decision-one",
      "http://127.0.0.1:4318/follow?slug=decision-one",
      "http://127.0.0.1:4317/p/decision-one",
      "http://127.0.0.1:4317/follow?slug=decision-one&redirect=https://evil.example",
      "file:///etc/passwd",
      "https://127.0.0.1:4317/follow?slug=decision-one",
    ])
      expect(isMirrorFollowUrl(url, 4317)).toBe(false);
  });
  it("keeps source links on http(s) without credentials", () => {
    expect(isOpenableStarkPageLink("https://starkfuture.com/report")).toBe(true);
    for (const url of [
      "javascript:alert(1)",
      "file:///tmp/private",
      "data:text/html,test",
      "https://user:password@example.com",
      "https://user@example.com",
      "https://example.com/" + "x".repeat(2048),
    ])
      expect(isOpenableStarkPageLink(url)).toBe(false);
  });
  it("recognises only a local mirror panel", () => {
    expect(isStarkPagesPanelUrl("http://127.0.0.1:4317/panel")).toBe(true);
    expect(isStarkPagesPanelUrl("http://127.0.0.1:4317@evil.example/panel")).toBe(false);
    expect(isStarkPagesPanelUrl("http://127.0.0.1:4338/panel")).toBe(false);
  });
  it("rejects unknown, oversized and malformed panel messages", () => {
    const valid = {
      v: 1,
      source: "stark-pages",
      type: "publish-request",
      page: { slug: "decision-one", title: "Decision" },
    };
    expect(parseStarkPagesMessage(valid)).toEqual({ type: "publish-request", page: valid.page });
    for (const raw of [
      null,
      "publish",
      { ...valid, v: 2 },
      { ...valid, source: "other" },
      { ...valid, type: "execute" },
      { ...valid, page: { slug: "../../../etc/passwd", title: "Bad" } },
      { ...valid, page: { slug: "decision-one", title: "x".repeat(201) } },
      { v: 1, source: "stark-pages", type: "ready", root: "/project", port: 9999 },
    ])
      expect(parseStarkPagesMessage(raw)).toBeNull();
  });
});
