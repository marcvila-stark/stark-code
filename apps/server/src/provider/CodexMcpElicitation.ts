import type { ProviderApprovalDecision, ProviderApprovalOption } from "@starkfuture/contracts";
import * as Schema from "effect/Schema";
import type * as EffectCodexSchema from "effect-codex-app-server/schema";

import { mayPublishToStarkPages } from "../orchestration-v2/Adapters/StarkPagesGuard.ts";

const NullableMcpElicitationString = Schema.NullOr(Schema.String);
const McpElicitationMetadata = Schema.Struct({
  app: Schema.optionalKey(NullableMcpElicitationString),
  app_name: Schema.optionalKey(NullableMcpElicitationString),
  appName: Schema.optionalKey(NullableMcpElicitationString),
  connector_name: Schema.optionalKey(NullableMcpElicitationString),
  connectorName: Schema.optionalKey(NullableMcpElicitationString),
  allowPersistentApproval: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  persist: Schema.optionalKey(
    Schema.NullOr(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  ),
  target: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        app: Schema.optionalKey(NullableMcpElicitationString),
        name: Schema.optionalKey(NullableMcpElicitationString),
      }),
    ),
  ),
  tool_params: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        app: Schema.optionalKey(NullableMcpElicitationString),
        app_name: Schema.optionalKey(NullableMcpElicitationString),
      }),
    ),
  ),
});
const McpElicitationFormField = Schema.Struct({
  type: Schema.optionalKey(NullableMcpElicitationString),
  title: Schema.optionalKey(NullableMcpElicitationString),
  description: Schema.optionalKey(NullableMcpElicitationString),
  default: Schema.optionalKey(Schema.Json),
  enum: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
  enumNames: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
  oneOf: Schema.optionalKey(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          const: Schema.String,
          title: Schema.optionalKey(NullableMcpElicitationString),
        }),
      ),
    ),
  ),
});
const McpElicitationForm = Schema.Struct({
  properties: Schema.optionalKey(Schema.Record(Schema.String, McpElicitationFormField)),
  required: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
});
const isMcpElicitationMetadata = Schema.is(McpElicitationMetadata);
const isMcpElicitationForm = Schema.is(McpElicitationForm);

type McpElicitationPersistenceDecision = Extract<
  ProviderApprovalDecision,
  "acceptForSession" | "acceptAlways"
>;

function mcpElicitationPersistenceDecision(
  value: string,
): McpElicitationPersistenceDecision | null {
  const normalized = value.toLowerCase();
  if (normalized.includes("session")) return "acceptForSession";
  if (
    normalized.includes("always") ||
    normalized.includes("permanent") ||
    normalized.includes("forever") ||
    normalized.includes("persistent")
  ) {
    return "acceptAlways";
  }
  return null;
}

function mcpElicitationFormFields(payload: EffectCodexSchema.McpServerElicitationRequestParams) {
  if (payload.mode === "url" || !isMcpElicitationForm(payload.requestedSchema)) {
    return undefined;
  }
  return payload.requestedSchema;
}

function mcpElicitationFieldOptions(field: typeof McpElicitationFormField.Type) {
  if (field.oneOf) {
    return field.oneOf.map((option) => ({ value: option.const, label: option.title }));
  }
  return (field.enum ?? []).map((value, index) => ({
    value,
    label: field.enumNames?.[index],
  }));
}

function isMcpElicitationPersistenceField(
  key: string,
  field: typeof McpElicitationFormField.Type,
): boolean {
  return (
    mcpElicitationPersistenceDecision(key) !== null ||
    key.toLowerCase() === "persist" ||
    mcpElicitationPersistenceDecision(field.title ?? "") !== null ||
    mcpElicitationPersistenceDecision(field.description ?? "") !== null
  );
}

/** Returns the app and approval choices advertised by an MCP elicitation. */
export function describeMcpElicitation(
  payload: EffectCodexSchema.McpServerElicitationRequestParams,
): { readonly appName: string; readonly options: ReadonlyArray<ProviderApprovalOption> } {
  const metadata = isMcpElicitationMetadata(payload._meta) ? payload._meta : undefined;
  const appName =
    metadata?.app_name ??
    metadata?.appName ??
    metadata?.app ??
    metadata?.target?.app ??
    metadata?.target?.name ??
    metadata?.tool_params?.app_name ??
    metadata?.tool_params?.app ??
    payload.message.match(/^Allow ChatGPT to use (.+?)\?$/i)?.[1] ??
    metadata?.connector_name ??
    metadata?.connectorName ??
    payload.serverName;
  const persistenceOptions = new Map<McpElicitationPersistenceDecision, string>();
  const persist = metadata?.persist;
  for (const value of typeof persist === "string" ? [persist] : (persist ?? [])) {
    const decision = mcpElicitationPersistenceDecision(value);
    if (decision) persistenceOptions.set(decision, "");
  }
  if (metadata?.allowPersistentApproval) {
    persistenceOptions.set("acceptAlways", "");
  }

  const form = mcpElicitationFormFields(payload);
  for (const [key, field] of Object.entries(form?.properties ?? {})) {
    for (const option of mcpElicitationFieldOptions(field)) {
      const decision = mcpElicitationPersistenceDecision(option.value);
      if (decision) persistenceOptions.set(decision, option.label ?? "");
    }
    if (field.type === "boolean" && isMcpElicitationPersistenceField(key, field)) {
      persistenceOptions.set("acceptAlways", field.title ?? "");
    }
  }

  // Publishing to Stark Pages, or a call that may publish, always takes a
  // fresh decision. "Always" is not offered at all: Codex does not say what it
  // saves, so the card could not show the exact rule (PLAN-002 §4).
  // An elicitation that names no tool is judged by its message, so a Pages
  // server asking to publish still counts.
  const target = mcpToolApprovalTarget(payload);
  const publish = mayPublishToStarkPages({
    toolName: target?.tool ?? target?.title ?? payload.message,
    toolInput: target?.arguments ?? null,
    mcpServer: { name: payload.serverName },
  });
  return {
    appName,
    options: [
      { decision: "cancel", label: "Cancel" },
      { decision: "decline", label: "Decline" },
      ...(!publish &&
      persistenceOptions.has("acceptForSession") &&
      toMcpElicitationResponse(payload, "acceptForSession").action === "accept"
        ? [
            {
              decision: "acceptForSession" as const,
              label: persistenceOptions.get("acceptForSession") || "Always allow this session",
            },
          ]
        : []),
      { decision: "accept", label: "Approve" },
    ],
  };
}

const McpToolApprovalMetadata = Schema.Struct({
  codex_approval_kind: Schema.Literal("mcp_tool_call"),
  tool_name: Schema.optionalKey(NullableMcpElicitationString),
  tool_title: Schema.optionalKey(NullableMcpElicitationString),
  tool_params: Schema.Json,
});
const isMcpToolApprovalMetadata = Schema.is(McpToolApprovalMetadata);

/**
 * The MCP tool call a Codex tool approval asks about, from the request's own
 * metadata: its server, tool and exact arguments. Undefined for any other
 * elicitation, so an approval never borrows the arguments of another call.
 */
export function mcpToolApprovalTarget(
  payload: EffectCodexSchema.McpServerElicitationRequestParams,
):
  | {
      readonly server: string;
      readonly tool: string | undefined;
      readonly title: string | undefined;
      readonly arguments: Schema.Json;
    }
  | undefined {
  if (payload.mode === "url" || !isMcpToolApprovalMetadata(payload._meta)) return undefined;
  const meta = payload._meta;
  const tool = meta.tool_name?.trim() || undefined;
  const title = meta.tool_title?.trim() || undefined;
  return { server: payload.serverName, tool, title, arguments: meta.tool_params };
}

/** Converts a Stark approval decision into the MCP elicitation wire response. */
export function toMcpElicitationResponse(
  payload: EffectCodexSchema.McpServerElicitationRequestParams,
  decision: ProviderApprovalDecision,
): EffectCodexSchema.McpServerElicitationRequestResponse {
  if (decision === "decline" || decision === "cancel") {
    return { action: decision };
  }

  if (payload.mode === "url") {
    return { action: "decline" };
  }

  const persist =
    decision === "acceptForSession"
      ? "session"
      : decision === "acceptAlways"
        ? "always"
        : undefined;
  const form = mcpElicitationFormFields(payload);
  const content: Record<string, Schema.Json> = {};

  for (const [key, field] of Object.entries(form?.properties ?? {})) {
    const options = mcpElicitationFieldOptions(field);
    const chosenOption = options.find((option) =>
      persist
        ? mcpElicitationPersistenceDecision(option.value) === decision
        : /once|accept|approve|allow/i.test(option.value) &&
          mcpElicitationPersistenceDecision(option.value) === null,
    );
    // Only fields the approval itself answers are filled. A default is a
    // value the user never saw, so a required field without an answer
    // declines the request instead.
    if (chosenOption) {
      content[key] = chosenOption.value;
    } else if (field.type === "boolean" && isMcpElicitationPersistenceField(key, field)) {
      content[key] = decision === "acceptAlways";
    }
  }

  if (form?.required?.some((key) => !Object.hasOwn(content, key))) {
    return { action: "decline" };
  }

  return {
    action: "accept",
    ...(persist ? { _meta: { persist } } : {}),
    ...(form ? { content } : {}),
  };
}
