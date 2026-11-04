/** Injected in Chrome's isolated world. Keep this function self-contained. */
export function beginRegionSelection(nonce) {
  globalThis.__starkCaptureRegionCleanup?.();
  globalThis.__starkCaptureRegionNonce = nonce;
  const host = document.createElement("div");
  host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;display:block;";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `<style>*{box-sizing:border-box}.overlay{position:fixed;inset:0;cursor:crosshair;touch-action:none;font:13px -apple-system,BlinkMacSystemFont,system-ui,sans-serif;color:#f4f4f6}.shade{position:absolute;inset:0;background:#12121855}.selection{position:absolute;border:1px solid #fff;box-shadow:0 0 0 9999px #12121877;display:none;pointer-events:none}.toolbar{position:absolute;top:14px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:10px;padding:7px 8px 7px 13px;border:1px solid #666671;border-radius:10px;background:#222226;box-shadow:0 4px 16px #0003;cursor:default;white-space:nowrap}.toolbar span{font-size:12px;color:#c4c4ce;margin-right:6px}button{height:30px;border:1px solid #666671;border-radius:6px;padding:0 11px;background:#303036;color:#f4f4f6;font:12px system-ui;cursor:pointer}button:last-child{background:#e8e8ed;color:#19191c;border-color:#e8e8ed}button:disabled{opacity:.5;cursor:default}button:focus-visible{outline:2px solid #a8caff;outline-offset:2px}</style><div class="overlay" tabindex="-1" role="dialog" aria-label="Choose a screenshot region"><div class="shade"></div><div class="selection"></div><div class="toolbar"><span>Drag a region · arrows adjust · Esc cancels</span><button id="cancel">Cancel</button><button id="use" disabled>Use region</button></div></div>`;
  const overlay = root.querySelector(".overlay"),
    selection = root.querySelector(".selection"),
    shade = root.querySelector(".shade"),
    toolbar = root.querySelector(".toolbar"),
    use = root.querySelector("#use");
  let start = null,
    rect = null,
    pointer = null,
    finished = false;
  const clamp = (value, max) => Math.max(0, Math.min(max, value));
  const update = () => {
    if (!rect) return;
    Object.assign(selection.style, {
      display: "block",
      left: rect.x + "px",
      top: rect.y + "px",
      width: rect.width + "px",
      height: rect.height + "px",
    });
    shade.style.display = "none";
    use.disabled = rect.width < 3 || rect.height < 3;
  };
  const send = (message) => {
    void chrome.runtime.sendMessage({ ...message, nonce }).catch(() => {});
  };
  const cleanup = () => {
    host.remove();
    document.removeEventListener("keydown", key, true);
    document.removeEventListener("wheel", stopScroll, true);
    window.removeEventListener("pagehide", cancel);
    globalThis.__starkCaptureRegionCleanup = undefined;
  };
  const cancel = () => {
    if (finished) return;
    finished = true;
    cleanup();
    send({ type: "region-cancel" });
  };
  const confirm = async () => {
    if (finished || !rect || use.disabled) return;
    finished = true;
    const viewport = { width: innerWidth, height: innerHeight };
    cleanup();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    send({ type: "region-result", rect, viewport });
  };
  function key(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancel();
      return;
    }
    if (event.key === "Enter" && rect && root.activeElement === overlay) {
      event.preventDefault();
      void confirm();
      return;
    }
    if (rect && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
      event.preventDefault();
      const delta = event.shiftKey ? 10 : 1;
      if (event.key === "ArrowLeft") rect.x = clamp(rect.x - delta, innerWidth - rect.width);
      if (event.key === "ArrowRight") rect.x = clamp(rect.x + delta, innerWidth - rect.width);
      if (event.key === "ArrowUp") rect.y = clamp(rect.y - delta, innerHeight - rect.height);
      if (event.key === "ArrowDown") rect.y = clamp(rect.y + delta, innerHeight - rect.height);
      update();
      return;
    }
    if (event.key === "Tab") {
      // This temporary page overlay is modal: keep keyboard focus on its two actions.
      const controls = [root.querySelector("#cancel"), use].filter((button) => !button.disabled);
      const index = controls.indexOf(root.activeElement);
      event.preventDefault();
      controls[
        index < 0
          ? event.shiftKey
            ? controls.length - 1
            : 0
          : (index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length
      ].focus();
    }
  }
  const stopScroll = (event) => event.preventDefault();
  overlay.addEventListener("pointerdown", (event) => {
    if (event.composedPath().includes(toolbar) || event.button !== 0) return;
    start = { x: clamp(event.clientX, innerWidth), y: clamp(event.clientY, innerHeight) };
    pointer = event.pointerId;
    overlay.setPointerCapture(pointer);
    event.preventDefault();
  });
  overlay.addEventListener("pointermove", (event) => {
    if (!start || event.pointerId !== pointer) return;
    const x = clamp(event.clientX, innerWidth),
      y = clamp(event.clientY, innerHeight);
    rect = {
      x: Math.min(start.x, x),
      y: Math.min(start.y, y),
      width: Math.abs(x - start.x),
      height: Math.abs(y - start.y),
    };
    update();
  });
  overlay.addEventListener("pointerup", (event) => {
    if (event.pointerId === pointer) {
      start = null;
      pointer = null;
      use.focus();
    }
  });
  overlay.addEventListener("pointercancel", () => {
    start = null;
    pointer = null;
  });
  overlay.addEventListener("lostpointercapture", () => {
    start = null;
    pointer = null;
  });
  root.querySelector("#cancel").addEventListener("click", cancel);
  use.addEventListener("click", () => void confirm());
  document.addEventListener("keydown", key, true);
  document.addEventListener("wheel", stopScroll, { capture: true, passive: false });
  window.addEventListener("pagehide", cancel, { once: true });
  document.documentElement.append(host);
  overlay.focus();
  globalThis.__starkCaptureRegionCleanup = cancel;
}
