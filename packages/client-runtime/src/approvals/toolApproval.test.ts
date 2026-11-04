import { describe, expect, it } from "vite-plus/test";

import { presentToolApproval, toolApprovalNote } from "./toolApproval.ts";

// Long enough that a 400-character preview would cut it before the image paths.
const style = `<style>${"body { font-family: system-ui; }\n".repeat(20)}</style>`;
const html = `<!doctype html><html><head>${style}</head><body>
<img src="/Users/me/lunch/swatches.png">
<div style="background: url(/Users/me/lunch/bg.webp)"></div>
<img src="/Users/me/lunch/swatches.png">
<img src="https://example.com/remote.png"><img src="relative.png">
</body></html>`;

describe("presentToolApproval", () => {
  it("describes Stark's html_render with the files it would read and every argument", () => {
    const presentation = presentToolApproval({
      toolName: "mcp__stark-code__html_render",
      input: { html, title: "Lunch proposal", height: 640 },
    });
    expect(presentation.kind).toBe("html-render");
    expect(presentation.headline).toBe("Show the HTML page “Lunch proposal” in this chat");
    expect(presentation.localImages).toEqual([
      "/Users/me/lunch/swatches.png",
      "/Users/me/lunch/bg.webp",
    ]);
    expect(presentation.scope).toEqual([
      { text: "Saves the page to this thread and shows it inline in a frame up to 640px tall." },
      {
        text: "Reads 2 local images named in the page and embeds them. A file that is not an image, or cannot be read, fails the call.",
        files: ["/Users/me/lunch/swatches.png", "/Users/me/lunch/bg.webp"],
      },
      {
        text: "The page's network requests are blocked by its content security policy; its scripts run when Stark draws it.",
      },
    ]);
    expect(presentation.argumentsIncomplete).toBe(false);
    expect(presentation.argumentLines).toEqual([
      ["html", html],
      ["title", "Lunch proposal"],
      ["height", "640"],
    ]);
  });

  it("never lists files from a preview of the arguments", () => {
    const summarized = presentToolApproval({
      toolName: "stark-code.html_render",
      input: { summary: '{"html":"<!doctype html>', truncated: true },
    });
    expect(summarized.argumentsIncomplete).toBe(true);
    expect(summarized.localImages).toBeNull();
    expect(summarized.argumentLines).toBeNull();
    expect(summarized.headline).toBe("Show an HTML page in this chat");
    expect(summarized.scope[1]).toEqual({
      text: "Which local files the page names is shown once its full arguments load.",
    });

    const cutInTransport = presentToolApproval({
      toolName: "mcp__stark-code__html_render",
      input: `{"html":"${"x".repeat(50)}\n… output truncated for transport`,
    });
    expect(cutInTransport.argumentsIncomplete).toBe(true);
    expect(cutInTransport.localImages).toBeNull();
  });

  it("says a preview leaves out unreadable images and adds nothing to the thread", () => {
    const presentation = presentToolApproval({
      toolName: "mcp__stark-code__html_preview",
      input: { html: "<p>No images</p>" },
    });
    expect(presentation.kind).toBe("html-preview");
    expect(presentation.localImages).toEqual([]);
    expect(presentation.scope[0]?.text).toContain("Nothing is added to this thread.");
    expect(presentation.scope[1]).toEqual({ text: "The page names no local files." });
  });

  it("names other MCP tools without claiming what they do", () => {
    const presentation = presentToolApproval({
      toolName: "mcp__ably__publish",
      input: { channel: "lunch", html: '<img src="/etc/passwd.png">' },
    });
    expect(presentation.kind).toBe("tool");
    expect(presentation.headline).toBe("Use “publish” from ably");
    expect(presentation.localImages).toBeNull();
    expect(presentation.scope).toEqual([
      { text: "This app can't tell what this tool does. Review its arguments before deciding." },
    ]);
    expect(presentation.argumentLines).toEqual([
      ["channel", "lunch"],
      ["html", '<img src="/etc/passwd.png">'],
    ]);
  });
});

describe("toolApprovalNote", () => {
  it("keeps a provider's reason and drops prompts that only restate the call", () => {
    const tool = "mcp__stark-code__html_render";
    expect(toolApprovalNote(`${tool}: {"html":"<!doctype`, tool)).toBeNull();
    expect(toolApprovalNote("Render an HTML page: Lunch", tool)).toBeNull();
    expect(toolApprovalNote("Asked by a hook\nPublishing needs review", tool)).toBe(
      "Asked by a hook\nPublishing needs review",
    );
  });
});
