import { describe, expect, it } from "vite-plus/test";
import { createNativeMcpWarningDetector } from "./nativeMcpWarning";

describe("native MCP warning detection", () => {
  it.each([
    ['⎿ Error: MCP server "pages" needs authentication', "sign-in"],
    ['⎿  Error: MCP server "pages" rejected the session credential (HTTP 401)', "sign-in"],
    ["⎿ Error: MCP authentication required. Reconnect to continue using this server.", "sign-in"],
    ['⎿ Error: MCP server "pages" is not connected: private diagnostic', "connection"],
  ] as const)("recognizes a failed tool-result diagnostic: %s", (text, expected) => {
    expect(createNativeMcpWarningDetector().read(text)).toBe(expected);
  });

  it("reads split text, ANSI colors and split control sequences", () => {
    const detector = createNativeMcpWarningDetector();
    expect(detector.read("\u001b[")).toBeUndefined();
    expect(detector.read('31m⎿ Error: MCP server "pa')).toBeUndefined();
    expect(detector.read('ges" is not con')).toBeUndefined();
    expect(detector.read("nected\u001b[0m: https://private.example/token\n")).toBe("connection");
    expect(detector.read("\u001b]8;;https://private.example\u001b")).toBeUndefined();
    expect(
      detector.read('\\⎿ Error: MCP server "pages" needs authentication\u001b]8;;\u0007'),
    ).toBe("sign-in");
  });

  it("ignores startup, discovery, OSC contents, ordinary conversation and unrelated failures", () => {
    const detector = createNativeMcpWarningDetector();
    for (const text of [
      'The MCP server "pages" is not connected in this example.',
      'If MCP server "pages" needs authentication, use Settings.',
      "$ echo 'MCP server \"pages\" is not connected'",
      '> MCP server "pages" is not connected',
      "MCP tool call failed: invalid arguments",
      "⎿ Error: MCP tool call failed: invalid arguments",
      'MCP server "pages" needs authentication',
      'MCP server "pages" is not connected: private diagnostic',
      'Error: MCP server "pages" needs authentication',
      "⚠ MCP client for `pages` failed to start: private diagnostic",
      "⚠ MCP startup incomplete (failed: pages)",
      "MCP startup incomplete: pages",
      "⎿ Error: MCP startup incomplete: pages",
      "⎿ Error: MCP client for `pages` failed to start: private diagnostic",
      'MCP server "pages" connected successfully',
      "MCP startup completed",
      '\u001b]0;MCP server "pages" needs authentication\u0007normal output',
    ])
      expect(detector.read(`${text}\n`)).toBeUndefined();
    expect(
      detector.read('```text\n⎿ Error: MCP server "pages" is not connected\n```\n'),
    ).toBeUndefined();
    expect(detector.read('⎿ Error: MCP server "pages" is not connected\n')).toBe("connection");
  });

  it("bounds a long line without treating its suffix as a new diagnostic", () => {
    const detector = createNativeMcpWarningDetector();
    expect(detector.read("x".repeat(100_000))).toBeUndefined();
    expect(detector.read('⎿ Error: MCP server "pages" needs authentication')).toBeUndefined();
    expect(detector.read('\n⎿ Error: MCP server "pages" needs authentication')).toBe("sign-in");
  });

  it("keeps snapshot history quiet but recognizes new failures and deduplicates repaint", () => {
    const detector = createNativeMcpWarningDetector();
    expect(
      detector.read('old prompt\n⎿ Error: MCP server "pages" is not connected\n', true),
    ).toBeUndefined();
    expect(detector.read('⎿ Error: MCP server "pages" is not connected\r')).toBe("connection");
    expect(detector.read('⎿ Error: MCP server "pages" is not connected\r')).toBeUndefined();
    expect(detector.read('⎿ Error: MCP server "pages" needs authentication\r')).toBe("sign-in");
    expect(detector.read('⎿ Error: MCP server "pages" is not connected\r')).toBeUndefined();
    expect(detector.read("MCP client for `other` failed to start\n", true)).toBeUndefined();
  });
});
