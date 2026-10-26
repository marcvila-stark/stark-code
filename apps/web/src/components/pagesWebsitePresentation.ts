type Rect = { x: number; y: number; width: number; height: number };

const OVERLAYS = [
  '[data-slot="menu-popup"]',
  '[data-slot="popover-popup"]',
  '[data-slot="select-popup"]',
  '[data-slot="combobox-popup"]',
  '[data-slot="autocomplete-popup"]',
  '[data-slot="tooltip-popup"]',
  '[data-slot="dialog-popup"]',
  '[data-slot="alert-dialog-popup"]',
  '[data-slot="command-dialog-popup"]',
  '[data-slot="sheet-popup"]',
].join(",");

function intersects(left: Rect, right: Rect) {
  return (
    left.x < right.x + right.width &&
    left.x + left.width > right.x &&
    left.y < right.y + right.height &&
    left.y + left.height > right.y
  );
}

/** Native views sit above HTML. Temporarily uncover overlapping app controls. */
export function pagesWebsitePresentation(host: HTMLElement, active: boolean) {
  const measured = host.getBoundingClientRect();
  const x = Math.max(0, Math.round(measured.x));
  const y = Math.max(0, Math.round(measured.y));
  const rect = {
    x,
    y,
    width: Math.max(0, Math.min(window.innerWidth, Math.round(measured.right)) - x),
    height: Math.max(0, Math.min(window.innerHeight, Math.round(measured.bottom)) - y),
  };
  const visible =
    active &&
    !document.hidden &&
    host.isConnected &&
    !host.closest("[hidden], [inert]") &&
    rect.width > 0 &&
    rect.height > 0;
  if (!visible) return { ...rect, visible: false };

  const covered = [...document.querySelectorAll<HTMLElement>(OVERLAYS)].some((element) => {
    if (
      element.contains(host) ||
      element.closest('[hidden], [inert], [aria-hidden="true"], [data-closed], [data-ending-style]')
    ) {
      return false;
    }
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const overlay = element.getBoundingClientRect();
    return overlay.width > 0 && overlay.height > 0 && intersects(rect, overlay);
  });
  return { ...rect, visible: !covered, ...(covered ? { captureSnapshot: true } : {}) };
}
