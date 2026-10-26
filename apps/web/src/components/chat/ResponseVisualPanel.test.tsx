// @vitest-environment jsdom

import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { scopeThreadRef } from "@starkfuture/client-runtime/environment";
import {
  RESPONSE_VISUALS_MODEL,
  RESPONSE_VISUALS_VERSION,
  type ResponseVisualsResult,
  MessageId,
} from "@starkfuture/contracts";
import { makeThreadFixture } from "../../test-fixtures";

const state = vi.hoisted(() => ({
  allowed: true,
  generate: vi.fn(),
  selectionActions: new Map<HTMLElement, () => void>(),
}));
vi.mock("../../lib/selectionActions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/selectionActions")>()),
  observeSelectionActions: ({
    element,
    onSelection,
  }: {
    element: HTMLElement;
    onSelection: (pointer: null) => void;
  }) => {
    const update = () => onSelection(null);
    state.selectionActions.set(element, update);
    return {
      cancel: () => undefined,
      dispose: () => state.selectionActions.delete(element),
      selectionChanged: update,
    };
  },
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.allowed }));
vi.mock("../../state/responseVisuals", () => ({
  responseVisualsEnvironment: { format: { permissionAtom: () => "visual-permission" } },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.generate }));
vi.mock("../ChatMarkdown", () => ({ default: ({ text }: { text: string }) => <div>{text}</div> }));

import { ResponseVisualPanel, type ReaderAnswer } from "./ResponseVisualPanel";

let root: Root;
let container: HTMLDivElement;
const thread = makeThreadFixture();
const threadRef = scopeThreadRef(thread.environmentId, thread.id);
const result: ResponseVisualsResult = {
  summary: "A concise overview.",
  table: null,
  mermaid: null,
  reason: null,
  model: RESPONSE_VISUALS_MODEL,
  formatterVersion: RESPONSE_VISUALS_VERSION,
  cacheHit: false,
  generationUsage: null,
};
const success = { _tag: "Success" as const, value: result };

async function render(text = "The original answer.") {
  await renderAnswers([{ id: "answer", text, label: "Answer" }]);
}
async function renderAnswers(
  answers: readonly ReaderAnswer[],
  callbacks: Pick<
    ComponentProps<typeof ResponseVisualPanel>,
    "onQuoteText" | "onCiteAssistantText"
  > = {},
) {
  await act(() =>
    root.render(
      <ResponseVisualPanel
        environmentId={thread.environmentId}
        threadRef={threadRef}
        cwd="/work"
        answers={answers}
        {...callbacks}
      />,
    ),
  );
}
function generateButton() {
  return container.querySelector<HTMLButtonElement>("[data-reply-reader] button")!;
}
function button(text: string) {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent === text,
  )!;
}
async function chooseReply(value: string) {
  const select = container.querySelector<HTMLSelectElement>('[aria-label="Reply to read"]')!;
  await act(() => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  state.allowed = true;
  state.generate.mockReset().mockResolvedValue(success);
  state.selectionActions.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

it("cites a selected real answer with its own message identity and quotes pasted text without inventing one", async () => {
  const onCiteAssistantText = vi.fn<
    NonNullable<ComponentProps<typeof ResponseVisualPanel>["onCiteAssistantText"]>
  >(() => true);
  const onQuoteText = vi.fn<NonNullable<ComponentProps<typeof ResponseVisualPanel>["onQuoteText"]>>(
    () => true,
  );
  const rect = new DOMRect(20, 20, 300, 300);
  const originalRect = Object.getOwnPropertyDescriptor(Range.prototype, "getBoundingClientRect");
  const originalRects = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => rect,
  });
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: () => Object.assign([rect], { item: () => rect }),
  });
  const elementRect = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockReturnValue(rect);
  async function selectSource() {
    const source = container.querySelector('[aria-label="Original reply"]')!.lastElementChild!;
    const range = document.createRange();
    range.selectNodeContents(source);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    await act(() => document.dispatchEvent(new Event("selectionchange")));
  }
  try {
    await renderAnswers(
      [
        {
          id: "reader-choice",
          messageId: MessageId.make("real-assistant-message"),
          text: "A real answer to cite.",
          label: "Assistant reply",
        },
        { id: "native-reply", text: "A captured reply.", label: "Claude native reply" },
      ],
      { onCiteAssistantText, onQuoteText },
    );
    expect(container.querySelector("[data-assistant-citation-source]")).toBeNull();
    await chooseReply("reader-choice");
    await selectSource();
    const cite = document.querySelector<HTMLButtonElement>(
      '[aria-label="Cite selection in composer"]',
    )!;
    expect(cite).not.toBeNull();
    await act(() => cite.click());
    expect(onCiteAssistantText.mock.calls[0]?.[0]).toMatchObject({
      messageId: "real-assistant-message",
      ...threadRef,
      text: "A real answer to cite.",
    });
    expect(onQuoteText).not.toHaveBeenCalled();

    await chooseReply("paste");
    const textarea = container.querySelector<HTMLTextAreaElement>('[aria-label="Reply text"]')!;
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        textarea,
        "Pasted source text.",
      );
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.querySelector("[data-assistant-citation-source]")).toBeNull();
    await selectSource();
    const quote = document.querySelector<HTMLButtonElement>(
      '[aria-label="Quote selection in chat"]',
    )!;
    await act(() => quote.click());
    expect(onQuoteText).toHaveBeenCalledExactlyOnceWith("Pasted source text.", "Pasted reply");
    expect(onCiteAssistantText).toHaveBeenCalledTimes(1);
    expect(state.generate).not.toHaveBeenCalled();
  } finally {
    window.getSelection()?.removeAllRanges();
    elementRect.mockRestore();
    if (originalRect) Object.defineProperty(Range.prototype, "getBoundingClientRect", originalRect);
    else Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
    if (originalRects) Object.defineProperty(Range.prototype, "getClientRects", originalRects);
    else Reflect.deleteProperty(Range.prototype, "getClientRects");
  }
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("shows native evidence for the selected reply and never sends it to the formatter", async () => {
  await renderAnswers([
    {
      id: "earlier",
      text: "Earlier answer",
      label: "Earlier",
      evidence: {
        coverage: "available",
        commands: [
          {
            id: "test",
            label: "npm test",
            isCheck: true,
            outcome: "tool-completed",
            exitCode: null,
            startedAt: "2026-10-20T12:00:00Z",
            completedAt: "2026-10-20T12:00:01Z",
          },
        ],
        changes: [],
        unconfirmedChanges: 0,
      },
    },
    { id: "later", text: "Later answer", label: "Later" },
  ]);
  expect(container.querySelector('[aria-label="Reply details"]')).toBeNull();
  await chooseReply("earlier");
  await act(() => button("Details").click());
  const details = document.querySelector('[role="dialog"]')!;
  expect(details.textContent).toContain("exit code not reported");
  expect(details.textContent).not.toContain("exited 0");
  await act(() =>
    document.querySelector<HTMLButtonElement>('[aria-label="Close reply details"]')!.click(),
  );
  await act(() => button("Make visual").click());
  expect(state.generate.mock.calls[0]?.[0].input).toEqual({
    threadId: thread.id,
    answer: "Earlier answer",
    visualRequest: "auto",
  });
  await chooseReply("paste");
  expect(container.querySelector('[aria-label="Reply details"]')).toBeNull();
});

it("keeps reading available without generation permission and sends only the selected reply when permitted", async () => {
  state.allowed = false;
  await render();
  expect(container.querySelector('[aria-label="Original reply"]')?.textContent).toBe(
    "The original answer.",
  );
  expect(generateButton().disabled).toBe(true);
  expect(button("Summarize").disabled).toBe(true);
  await act(() => generateButton().click());
  await act(() => button("Summarize").click());
  expect(state.generate).not.toHaveBeenCalled();

  state.allowed = true;
  await render();
  expect(generateButton().disabled).toBe(false);
  await act(() => generateButton().click());
  expect(state.generate).toHaveBeenCalledExactlyOnceWith({
    environmentId: thread.environmentId,
    input: { threadId: thread.id, answer: "The original answer.", visualRequest: "auto" },
  });
  expect(container.querySelector('[aria-label="AI overview"]')?.textContent).toContain(
    "A concise overview.",
  );
  expect(container.querySelector('[aria-label="Original reply"]')?.textContent).toContain(
    "The original answer.",
  );
});

it.each([
  ["character limit", "x".repeat(24_001)],
  ["UTF-8 byte limit", "界".repeat(18_000)],
])("allows reading but blocks generation above the %s", async (_limit, answer) => {
  await render(answer);
  expect(generateButton().disabled).toBe(true);
  expect(button("Summarize").disabled).toBe(true);
  expect(container.textContent).toContain("Paste a shorter excerpt");
  expect(container.querySelector('[aria-label="Original reply"]')?.textContent).toBe(answer);
  await act(() => generateButton().click());
  await act(() => button("Summarize").click());
  expect(state.generate).not.toHaveBeenCalled();
});

it("prevents duplicate requests while busy and keeps a late result out of a newly selected answer", async () => {
  let complete!: (value: typeof success) => void;
  state.generate.mockReturnValueOnce(
    new Promise<typeof success>((resolve) => {
      complete = resolve;
    }),
  );
  await render();
  await act(() => {
    generateButton().click();
    generateButton().click();
  });
  expect(state.generate).toHaveBeenCalledTimes(1);
  expect(generateButton().disabled).toBe(true);
  expect(button("Summarize").disabled).toBe(true);
  expect(generateButton().textContent).toBe("Making visual…");
  expect(container.querySelector<HTMLSelectElement>('[aria-label="Visual format"]')?.disabled).toBe(
    true,
  );

  await render("A different answer.");
  await act(() => complete(success));
  expect(container.querySelector('[aria-label="AI overview"]')).toBeNull();
  expect(container.querySelector('[aria-label="Original reply"]')?.textContent).toBe(
    "A different answer.",
  );
  expect(generateButton().disabled).toBe(false);
  await act(() => generateButton().click());
  expect(state.generate).toHaveBeenCalledTimes(2);
});

it("summarizes the selected reply into bullets while leaving its original text available", async () => {
  const source =
    "The implementation is ready. Live verification is pending. Review before publishing.";
  state.generate.mockResolvedValueOnce({
    _tag: "Success",
    value: {
      ...result,
      summary: "Verification is still pending.",
      summaryBullets: ["The implementation is ready.", "Review before publishing."],
    },
  });
  await renderAnswers([
    { id: "earlier", text: source, label: "Earlier reply" },
    { id: "latest", text: "Another reply with unrelated information.", label: "Later reply" },
  ]);
  await chooseReply("earlier");
  expect(state.generate).not.toHaveBeenCalled();
  await act(() => button("Summarize").click());
  expect(state.generate).toHaveBeenCalledExactlyOnceWith({
    environmentId: thread.environmentId,
    input: { threadId: thread.id, answer: source, visualRequest: "summary" },
  });
  const overview = container.querySelector('[aria-label="AI overview"]')!;
  expect(overview.textContent).toContain("Verification is still pending.");
  expect([...overview.querySelectorAll("li")].map((item) => item.textContent)).toEqual([
    "The implementation is ready.",
    "Review before publishing.",
  ]);
  expect(container.querySelector('[aria-label="Original reply"]')?.textContent).toContain(source);
  expect(container.textContent).not.toContain("Another reply with unrelated information.");
});

it("follows new captured replies by default and keeps an explicitly selected older reply", async () => {
  const first = { id: "first", text: "First captured reply.", label: "First" };
  const second = { id: "second", text: "Second captured reply.", label: "Second" };
  const third = { id: "third", text: "Third captured reply.", label: "Third" };
  await renderAnswers([first]);
  expect(container.querySelector('[aria-label="Original reply"]')?.textContent).toBe(first.text);
  await renderAnswers([first, second]);
  expect(container.querySelector('[aria-label="Original reply"]')?.textContent).toBe(second.text);
  await chooseReply(first.id);
  await renderAnswers([first, second, third]);
  expect(container.querySelector('[aria-label="Original reply"]')?.textContent).toBe(first.text);
  await chooseReply("latest");
  expect(container.querySelector('[aria-label="Original reply"]')?.textContent).toBe(third.text);
  expect(state.generate).not.toHaveBeenCalled();
});

it("applies each reader text size and remembers the choice after the panel is reopened", async () => {
  await render();
  expect(
    container
      .querySelector<HTMLElement>("[data-reply-reader]")
      ?.style.getPropertyValue("--reply-reader-size"),
  ).toBe("16px");
  for (const size of [14, 16, 18, 20]) {
    const select = container.querySelector<HTMLSelectElement>('[aria-label="Reader text size"]')!;
    await act(() => {
      select.value = String(size);
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(
      container
        .querySelector<HTMLElement>("[data-reply-reader]")
        ?.style.getPropertyValue("--reply-reader-size"),
    ).toBe(`${size}px`);
    await act(() => root.render(null));
    await render();
    expect(
      container.querySelector<HTMLSelectElement>('[aria-label="Reader text size"]')?.value,
    ).toBe(String(size));
    expect(
      container
        .querySelector<HTMLElement>("[data-reply-reader]")
        ?.style.getPropertyValue("--reply-reader-size"),
    ).toBe(`${size}px`);
  }
  expect(container.querySelector('[aria-label="Original reply"]')?.textContent).toBe(
    "The original answer.",
  );
  expect(state.generate).not.toHaveBeenCalled();
});

it("reuses each button's result after switching or hiding the overview without a new request", async () => {
  state.generate.mockResolvedValueOnce(success).mockResolvedValueOnce({
    _tag: "Success",
    value: { ...result, summary: "A saved summary.", summaryBullets: ["Keep the original reply."] },
  });
  await render();
  await act(() => generateButton().click());
  expect(state.generate).toHaveBeenCalledTimes(1);
  await act(() => button("Hide overview").click());
  expect(container.querySelector('[aria-label="AI overview"]')).toBeNull();
  expect(container.querySelector('[aria-label="Original reply"]')?.textContent).toBe(
    "The original answer.",
  );
  await act(() => generateButton().click());
  expect(state.generate).toHaveBeenCalledTimes(1);
  expect(container.querySelector('[aria-label="AI overview"]')?.textContent).toContain(
    "Saved · no new model call",
  );
  await act(() => button("Summarize").click());
  expect(state.generate).toHaveBeenCalledTimes(2);
  expect(container.querySelector('[aria-label="AI overview"]')?.textContent).toContain(
    "A saved summary.",
  );
  await act(() => button("Hide overview").click());
  await act(() => generateButton().click());
  expect(container.querySelector('[aria-label="AI overview"]')?.textContent).toContain(
    "A concise overview.",
  );
  await act(() => button("Summarize").click());
  expect(container.querySelector('[aria-label="AI overview"]')?.textContent).toContain(
    "Keep the original reply.",
  );
  expect(container.querySelector('[aria-label="AI overview"]')?.textContent).toContain(
    "Saved · no new model call",
  );
  expect(state.generate).toHaveBeenCalledTimes(2);
});

it("prevents both actions from starting another call while a summary is being prepared", async () => {
  let complete!: (value: typeof success) => void;
  state.generate.mockReturnValueOnce(
    new Promise<typeof success>((resolve) => {
      complete = resolve;
    }),
  );
  await render();
  await act(() => {
    button("Summarize").click();
    button("Summarize").click();
    generateButton().click();
  });
  expect(state.generate).toHaveBeenCalledTimes(1);
  expect(button("Summarizing…").disabled).toBe(true);
  expect(generateButton().disabled).toBe(true);
  expect(container.querySelector('[aria-label="Original reply"]')?.textContent).toBe(
    "The original answer.",
  );
  await act(() => complete(success));
  expect(button("Summarize").disabled).toBe(false);
  expect(generateButton().disabled).toBe(false);
});
