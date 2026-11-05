import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import { JSDOM } from "jsdom";

const projects = [
  {
    environmentId: "local",
    projectId: "current",
    label: "Current folder",
    environmentLabel: "Mac",
  },
  {
    environmentId: "local",
    projectId: "research",
    label: "Research folder",
    environmentLabel: "Mac",
  },
];
const selected = {
  kind: "new",
  environmentId: "local",
  projectId: "research",
  title: 'Evidence & "日本語"',
};

async function popup(t, target = null, availableProjects = projects) {
  const dom = new JSDOM('<section id="panel"></section><div id="announcement"></div>', {
    url: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/popup.html",
  });
  t.after(() => dom.window.close());
  const document = dom.window.document;
  const saves = [];
  const record = {
    capture: {
      version: 1,
      id: "destination-fixture",
      kind: "text",
      pageUrl: "https://example.com/reference",
      pageTitle: "Reference page",
      capturedAt: "2026-11-05T08:00:00Z",
      text: "Synthetic reference",
      note: "Keep the source",
    },
    target,
    targetLabel: target?.title ?? "",
    projectLabel: "Research folder · Mac",
    stage: "review",
  };
  Object.assign(globalThis, {
    document,
    window: dom.window,
    addEventListener: dom.window.addEventListener.bind(dom.window),
    chrome: {
      runtime: {
        id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        sendMessage: async (message) => {
          if (message.type === "state")
            return {
              ok: true,
              result: structuredClone({ record, records: [{ id: record.capture.id }] }),
            };
          if (message.type === "catalog")
            return {
              ok: true,
              result: structuredClone({ projects: availableProjects, destinations: [] }),
            };
          if (message.type === "save") {
            saves.push(structuredClone(message));
            return { ok: true };
          }
          throw new Error(`Unexpected operation: ${message.type}`);
        },
      },
    },
  });
  async function until(predicate) {
    if (predicate()) return;
    await new Promise((resolve, reject) => {
      const observer = new dom.window.MutationObserver(() => {
        if (predicate()) finish();
      });
      const timer = setTimeout(
        () => finish(new Error("Expected popup state did not render")),
        2000,
      );
      function finish(error) {
        clearTimeout(timer);
        observer.disconnect();
        if (error) reject(error);
        else resolve();
      }
      observer.observe(document.querySelector("#panel"), { childList: true, subtree: true });
    });
  }
  await import(`../src/popup.js?destination-test=${encodeURIComponent(t.name)}`);
  await until(() => document.querySelector(".device")?.textContent === "Connected");
  async function choose() {
    document.querySelector("#choose").click();
    await until(() => !!document.querySelector("#new-tab"));
  }
  function newTab() {
    document.querySelector("#new-tab").click();
  }
  function edit(title, projectIndex) {
    const name = document.querySelector("#chat-name");
    name.value = title;
    name.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    const project = document.querySelector("#project");
    project.value = String(projectIndex);
    project.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  }
  function confirm() {
    document
      .querySelector("#new-form")
      .dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  }
  return { document, saves, choose, newTab, edit, confirm };
}

NodeTest.test(
  "reopening Change preserves the chosen new chat and confirming does not move it",
  async (t) => {
    const p = await popup(t);
    await p.choose();
    p.newTab();
    p.edit(selected.title, 1);
    p.confirm();
    NodeAssert.deepEqual(p.saves.at(-1).target, selected);
    await p.choose();
    NodeAssert.equal(p.document.querySelector("#new-tab").getAttribute("aria-selected"), "true");
    NodeAssert.equal(p.document.querySelector("#chat-name").value, selected.title);
    NodeAssert.equal(p.document.querySelector("#project").value, "1");
    p.confirm();
    NodeAssert.deepEqual(p.saves.at(-1).target, selected);
    NodeAssert.equal(p.saves.at(-1).note, "Keep the source");
  },
);

NodeTest.test(
  "a reopened popup matches projects by environment and ID after catalogue reorder",
  async (t) => {
    const p = await popup(t, selected, [
      { ...projects[1], environmentId: "remote", environmentLabel: "Other Mac" },
      projects[1],
      projects[0],
    ]);
    await p.choose();
    p.newTab();
    NodeAssert.equal(p.document.querySelector("#project").value, "1");
    NodeAssert.equal(p.document.querySelector("#chat-name").value, selected.title);
    p.confirm();
    NodeAssert.deepEqual(p.saves.at(-1).target, selected);
  },
);

NodeTest.test(
  "a missing selected project requires reselection rather than silently using the first",
  async (t) => {
    const p = await popup(t, selected, [projects[0]]);
    await p.choose();
    p.newTab();
    NodeAssert.equal(p.document.querySelector("#project").value, "");
    p.confirm();
    NodeAssert.equal(p.saves.length, 0);
    p.edit(selected.title, 0);
    p.confirm();
    NodeAssert.deepEqual(p.saves.at(-1).target, { ...selected, projectId: "current" });
  },
);

NodeTest.test(
  "fresh defaults remain useful and tab switching retains unconfirmed form edits",
  async (t) => {
    const p = await popup(t);
    await p.choose();
    p.newTab();
    NodeAssert.equal(p.document.querySelector("#chat-name").value, "Reference page");
    NodeAssert.equal(p.document.querySelector("#project").value, "0");
    p.edit(selected.title, 1);
    p.document.querySelector("#existing-tab").click();
    p.newTab();
    NodeAssert.equal(p.document.querySelector("#chat-name").value, selected.title);
    NodeAssert.equal(p.document.querySelector("#project").value, "1");
    NodeAssert.equal(p.saves.length, 0);
  },
);

NodeTest.test(
  "Back cancels destination editing without replacing an existing unsent draft",
  async (t) => {
    const target = {
      kind: "draft",
      environmentId: "local",
      projectId: "current",
      draftId: "draft",
    };
    const p = await popup(t, target);
    await p.choose();
    p.newTab();
    p.edit(selected.title, 1);
    p.document.querySelector("#back").click();
    NodeAssert.equal(p.saves.length, 0);
    NodeAssert.equal(p.document.querySelector("#add").textContent.trim(), "Add to draft");
  },
);
