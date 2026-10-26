import { describe, expect, it } from "vite-plus/test";
import { parseComposerIssueLink } from "./composerIssueLink";

describe("parseComposerIssueLink", () => {
  it("makes a plain issue reference without tracking parameters or comment fragments", () => {
    expect(
      parseComposerIssueLink(
        " https://github.com/starkfuture/stark-code/issues/123?utm_source=mail#issuecomment-42 ",
      ),
    ).toEqual({
      url: "https://github.com/starkfuture/stark-code/issues/123",
      repository: "starkfuture/stark-code",
      number: 123,
      label: "starkfuture/stark-code#123",
      markdown:
        "[starkfuture/stark-code#123](https://github.com/starkfuture/stark-code/issues/123)",
    });
  });

  it.each([
    "javascript:alert(1)",
    "http://github.com/owner/repo/issues/1",
    "https://github.com.evil.test/owner/repo/issues/1",
    "https://github.com@evil.test/owner/repo/issues/1",
    "https://user:password@github.com/owner/repo/issues/1",
    "https://github.com:8443/owner/repo/issues/1",
    "https://github.com/owner/repo/pull/1",
    "https://github.com/owner/repo/issues/0",
    "https://github.com/owner/repo/issues/-1",
    "https://github.com/owner/repo/issues/1/edit",
    "https://github.com/owner/repo/issues/9007199254740992",
    "https://github.com/owner/repo%5D/issues/1",
    "https://gitlab.com/owner/repo/issues/1",
    "owner/repo#1",
  ])("rejects unsupported or unsafe references: %s", (input) => {
    expect(parseComposerIssueLink(input)).toBeNull();
  });

  it("accepts an enterprise host only when explicitly configured", () => {
    const url = "https://github.stark.test/owner/repo/issues/1/";
    expect(parseComposerIssueLink(url)).toBeNull();
    expect(parseComposerIssueLink(url, ["github.com", "github.stark.test"])?.url).toBe(
      "https://github.stark.test/owner/repo/issues/1",
    );
  });
});
