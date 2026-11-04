import { icon, esc } from "./icons.js";
const panel = document.querySelector("#panel");
const state = {
  screen: "review",
  tab: "existing",
  query: "",
  record: null,
  records: [],
  catalog: null,
  error: "",
  busy: false,
  expanded: false,
  receipt: null,
  extensionId: chrome.runtime.id,
};
const writes = new Set();
let poll = null;
async function send(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok)
    throw new Error(response?.error || "The capture could not be saved. Try again.");
  return response.result;
}
function report(error) {
  state.error = error instanceof Error ? error.message : String(error);
  render();
  document.querySelector("#announcement").textContent = state.error;
}
function clearPoll() {
  if (poll !== null) clearTimeout(poll);
  poll = null;
}
function header(title, back = false) {
  return `<header class="panel-header">${back ? `<button class="icon-button" id="back" aria-label="Back to capture">${icon("back")}</button>` : '<img class="mark" src="icon.png" alt="">'}<h1 class="panel-title" id="view-title" tabindex="-1">${title}</h1>${!back ? `<span class="device"><span class="dot${state.catalog ? "" : " offline"}"></span>${state.catalog ? "Connected" : "Not connected"}</span>${state.record ? `<button class="icon-button" id="delete" aria-label="Delete capture"${state.busy ? " disabled" : ""}>${icon("close")}</button>` : ""}` : ""}</header>`;
}
function setup() {
  return `<details class="setup-details"><summary>Connect this extension to Stark</summary><p>Open the browser capture section in Stark’s Browser settings. Paste this extension ID and choose Connect Chrome.</p><input class="extension-id" aria-label="Chrome extension ID" readonly value="${esc(state.extensionId)}"><p>Open the matching Stark profile before retrying. Captures stay on this device until saved to a chat draft.</p></details>`;
}
function errors() {
  return state.error ? `<div class="error-block" role="alert">${esc(state.error)}</div>` : "";
}
function pendingPicker() {
  return state.records.length > 1
    ? `<label class="pending-picker">Pending <select id="pending-capture" aria-label="Choose a pending capture"${state.busy ? " disabled" : ""}>${state.records.map((record) => `<option value="${esc(record.id)}"${record.id === state.record?.capture.id ? " selected" : ""}>${esc(record.pageTitle || record.kind)}</option>`).join("")}</select></label>`
    : "";
}
function preview() {
  const c = state.record.capture;
  return `<div class="capture${state.expanded ? " expanded" : ""}${c.kind !== "text" ? " media" : ""}"><div class="capture-top">${icon(c.kind === "text" ? "quote" : c.kind === "image" ? "image" : "crop")}<span class="capture-source">${c.kind === "text" ? "Text selection" : c.kind === "image" ? "Image" : "Screenshot region"} · ${esc(c.pageTitle)}</span>${c.kind === "region" && state.record.stage === "review" ? '<button class="capture-action" id="retake">Retake</button>' : ""}</div>${c.kind === "text" ? `<button class="text-preview" id="expand" aria-expanded="${state.expanded}" aria-label="${state.expanded ? "Collapse" : "Read full"} text selection"><span class="quote">“${esc(c.text)}”</span></button>` : `<img class="image-preview" src="${esc(c.imageDataUrl)}" alt="Your captured ${c.kind === "region" ? "page region" : "image"}">`}<a class="source" href="${esc(c.pageUrl)}" target="_blank" rel="noreferrer noopener">${icon("link")}<span>${esc(c.pageUrl.replace(/^https?:\/\//, ""))}</span></a>${c.imageFallback ? '<div class="capture-caption">Captured from the visible page</div>' : ""}</div>`;
}
function destination() {
  const r = state.record;
  return `<button class="destination" id="choose"${state.busy ? " disabled" : ""}>${icon(r.target?.kind === "new" ? "plus" : "chat")}<span class="destination-text"><span class="destination-title">${r.target ? esc((r.target.kind === "new" ? "New · " : "") + (r.targetLabel || "Selected chat")) : "Choose a chat"}</span><span class="destination-meta">${esc(r.projectLabel || "Existing chat or New chat")}</span></span><span class="change">Change ${icon("down")}</span></button>`;
}
function review() {
  if (!state.record)
    return (
      header("Add to Stark") +
      `<div class="empty-content">${errors()}<h2>Capture something from this page.</h2><p>Select text or right-click an image, then choose <strong>Send to Stark Code</strong>.</p><button class="primary" id="region">Capture region ${icon("crop")}</button>${!state.catalog ? setup() : ""}${state.records.length ? '<button class="text-button" id="review-pending">Review pending captures</button>' : ""}</div>`
    );
  const pending = state.record.stage === "pending";
  return (
    header("Add to Stark") +
    `<div class="content">${pendingPicker()}${preview()}<textarea class="note" id="note" aria-label="Optional note" placeholder="Add a note… (optional)" rows="1"${pending || state.busy ? " disabled" : ""}>${esc(state.record.capture.note)}</textarea>${destination()}${errors()}${pending ? '<div class="status"><p>Delivery is assigned to this chat. It has not been confirmed saved yet.</p></div>' : ""}<button class="primary" id="add"${state.busy || (!state.record.target && state.catalog) ? " disabled" : ""}>${state.busy ? "Saving…" : !state.catalog ? "Retry connection" : pending ? "Retry delivery" : state.record.target?.kind === "new" ? "Create chat & add to draft" : "Add to draft"} ${icon("arrow")}</button><p class="helper">You review and send from Stark.</p>${!state.catalog ? setup() : ""}</div>`
  );
}
function choose() {
  const list = state.catalog?.destinations || [],
    projects = state.catalog?.projects || [];
  const filtered = list.filter((item) =>
    (item.label + " " + item.projectLabel + " " + item.environmentLabel)
      .toLowerCase()
      .includes(state.query.toLowerCase()),
  );
  return (
    header("Choose chat", true) +
    `<div class="choose-content"><div class="segmented" role="tablist" aria-label="Chat destination"><button class="segment" id="existing-tab" role="tab" data-tab="existing" aria-controls="existing-panel" aria-selected="${state.tab === "existing"}" tabindex="${state.tab === "existing" ? 0 : -1}">Existing chat</button><button class="segment" id="new-tab" role="tab" data-tab="new" aria-controls="new-panel" aria-selected="${state.tab === "new"}" tabindex="${state.tab === "new" ? 0 : -1}">New chat</button></div><div id="existing-panel" role="tabpanel" aria-labelledby="existing-tab"${state.tab !== "existing" ? " hidden" : ""}><div class="search-wrap">${icon("search")}<input class="search" id="search" aria-label="Search chats" placeholder="Search chats…" value="${esc(state.query)}"></div><div class="chat-list" style="margin-top:8px">${filtered.length ? filtered.map((item) => `<button class="chat-row" data-destination="${list.indexOf(item)}" aria-pressed="${JSON.stringify(item.target) === JSON.stringify(state.record.target)}">${icon("chat")}<span class="chat-text"><span class="chat-name">${esc(item.label)}</span><span class="chat-project">${esc(item.projectLabel)} · ${esc(item.environmentLabel)}</span></span>${item.current ? `<span class="current">Open ${icon("check")}</span>` : ""}</button>`).join("") : '<p class="empty">No matching recent chats. Open an older chat in Stark to choose it, or try New chat.</p>'}</div></div><div id="new-panel" role="tabpanel" aria-labelledby="new-tab"${state.tab !== "new" ? " hidden" : ""}><form class="new-form" id="new-form"><label class="form-field"><span class="field-label">Project</span><select class="field" id="project" required>${projects.map((project, index) => `<option value="${index}">${esc(project.label)} · ${esc(project.environmentLabel)}</option>`).join("")}</select></label><label class="form-field"><span class="field-label">Chat name</span><input class="field" id="chat-name" maxlength="120" required value="${esc(state.record.capture.pageTitle.slice(0, 120) || "Browser reference")}"></label><p class="choose-foot">Uses this project’s normal chat settings.<br>Created only when you add the capture.</p><button class="primary" type="submit"${!projects.length ? " disabled" : ""}>Use new chat ${icon("arrow")}</button></form></div>${errors()}</div>`
  );
}
function receipt() {
  return (
    header("Added to draft") +
    `<div class="receipt-content"><span class="receipt-check">${icon("check")}</span><h2>Ready in ${esc(state.receipt.label || "your chat")}</h2><p>The capture and source link are saved in the draft. The agent waits for you to send.</p><button class="primary" id="open">Open Stark ${icon("link")}</button><button class="text-button" id="review-pending">${state.records.length ? "Review pending captures" : "Capture something else"}</button>${errors()}</div>`
  );
}
function render(focus) {
  panel.innerHTML =
    state.screen === "choose" ? choose() : state.screen === "receipt" ? receipt() : review();
  bind();
  if (focus) document.querySelector(focus)?.focus();
}
function queueSave() {
  const r = state.record;
  if (!r || r.stage !== "review") return Promise.resolve();
  const snapshot = {
    type: "save",
    id: r.capture.id,
    note: r.capture.note,
    target: r.target,
    targetLabel: r.targetLabel || "",
    projectLabel: r.projectLabel || "",
  };
  // Send while the popup is alive; ordering belongs to the persistent worker.
  const operation = send(snapshot);
  writes.add(operation);
  void operation.finally(() => writes.delete(operation)).catch(() => {});
  return operation;
}
const flushWrites = () => Promise.all(writes);
async function load() {
  const result = await send({ type: "state" });
  state.record = result.record;
  state.records = result.records;
  state.extensionId = result.extensionId;
  state.error = result.captureError || "";
  state.receipt = result.lastReceipt || null;
  state.screen = state.receipt ? "receipt" : "review";
  render();
  if (result.captureError) void send({ type: "clear-error" });
}
async function connect() {
  try {
    state.catalog = await send({ type: "catalog" });
    state.error = "";
    if (state.record && !state.record.target && state.record.stage === "review") {
      const suggested = state.catalog.destinations.find((item) => item.current);
      if (suggested) {
        state.record.target = suggested.target;
        state.record.targetLabel = suggested.label;
        state.record.projectLabel = `${suggested.projectLabel} · ${suggested.environmentLabel}`;
        await queueSave();
      }
    }
    render();
  } catch (error) {
    state.catalog = null;
    report(error);
  }
}
async function showReceipt(result) {
  clearPoll();
  state.receipt = result;
  state.record = null;
  state.records = state.records.filter((item) => item.id !== result.id);
  state.screen = "receipt";
  state.error = "";
  state.busy = false;
  render("#view-title");
}
async function pollReceipt(id, remaining = 25) {
  clearPoll();
  if (remaining <= 0) return;
  poll = setTimeout(async () => {
    try {
      const result = await send({ type: "receipt", id });
      if (result?.state === "saved") return showReceipt(result);
      if (result?.state === "error") {
        report(new Error(result.message));
        return;
      }
      pollReceipt(id, remaining - 1);
    } catch (error) {
      state.catalog = null;
      report(error);
    }
  }, 1000);
}
async function add() {
  if (state.busy) return;
  if (!state.catalog) {
    await connect();
    return;
  }
  if (!state.record?.target) return;
  state.busy = true;
  state.error = "";
  render();
  try {
    await queueSave();
    await flushWrites();
    const result = await send({ type: "deliver", id: state.record.capture.id });
    state.record.stage = "pending";
    if (result.state === "saved") return await showReceipt(result);
    state.busy = false;
    if (result.state === "error") state.error = result.message;
    render();
    if (result.state === "pending") pollReceipt(state.record.capture.id);
  } catch (error) {
    state.busy = false;
    try {
      const persisted = await send({ type: "state" });
      if (persisted.record?.capture.id === state.record?.capture.id)
        state.record = persisted.record;
    } catch {}
    report(error);
  }
}
async function change() {
  clearPoll();
  await connect();
  if (!state.catalog) return;
  if (state.record.stage === "pending") {
    state.busy = true;
    render();
    try {
      const result = await send({ type: "cancel-delivery", id: state.record.capture.id });
      if (result?.state === "saved") return showReceipt(result);
      await load();
      if (!state.record) {
        state.busy = false;
        render();
        return;
      }
    } catch (error) {
      state.busy = false;
      report(error);
      return;
    }
  }
  state.busy = false;
  state.screen = "choose";
  state.query = "";
  render("#view-title");
}
async function startRegion(replace = false) {
  try {
    if (state.busy) return;
    await flushWrites();
    await send({
      type: "capture-region",
      ...(replace && state.record ? { replaceId: state.record.capture.id } : {}),
    });
    window.close();
  } catch (error) {
    report(error);
  }
}
function bind() {
  document.querySelector("#note")?.addEventListener("input", (event) => {
    state.record.capture.note = event.target.value;
    void queueSave().catch(report);
  });
  document.querySelector("#add")?.addEventListener("click", () => void add());
  document.querySelector("#choose")?.addEventListener("click", () => void change());
  document.querySelector("#back")?.addEventListener("click", () => {
    state.screen = "review";
    render("#choose");
  });
  document.querySelector("#expand")?.addEventListener("click", () => {
    state.expanded = !state.expanded;
    render("#expand");
  });
  document.querySelector("#region")?.addEventListener("click", () => void startRegion());
  document.querySelector("#retake")?.addEventListener("click", () => void startRegion(true));
  document
    .querySelector("#open")
    ?.addEventListener("click", () => void send({ type: "open" }).catch(report));
  document.querySelector("#delete")?.addEventListener("click", () => {
    const id = state.record.capture.id;
    clearPoll();
    void send({ type: "delete", id })
      .then(async (result) => {
        if (result?.state === "saved") return showReceipt(result);
        state.receipt = null;
        await load();
      })
      .catch(report);
  });
  document.querySelector("#review-pending")?.addEventListener("click", () => {
    state.receipt = null;
    state.screen = "review";
    void send({ type: "state" })
      .then((result) => {
        state.record = result.record;
        state.records = result.records;
        render();
      })
      .catch(report);
  });
  document.querySelector("#pending-capture")?.addEventListener("change", (event) => {
    clearPoll();
    void flushWrites()
      .then(() => send({ type: "select-capture", id: event.target.value }))
      .then(load)
      .catch(report);
  });
  document.querySelectorAll("[data-tab]").forEach((button) => {
    const select = (tab) => {
      state.tab = tab;
      render(`#${tab}-tab`);
    };
    button.addEventListener("click", () => select(button.dataset.tab));
    button.addEventListener("keydown", (event) => {
      if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        select(
          event.key === "Home"
            ? "existing"
            : event.key === "End"
              ? "new"
              : state.tab === "existing"
                ? "new"
                : "existing",
        );
      }
    });
  });
  document.querySelector("#search")?.addEventListener("input", (event) => {
    const cursor = event.target.selectionStart;
    state.query = event.target.value;
    render("#search");
    document.querySelector("#search").setSelectionRange(cursor, cursor);
  });
  document.querySelectorAll("[data-destination]").forEach((button) =>
    button.addEventListener("click", () => {
      const item = state.catalog.destinations[Number(button.dataset.destination)];
      state.record.target = item.target;
      state.record.targetLabel = item.label;
      state.record.projectLabel = `${item.projectLabel} · ${item.environmentLabel}`;
      state.screen = "review";
      state.error = "";
      void queueSave().catch(report);
      render("#choose");
    }),
  );
  document.querySelector("#new-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const name = document.querySelector("#chat-name"),
      title = name.value.trim();
    if (!title) {
      name.setCustomValidity("Enter a chat name.");
      name.reportValidity();
      return;
    }
    const project = state.catalog.projects[Number(document.querySelector("#project").value)];
    if (!project) return;
    state.record.target = {
      kind: "new",
      environmentId: project.environmentId,
      projectId: project.projectId,
      title,
    };
    state.record.targetLabel = title;
    state.record.projectLabel = `${project.label} · ${project.environmentLabel}`;
    state.screen = "review";
    void queueSave().catch(report);
    render("#choose");
  });
  document
    .querySelector("#chat-name")
    ?.addEventListener("input", (event) => event.target.setCustomValidity(""));
  document
    .querySelector(".extension-id")
    ?.addEventListener("click", (event) => event.target.select());
}
addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.screen === "choose") {
    event.preventDefault();
    state.screen = "review";
    render("#choose");
  }
});
void load().then(connect).catch(report);
