export interface ReaderSection {
  readonly element: HTMLElement;
  readonly label: string;
  readonly level: number;
}

function atLineBoundary(node: Node | null, direction: "before" | "after"): boolean {
  for (
    let current = node;
    current;
    current = direction === "before" ? current.previousSibling : current.nextSibling
  ) {
    if (current.nodeType === Node.ELEMENT_NODE && (current as Element).tagName === "BR")
      return true;
    const text = current.textContent ?? "";
    if (current.nodeType === Node.TEXT_NODE && text.includes("\n")) {
      return (
        (direction === "before"
          ? text.slice(text.lastIndexOf("\n") + 1)
          : text.slice(0, text.indexOf("\n"))
        ).trim() === ""
      );
    }
    if (text.trim() !== "") return false;
  }
  return true;
}

function sectionLabel(element: HTMLElement): string {
  const copy = element.cloneNode(true) as HTMLElement;
  for (const ignored of copy.querySelectorAll('[data-thread-find-ignore], [aria-hidden="true"]'))
    ignored.remove();
  return (copy.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** Read authored headings, leading labels and standalone label lines, never inline emphasis or card UI. */
export function readerSections(markdown: HTMLElement): ReaderSection[] {
  const sections: ReaderSection[] = [];
  const visit = (block: Element, level = 2) => {
    if (!(block instanceof HTMLElement)) return;
    if (/^H[1-6]$/.test(block.tagName)) {
      const label = sectionLabel(block);
      if (label) sections.push({ element: block, label, level: Number(block.tagName.slice(1)) });
    } else if (block.tagName === "P" || block.tagName === "LI") {
      let leading = true;
      for (const child of block.childNodes) {
        if (child.nodeType === Node.TEXT_NODE && !child.textContent?.trim()) continue;
        if (!(child instanceof HTMLElement)) {
          if (child.nodeType === Node.TEXT_NODE) leading = false;
          continue;
        }
        if (leading && child.tagName === "INPUT" && child.getAttribute("type") === "checkbox")
          continue;
        if (leading && child.tagName === "P") {
          visit(child, level);
        } else if (
          child.tagName === "STRONG" &&
          (leading ||
            (atLineBoundary(child.previousSibling, "before") &&
              atLineBoundary(child.nextSibling, "after")))
        ) {
          const label = sectionLabel(child);
          if (label.endsWith(":") && label.length > 1) {
            sections.push({ element: child, label, level });
          }
        }
        leading = false;
      }
      if (block.tagName === "LI")
        for (const list of block.children)
          if (list.tagName === "UL" || list.tagName === "OL") visit(list, Math.min(level + 1, 6));
    } else if (block.tagName === "UL" || block.tagName === "OL") {
      for (const item of block.children) if (item.tagName === "LI") visit(item, level);
    }
  };
  for (const block of markdown.children) visit(block);
  return sections;
}

/** Use the actual chat/panel scroll viewport, which excludes the composer and application chrome. */
export function readerViewport(content: HTMLElement): HTMLElement | null {
  for (let parent = content.parentElement; parent; parent = parent.parentElement) {
    const overflow = getComputedStyle(parent).overflowY;
    if (
      (overflow === "auto" || overflow === "scroll" || overflow === "overlay") &&
      parent.clientHeight > 0
    )
      return parent;
  }
  return null;
}

export function readerComposer(
  content: HTMLElement,
  viewport: HTMLElement | null,
): HTMLElement | null {
  const canvas = content.closest("[data-chat-canvas]");
  if (!canvas || !viewport || !canvas.contains(viewport)) return null;
  return canvas.querySelector<HTMLElement>(":scope > [data-chat-composer-overlay]");
}

/** Measure the reply's own scroll area, subtracting only a composer that actually covers it. */
export function readerAvailableHeight(
  content: HTMLElement,
  viewport: HTMLElement | null,
  composer: HTMLElement | null,
): number {
  if (!viewport) return window.innerHeight;
  const height = viewport.clientHeight;
  if (!composer) return height;
  const viewportBounds = viewport.getBoundingClientRect();
  const replyBounds = content.getBoundingClientRect();
  const composerBounds = composer.getBoundingClientRect();
  const top = viewportBounds.top + viewport.clientTop;
  const bottom = top + height;
  if (
    composerBounds.height <= 0 ||
    composerBounds.right <= replyBounds.left ||
    composerBounds.left >= replyBounds.right ||
    composerBounds.top >= bottom ||
    composerBounds.bottom <= top
  )
    return height;
  return Math.max(0, Math.min(bottom, composerBounds.top) - top);
}

export function readerNeedsContents(input: {
  sectionCount: number;
  contentHeight: number;
  viewportHeight: number;
  isStreaming: boolean;
}): boolean {
  return (
    !input.isStreaming &&
    input.sectionCount >= 3 &&
    input.viewportHeight > 0 &&
    input.contentHeight > input.viewportHeight
  );
}
