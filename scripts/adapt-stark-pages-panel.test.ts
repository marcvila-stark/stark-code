// @effect-diagnostics nodeBuiltinImport:off - Execute the bundled panel in a constrained test VM.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeVM from "node:vm";
import { ASSISTANT_CITATION_MAX_TEXT_LENGTH } from "@starkfuture/contracts";
import { expect, it, vi } from "vite-plus/test";
import { prepareStarkWorkbench } from "./prepare-stark-workbench.mjs";

it("switches only a trusted host to document layout and preserves guarded publish controls", () => {
  const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "stark-page-layout-"));
  try {
    const kit = prepareStarkWorkbench({ destination: NodePath.join(scratch, "kit") });
    const url = NodeURL.pathToFileURL(NodePath.join(kit, "packages/spage/src/panel.js")).href;
    const options = {
      nonce: "layout-test",
      csrf: null,
      embedOrigins: ["starkcode:"],
      port: 4317,
      root: "/project",
      initial: { slug: "test-page", title: "Test page", rev: 1 },
    };
    const html = NodeChildProcess.execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const {renderPanel}=await import(${JSON.stringify(url)}); process.stdout.write(renderPanel(${JSON.stringify(options)}));`,
      ],
      { encoding: "utf8" },
    );
    const script = html.match(/<script nonce="layout-test">([\s\S]*?)<\/script>/)![1]!;
    const config = html.match(
      /<script type="application\/json" id="config">([\s\S]*?)<\/script>/,
    )![1]!;
    const listeners = new Map<string, (event: unknown) => void>();
    const nodes = new Map<
      string,
      {
        src: string;
        contentDocument?: unknown;
        textContent: string;
        hidden: boolean;
        addEventListener: ReturnType<typeof vi.fn>;
        setAttribute: ReturnType<typeof vi.fn>;
      }
    >();
    const element = (id: string) => {
      if (!nodes.has(id))
        nodes.set(id, {
          src: "",
          textContent: id === "config" ? config : "",
          hidden: false,
          addEventListener: vi.fn(),
          setAttribute: vi.fn(),
        });
      return nodes.get(id)!;
    };
    const events = new Map<string, (event: { data: string }) => void>();
    class EventSource {
      addEventListener(name: string, listener: (event: { data: string }) => void) {
        events.set(name, listener);
      }
    }
    const parent = { postMessage: vi.fn() };
    const body = { setAttribute: vi.fn() };
    NodeVM.runInNewContext(script, {
      window: {
        parent,
        location: { ancestorOrigins: ["starkcode://app"] },
        addEventListener: (name: string, listener: (event: unknown) => void) =>
          listeners.set(name, listener),
      },
      document: { body, getElementById: element, addEventListener: vi.fn() },
      URL,
      EventSource,
    });
    expect(element("view").src).toContain("view=panel");
    const host = {
      v: 1,
      source: "stark-host",
      type: "host",
      agent: "codex",
      canPublish: false,
      presentation: "document",
      embeddedControls: true,
    };
    const dispatch = (origin: string, source: unknown, data = host) =>
      listeners.get("message")!({ origin, source, data });
    dispatch("https://untrusted.example", parent);
    dispatch("starkcode://app", {});
    expect(element("view").src).toContain("view=panel");
    dispatch("starkcode://app", parent);
    expect(body.setAttribute).toHaveBeenCalledWith("data-presentation", "document");
    expect(body.setAttribute).toHaveBeenCalledWith("data-embedded-controls", "true");
    expect(element("view").src).toBe("/p/test-page/?rev=1");
    expect(element("pick").textContent).toBe("Page library");
    expect(element("open").textContent).toBe("Open in browser");
    expect(element("folder-context").textContent).toBe("Local pages · project");
    expect(element("publish").hidden).toBe(true);
    // Repeated host capability updates do not reload the document being read.
    element("view").src = "retained-reading-position";
    dispatch("starkcode://app", parent);
    expect(element("view").src).toBe("retained-reading-position");
    dispatch("starkcode://app", parent, { ...host, embeddedControls: false });
    expect(body.setAttribute).toHaveBeenLastCalledWith("data-embedded-controls", "false");
    expect(element("view").src).toBe("retained-reading-position");
    events.get("show")!({
      data: JSON.stringify({ slug: "another-page", title: "Other page", rev: 2 }),
    });
    expect(element("view").src).toBe("retained-reading-position");
    expect(element("next").hidden).toBe(true);
    events.get("show")!({
      data: JSON.stringify({ slug: "test-page", title: "Test page", rev: 3 }),
    });
    expect(element("next").hidden).toBe(false);
    expect(element("next").textContent).toBe("Update available");
    expect(element("view").src).toBe("retained-reading-position");
    const nextClick = element("next").addEventListener.mock.calls.find(
      ([event]) => event === "click",
    )![1];
    nextClick();
    expect(element("view").src).toBe("/p/test-page/?rev=3");
    dispatch("starkcode://app", parent, { ...host, presentation: "panel" });
    expect(element("view").src).toContain("view=panel");

    // Run the actual extracted and adapted kit, not a fixture copy of its bridge.
    let selectedText = "A sentence from the page";
    const selectionEvents = new Map<string, () => void>();
    const pageDocument = {
      querySelector: () => null,
      getSelection: () => ({ isCollapsed: !selectedText, toString: () => selectedText }),
      addEventListener: (name: string, listener: () => void) => selectionEvents.set(name, listener),
    };
    element("view").contentDocument = pageDocument;
    element("view").addEventListener.mock.calls.find(([name]) => name === "load")![1]();
    const selections = () =>
      parent.postMessage.mock.calls.filter(([packet]) => packet.type === "selection");
    selectionEvents.get("pointerup")!();
    expect(selections()).toHaveLength(0);
    const selectionHost = { ...host, presentation: "panel", selectionToken: "a".repeat(32) };
    listeners.get("message")!({
      origin: "https://evil.invalid",
      source: parent,
      data: selectionHost,
    });
    listeners.get("message")!({ origin: "starkcode://app", source: {}, data: selectionHost });
    selectionEvents.get("keyup")!();
    expect(selections()).toHaveLength(0);
    listeners.get("message")!({ origin: "starkcode://app", source: parent, data: selectionHost });
    selectionEvents.get("pointerup")!();
    expect(selections()[0]).toEqual([
      {
        v: 1,
        source: "stark-pages",
        type: "selection",
        selectionToken: selectionHost.selectionToken,
        slug: "test-page",
        text: selectedText,
        tooLong: false,
      },
      "starkcode://app",
    ]);
    selectedText = "x".repeat(ASSISTANT_CITATION_MAX_TEXT_LENGTH);
    selectionEvents.get("keyup")!();
    expect(selections().at(-1)![0]).toMatchObject({ text: selectedText, tooLong: false });
    selectedText += "x";
    selectionEvents.get("keyup")!();
    expect(selections().at(-1)![0]).toMatchObject({ text: "", tooLong: true });
    const count = selections().length;
    element("view").contentDocument = {};
    selectionEvents.get("pointerup")!();
    expect(selections()).toHaveLength(count);
    element("view").contentDocument = pageDocument;
    dispatch("starkcode://app", parent, { ...host, presentation: "panel" });
    selectionEvents.get("pointerup")!();
    expect(selections()).toHaveLength(count);
  } finally {
    NodeFS.rmSync(scratch, { recursive: true, force: true });
  }
});
