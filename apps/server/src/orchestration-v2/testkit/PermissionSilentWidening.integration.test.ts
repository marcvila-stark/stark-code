/**
 * Silent-widening acceptance tests from PLAN-002 §6 that span packages and
 * that no package suite owns end to end:
 * - §6.1 a saved chat without a permission source keeps the policy it ran
 *   with when the provider can inherit;
 * - §6.4 changing the new-chat default leaves saved chats unchanged (native
 *   terminals: `terminal/NativeAgentLaunch.permissions.test.ts`);
 * - §6.13 the Stark Pages guard catches real publishes, direct, wrapped or
 *   through MCP, in the forms both providers report them, lets ordinary work
 *   through, and Codex never offers a remembered allow for a publish. The
 *   cases are the Claude package's (D1).
 */
import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind, ThreadId } from "@starkfuture/contracts";
import * as Effect from "effect/Effect";

import { codexCommandApprovalChoices } from "../Adapters/CodexApprovalOptions.ts";
import {
  isStarkPagesPublish,
  STARK_PAGES_CONNECTOR_DISALLOWED_TOOLS,
} from "../Adapters/StarkPagesGuard.ts";
import * as RuntimePolicy from "../RuntimePolicy.ts";
import * as ServerSettings from "../../serverSettings.ts";
import {
  claudeId,
  claudeSelection,
  codexSelection,
  createThread,
  layerPermissionRuntime,
  legacyThread,
  setSnapshots,
  threadOf,
  writeLegacyThreads,
} from "./PermissionTestkit.ts";

type GuardCall = Parameters<typeof isStarkPagesPublish>[0];

interface GuardCase {
  readonly name: string;
  readonly call: GuardCall;
}

const claudeBash = (command: string): GuardCall => ({ toolName: "Bash", toolInput: { command } });
/** Codex reports a shell call as its command line, usually wrapped in a login shell. */
const codexShell = (command: string): GuardCall => ({ toolName: "bash", toolInput: { command } });
const codexArgv = (command: ReadonlyArray<string>): GuardCall => ({
  toolName: "exec_command",
  toolInput: { command },
});

const PUBLISHES: ReadonlyArray<GuardCase> = [
  { name: "Claude Bash direct", call: claudeBash("spage publish prepare pages/demo") },
  { name: "Claude Bash chained", call: claudeBash("npm test && spage publish prepare pages/demo") },
  { name: "Claude Bash sh -c", call: claudeBash('sh -c "spage publish prepare pages/demo"') },
  { name: "Claude Bash env", call: claudeBash("env FOO=1 spage publish prepare pages/demo") },
  {
    name: "Claude Bash eval",
    call: claudeBash('eval "spage publish prepare pages/demo"'),
  },
  {
    name: "Claude Bash npx scoped package",
    call: claudeBash("npx -y @stark/spage@1.2.0 publish prepare pages/demo"),
  },
  {
    name: "Claude Bash node script",
    call: claudeBash('node "/kit/spage.js" publish prepare pages/page'),
  },
  {
    name: "Claude Bash curl upload to the Pages bucket",
    call: claudeBash(
      'curl -X PUT --upload-file index.html "https://vibecoded-apps.s3.eu-west-1.amazonaws.com/p/index.html?X-Amz-Signature=1"',
    ),
  },
  {
    name: "Claude Monitor",
    call: { toolName: "Monitor", toolInput: { command: "spage publish prepare x" } },
  },
  {
    name: "Claude Pages connector upload",
    call: { toolName: "mcp__claude_ai_Pages__pages_upload_begin", toolInput: { project: "demo" } },
  },
  {
    name: "Claude Pages connector visibility change",
    call: {
      toolName: "mcp__claude_ai_Pages__pages_update_project",
      toolInput: { visibility: "public" },
    },
  },
  {
    name: "Claude Pages tool on a renamed server",
    call: { toolName: "mcp__stark__pages_delete", toolInput: { page: "page" } },
  },
  {
    name: "Claude MCP gateway proxying a Pages upload",
    call: {
      toolName: "mcp__gateway__call_tool",
      toolInput: { name: "pages_upload_files", arguments: {} },
    },
  },
  {
    name: "Codex login shell",
    call: codexShell('/bin/bash -lc "spage publish prepare pages/demo"'),
  },
  {
    name: "Codex zsh with cd",
    call: codexShell("/bin/zsh -lc 'cd pages && spage publish prepare demo'"),
  },
  { name: "Codex argv", call: codexArgv(["spage", "publish", "prepare", "pages/demo"]) },
  {
    name: "Codex argv through a login shell",
    call: codexArgv(["/bin/zsh", "-lc", "spage publish prepare demo"]),
  },
  {
    name: "Codex curl upload to a Pages host",
    call: codexShell('/bin/bash -lc "curl -sST a.html https://pages.starkfuture.com/demo/a.html"'),
  },
  {
    name: "Codex MCP elicitation for a Pages write",
    call: {
      toolName: "pages_upload_commit",
      toolInput: {},
      mcpServer: { name: "stark-pages", source: "user" },
    },
  },
];

const ORDINARY_WORK: ReadonlyArray<GuardCase> = [
  { name: "Claude grep for the command", call: claudeBash('grep -rn "spage publish" docs') },
  {
    name: "Claude commit message naming it",
    call: claudeBash('git commit -m "spage publish prepare fix"'),
  },
  { name: "Claude spage doctor", call: claudeBash("spage doctor") },
  {
    name: "Claude edit saving a page",
    call: {
      toolName: "Edit",
      toolInput: { file_path: "/repo/src/page.ts", old_string: "a", new_string: "page.save()" },
    },
  },
  {
    name: "Claude read of an upload doc",
    call: { toolName: "Read", toolInput: { file_path: "/repo/docs/output-to-s3.md" } },
  },
  {
    name: "Claude Pages connector read",
    call: {
      toolName: "mcp__claude_ai_Pages__pages_read_file",
      toolInput: { project: "demo", path: "index.html" },
    },
  },
  {
    name: "Claude GitHub PR about publishing",
    call: {
      toolName: "mcp__github__create_pull_request",
      toolInput: { title: "Update pages publish flow" },
    },
  },
  {
    name: "Claude MCP gateway proxying a Pages read",
    call: {
      toolName: "mcp__gateway__call_tool",
      toolInput: { name: "pages_read_file", arguments: {} },
    },
  },
  {
    name: "Claude subagent described with a Pages tool name",
    call: { toolName: "Agent", toolInput: { description: "pages_upload_begin", prompt: "upload" } },
  },
  {
    name: "Codex grep in a login shell",
    call: codexShell("/bin/bash -lc \"grep -rn 'spage publish' docs\""),
  },
  {
    name: "Codex cat of the publish source",
    call: codexArgv(["cat", "packages/spage/src/publish/index.js"]),
  },
  {
    name: "Codex GET of a published page",
    call: codexShell("/bin/zsh -lc 'curl https://pages.starkfuture.com/demo/'"),
  },
  {
    name: "Codex MCP elicitation for a Pages search",
    call: {
      toolName: "pages_search",
      toolInput: { query: "upload" },
      mcpServer: { name: "Pages" },
    },
  },
];

const named = (cases: ReadonlyArray<GuardCase>) =>
  cases.map((guardCase) => [guardCase.name, guardCase.call] as const);

describe("§6.13 the Stark Pages guard across provider forms", () => {
  it.each(named(PUBLISHES))("stops %s", (_name, call) => {
    assert.isTrue(isStarkPagesPublish(call));
  });

  it.each(named(ORDINARY_WORK))("lets %s through", (_name, call) => {
    assert.isFalse(isStarkPagesPublish(call));
  });
});

/** Every decision Codex 0.163 can list for a command, amendments included. */
const EVERY_CODEX_COMMAND_DECISION = [
  "accept",
  "acceptForSession",
  { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["npm", "test"] } },
  {
    applyNetworkPolicyAmendment: {
      network_policy_amendment: { host: "pages.starkfuture.com", action: "allow" },
    },
  },
  {
    applyNetworkPolicyAmendment: {
      network_policy_amendment: { host: "pages.starkfuture.com", action: "deny" },
    },
  },
  "decline",
  "cancel",
] as const;

const codexCommandOf = (call: GuardCall): string | undefined => {
  const command = (call.toolInput as { readonly command?: unknown }).command;
  return typeof command === "string" && call.toolName === "bash" ? command : undefined;
};

describe("§6.13 a Pages publish is never remembered", () => {
  const codexChoiceClasses = (command: string) =>
    codexCommandApprovalChoices({
      command,
      availableDecisions: [...EVERY_CODEX_COMMAND_DECISION],
    }).map((choice) => `${choice.class}:${choice.effect}`);

  it.each(
    named(PUBLISHES).flatMap(([name, call]) => {
      const command = codexCommandOf(call);
      return command === undefined ? [] : [[name, command] as const];
    }),
  )("offers %s only once, with no remembered allow", (_name, command) => {
    // Allow once stays a fresh human decision; a saved block rule is still offered.
    assert.deepEqual(codexChoiceClasses(command), [
      "once:allow",
      "persistent:deny",
      "deny:deny",
      "deny-stop:deny_and_stop",
    ]);
  });

  it.each(
    named(ORDINARY_WORK).flatMap(([name, call]) => {
      const command = codexCommandOf(call);
      return command === undefined ? [] : [[name, command] as const];
    }),
  )("keeps every remembered choice Codex lists for %s", (_name, command) => {
    assert.includeMembers(codexChoiceClasses(command), [
      "session:allow",
      "persistent:allow",
      "persistent:deny",
    ]);
  });

  it("denies every Pages connector write natively, and only writes", () => {
    for (const tool of STARK_PAGES_CONNECTOR_DISALLOWED_TOOLS) {
      assert.isTrue(isStarkPagesPublish({ toolName: tool, toolInput: {} }), tool);
    }
    assert.notInclude(
      STARK_PAGES_CONNECTOR_DISALLOWED_TOOLS,
      "mcp__claude_ai_Pages__pages_read_file",
    );
    assert.notInclude(STARK_PAGES_CONNECTOR_DISALLOWED_TOOLS, "mcp__claude_ai_Pages__pages_search");
  });
});

it.layer(layerPermissionRuntime)("saved chats keep the policy they ran with", (it) => {
  it.effect("§6.1 a chat saved without a source never inherits, even where the provider can", () =>
    Effect.gen(function* () {
      yield* setSnapshots({ claudeInherits: true, codexInherits: true });
      const claudeChat = legacyThread({
        threadId: ThreadId.make("thread:widening:legacy-claude"),
        modelSelection: claudeSelection,
        runtimeMode: "auto-accept-edits",
      });
      const codexChat = legacyThread({
        threadId: ThreadId.make("thread:widening:legacy-codex"),
        modelSelection: codexSelection,
        runtimeMode: "approval-required",
      });
      yield* writeLegacyThreads([claudeChat, codexChat]);
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      for (const [chat, selection] of [
        [claudeChat, claudeSelection],
        [codexChat, codexSelection],
      ] as const) {
        const resolved = yield* policy.resolve({
          thread: yield* threadOf(chat.id),
          modelSelection: selection,
        });
        // No source means override: the stored preset is sent as before.
        assert.isUndefined(resolved.permissionSource, chat.id);
        assert.equal(resolved.runtimeMode, chat.runtimeMode, chat.id);
      }
    }),
  );

  it.effect("§6.4 changing the new-chat default leaves saved chats unchanged", () =>
    Effect.gen(function* () {
      yield* setSnapshots({ claudeInherits: true });
      const threadId = ThreadId.make("thread:widening:new-chat-default");
      yield* createThread({
        threadId,
        modelSelection: claudeSelection,
        runtimeMode: "auto-accept-edits",
        permissionSource: "override",
      });
      const before = yield* threadOf(threadId);
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* settings.updateSettings({
        providerInstances: {
          [claudeId]: {
            driver: ProviderDriverKind.make("claudeAgent"),
            config: {},
            newChatPermissionSource: "inherit",
          },
        },
      });
      const after = yield* threadOf(threadId);
      assert.deepInclude(after, {
        permissionSource: before.permissionSource,
        runtimeMode: before.runtimeMode,
      });
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const resolved = yield* policy.resolve({ thread: after, modelSelection: claudeSelection });
      assert.isUndefined(resolved.permissionSource);
      assert.equal(resolved.runtimeMode, "auto-accept-edits");
    }),
  );
});
