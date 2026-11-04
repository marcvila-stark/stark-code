import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";
import type * as EffectCodexSchema from "effect-codex-app-server/schema";

import {
  describeMcpElicitation,
  mcpToolApprovalTarget,
  toMcpElicitationResponse,
} from "./CodexMcpElicitation.ts";

describe("Codex MCP elicitation approvals", () => {
  const request = {
    mode: "form",
    message: "Allow ChatGPT to use Safari?",
    serverName: "computer-use",
    threadId: "provider-thread-1",
    turnId: "turn-1",
    _meta: {
      app_name: "Safari",
      persist: ["session", "always"],
    },
    requestedSchema: {
      type: "object",
      properties: {
        approval: {
          type: "string",
          oneOf: [
            { const: "once", title: "Allow once" },
            { const: "session", title: "Allow for this session" },
            { const: "always", title: "Always allow Safari" },
          ],
        },
      },
      required: ["approval"],
    },
  } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

  it("preserves the app name and the session choice, and never offers Always", () => {
    // Codex does not say what "always" saves, so the card could not show it.
    NodeAssert.deepStrictEqual(describeMcpElicitation(request), {
      appName: "Safari",
      options: [
        { decision: "cancel", label: "Cancel" },
        { decision: "decline", label: "Decline" },
        { decision: "acceptForSession", label: "Allow for this session" },
        { decision: "accept", label: "Approve" },
      ],
    });
  });

  it("extracts the app name from a Computer Use request without metadata", () => {
    const { _meta, ...requestWithoutMetadata } = request;

    NodeAssert.equal(describeMcpElicitation(requestWithoutMetadata).appName, "Safari");
  });

  it("returns the accepted form option to Codex", () => {
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(request, "accept"), {
      action: "accept",
      content: { approval: "once" },
    });
  });

  it("returns session-scoped approval in the MCP response", () => {
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(request, "acceptForSession"), {
      action: "accept",
      _meta: { persist: "session" },
      content: { approval: "session" },
    });
  });

  it("returns persistent approval in the MCP response", () => {
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(request, "acceptAlways"), {
      action: "accept",
      _meta: { persist: "always" },
      content: { approval: "always" },
    });
  });

  it("returns rejection without form content", () => {
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(request, "decline"), {
      action: "decline",
    });
  });

  it("returns cancellation without form content", () => {
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(request, "cancel"), {
      action: "cancel",
    });
  });

  it("supports boolean permanent-approval fields", () => {
    const booleanRequest = {
      ...request,
      _meta: { app_name: "Safari" },
      requestedSchema: {
        type: "object",
        properties: {
          always: { type: "boolean", title: "Always allow Safari" },
        },
      },
    } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

    NodeAssert.ok(
      !describeMcpElicitation(booleanRequest).options.some(
        (option) => option.decision === "acceptAlways",
      ),
    );
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(booleanRequest, "acceptAlways"), {
      action: "accept",
      _meta: { persist: "always" },
      content: { always: true },
    });
  });

  it("preserves valid nullable MCP form fields and persistence choices", () => {
    const nullableRequest = {
      ...request,
      _meta: {
        app_name: null,
        appName: "Safari",
        connector_name: null,
        persist: null,
        target: null,
        tool_params: null,
      },
      requestedSchema: {
        type: "object",
        properties: {
          approval: {
            type: "string",
            title: null,
            description: null,
            default: null,
            enum: ["once", "always"],
            enumNames: null,
          },
        },
        required: ["approval"],
      },
    } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

    NodeAssert.equal(describeMcpElicitation(nullableRequest).appName, "Safari");
    NodeAssert.ok(
      !describeMcpElicitation(nullableRequest).options.some(
        (option) => option.decision === "acceptAlways",
      ),
    );
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(nullableRequest, "acceptAlways"), {
      action: "accept",
      _meta: { persist: "always" },
      content: { approval: "always" },
    });
  });

  it("declines required form fields that an approval prompt cannot collect", () => {
    const inputRequest = {
      ...request,
      requestedSchema: {
        type: "object",
        properties: {
          email: { type: "string", format: "email" },
        },
        required: ["email"],
      },
    } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

    NodeAssert.deepStrictEqual(toMcpElicitationResponse(inputRequest, "accept"), {
      action: "decline",
    });
  });

  it("does not approve URL elicitations without opening their requested URL", () => {
    const urlRequest = {
      mode: "url",
      message: "Finish signing in to continue.",
      serverName: "computer-use",
      threadId: "provider-thread-1",
      turnId: "turn-1",
      elicitationId: "sign-in-1",
      url: "https://example.com/authorize",
    } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

    NodeAssert.deepStrictEqual(toMcpElicitationResponse(urlRequest, "accept"), {
      action: "decline",
    });
  });

  it("omits persistence choices that cannot satisfy required form fields", () => {
    const onceOnlyRequest = {
      ...request,
      _meta: { app_name: "Safari", persist: ["session", "always"] },
      requestedSchema: {
        type: "object",
        properties: {
          approval: {
            type: "string",
            enum: ["once"],
          },
        },
        required: ["approval"],
      },
    } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

    NodeAssert.deepStrictEqual(describeMcpElicitation(onceOnlyRequest).options, [
      { decision: "cancel", label: "Cancel" },
      { decision: "decline", label: "Decline" },
      { decision: "accept", label: "Approve" },
    ]);
  });

  it("never answers a required field with a default the user did not see", () => {
    const defaultedRequest = {
      ...request,
      requestedSchema: {
        type: "object",
        properties: {
          approval: { type: "string", oneOf: [{ const: "once", title: "Allow once" }] },
          scope: { type: "string", default: "all-repositories" },
        },
        required: ["approval", "scope"],
      },
    } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

    NodeAssert.deepStrictEqual(toMcpElicitationResponse(defaultedRequest, "accept"), {
      action: "decline",
    });
    // An optional defaulted field is left for the server to fill.
    NodeAssert.deepStrictEqual(
      toMcpElicitationResponse(
        {
          ...defaultedRequest,
          requestedSchema: { ...defaultedRequest.requestedSchema, required: ["approval"] },
        },
        "accept",
      ),
      { action: "accept", content: { approval: "once" } },
    );
  });

  const toolApproval = {
    mode: "form",
    message: 'Allow the stark-pages MCP server to run tool "publish"?',
    serverName: "stark-pages",
    threadId: "provider-thread-1",
    turnId: "turn-1",
    _meta: {
      codex_approval_kind: "mcp_tool_call",
      persist: ["session", "always"],
      tool_title: "Publish page",
      tool_params: { project: "site", path: "index.html" },
    },
    requestedSchema: { type: "object", properties: {} },
  } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

  it("asks afresh for every Stark Pages publish", () => {
    // The Pages MCP server's write tools are named `pages_…`.
    NodeAssert.deepStrictEqual(
      describeMcpElicitation({
        ...toolApproval,
        _meta: { ...toolApproval._meta, tool_name: "pages_upload_files" },
      }).options.map((option) => option.decision),
      ["cancel", "decline", "accept"],
    );
    // A shell tool whose command may publish gets no session approval either.
    NodeAssert.deepStrictEqual(
      describeMcpElicitation({
        ...toolApproval,
        serverName: "terminal",
        message: 'Allow the terminal MCP server to run tool "shell"?',
        _meta: {
          ...toolApproval._meta,
          tool_name: "shell",
          tool_params: { command: "$CMD publish ./site" },
        },
      }).options.map((option) => option.decision),
      ["cancel", "decline", "accept"],
    );
    NodeAssert.ok(
      describeMcpElicitation({
        ...toolApproval,
        serverName: "terminal",
        message: 'Allow the terminal MCP server to run tool "shell"?',
        _meta: { ...toolApproval._meta, tool_name: "shell", tool_params: { command: "npm test" } },
      }).options.some((option) => option.decision === "acceptForSession"),
    );
    NodeAssert.ok(
      describeMcpElicitation({
        ...toolApproval,
        serverName: "github",
        message: 'Allow the github MCP server to run tool "create_issue"?',
        _meta: { ...toolApproval._meta, tool_title: "Create issue", tool_params: { title: "Bug" } },
      }).options.some((option) => option.decision === "acceptForSession"),
    );
  });

  it("reads a tool approval's own call from its metadata, and nothing else", () => {
    NodeAssert.deepStrictEqual(mcpToolApprovalTarget(toolApproval), {
      server: "stark-pages",
      tool: undefined,
      title: "Publish page",
      arguments: { project: "site", path: "index.html" },
    });
    NodeAssert.equal(mcpToolApprovalTarget(request), undefined);
    const { tool_params: _params, ...withoutParams } = toolApproval._meta;
    NodeAssert.equal(mcpToolApprovalTarget({ ...toolApproval, _meta: withoutParams }), undefined);
  });
});
