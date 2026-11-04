import {
  type PermissionSource,
  type ProviderActivePermissionReport,
  type ProviderActivePermissionSettings,
  type RuntimeMode,
  permissionSourceOf,
} from "@starkfuture/contracts";
import type * as ProviderAdapter from "@starkfuture/provider-core/server/ProviderAdapter";
import type * as CodexSchema from "effect-codex-app-server/schema";

/**
 * Whether a chat sends Stark's permission preset to Codex (`override`) or
 * leaves Codex's own config, profiles and rules in charge (`inherit`). A
 * policy that does not say is a saved chat, which always overrides.
 */
export function codexPermissionSource(
  policy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
): PermissionSource {
  return permissionSourceOf(policy);
}

/** The three turn settings Stark sends Codex for an override. */
export interface CodexPolicyOverride {
  readonly approvalPolicy: CodexSchema.V2TurnStartParams__AskForApproval;
  readonly approvalsReviewer: CodexSchema.V2TurnStartParams__ApprovalsReviewer;
  readonly sandboxPolicy: CodexSchema.V2TurnStartParams__SandboxPolicy;
}

/**
 * Stark's presets on the Codex wire. Supervised keeps `untrusted` so saved
 * chats migrate unchanged; `granular` below replaces it only where Codex
 * rejects it.
 */
export function codexRuntimeModeTurnDefaults(runtimeMode: RuntimeMode): CodexPolicyOverride {
  switch (runtimeMode) {
    case "approval-required":
      return {
        approvalPolicy: "untrusted",
        approvalsReviewer: "user",
        sandboxPolicy: {
          type: "readOnly",
        },
      };
    case "auto-accept-edits":
      return {
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxPolicy: {
          type: "workspaceWrite",
        },
      };
    case "auto":
      return {
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
        sandboxPolicy: {
          type: "workspaceWrite",
        },
      };
    case "full-access":
      return {
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandboxPolicy: {
          type: "dangerFullAccess",
        },
      };
  }
}

/**
 * What Supervised asks Codex for when it no longer accepts `untrusted`: every
 * approval category goes to the user, and the read-only sandbox stays. Unlike
 * `untrusted`, Codex then runs commands it considers safe inside the sandbox
 * without asking; the owner's live probe decides whether that is acceptable.
 */
export const CODEX_SUPERVISED_GRANULAR_APPROVAL_POLICY = {
  granular: {
    sandbox_approval: true,
    rules: true,
    skill_approval: true,
    request_permissions: true,
    mcp_elicitations: true,
  },
} as const satisfies CodexSchema.V2TurnStartParams__AskForApproval;

/** Whether Codex refused a turn because it no longer accepts `untrusted`. */
export function isCodexUntrustedRejection(error: {
  readonly code?: number | undefined;
  readonly errorMessage?: string | undefined;
}): boolean {
  return (
    (error.code === -32600 || error.code === -32602) &&
    /\buntrusted\b/i.test(error.errorMessage ?? "") &&
    /unknown variant|invalid|unsupported|retired/i.test(error.errorMessage ?? "")
  );
}

/** The permission settings Codex reported for a loaded thread. */
export interface CodexReportedSettings {
  readonly approvalPolicy?: unknown;
  readonly approvalsReviewer?: unknown;
  readonly sandbox?: unknown;
  readonly activePermissionProfile?: { readonly id: string } | null;
}

/** JSON with object keys sorted, for comparing values Codex sent. */
export function codexStableJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    entry !== null && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.entries(entry).toSorted(([left], [right]) => left.localeCompare(right)),
        )
      : entry,
  );
}

function sandboxType(value: unknown): string | undefined {
  return value !== null &&
    typeof value === "object" &&
    "type" in value &&
    typeof value.type === "string"
    ? value.type
    : undefined;
}

const CONFIG_SANDBOX_TYPES: Readonly<Record<string, string>> = {
  "read-only": "readOnly",
  "workspace-write": "workspaceWrite",
  "danger-full-access": "dangerFullAccess",
};

/**
 * Whether Codex's reported settings show the override is no longer in effect,
 * so a chat can switch to Codex's own settings without running under Stark's
 * old preset. Each setting is clear when it differs from the override, or
 * when the user's own config explicitly sets that same value. Anything else
 * fails closed.
 */
export function codexInheritProof(input: {
  readonly reported: CodexReportedSettings | undefined;
  readonly override: CodexPolicyOverride;
  readonly configured?: {
    readonly approval_policy?: unknown;
    readonly approvals_reviewer?: unknown;
    readonly sandbox_mode?: unknown;
    readonly default_permissions?: unknown;
  };
}): { readonly proven: true } | { readonly proven: false; readonly reason: string } {
  const { reported, override, configured } = input;
  if (reported === undefined) {
    return { proven: false, reason: "Codex did not report this chat's settings." };
  }
  const approvalClear =
    codexStableJson(reported.approvalPolicy) !== codexStableJson(override.approvalPolicy) ||
    (configured?.approval_policy != null &&
      codexStableJson(configured.approval_policy) === codexStableJson(reported.approvalPolicy));
  const reviewerClear =
    codexStableJson(reported.approvalsReviewer) !== codexStableJson(override.approvalsReviewer) ||
    (configured?.approvals_reviewer != null &&
      codexStableJson(configured.approvals_reviewer) ===
        codexStableJson(reported.approvalsReviewer));
  // A permission profile only applies when no legacy sandbox overrides it,
  // and Stark only ever overrides with a legacy sandbox.
  const sandboxClear =
    reported.activePermissionProfile != null ||
    sandboxType(reported.sandbox) !== sandboxType(override.sandboxPolicy) ||
    (configured?.default_permissions == null &&
      typeof configured?.sandbox_mode === "string" &&
      CONFIG_SANDBOX_TYPES[configured.sandbox_mode] === sandboxType(reported.sandbox));
  if (approvalClear && reviewerClear && sandboxClear) return { proven: true };
  return {
    proven: false,
    reason: "Codex still reports the permissions Stark set for this chat.",
  };
}

/** A comparable key for what a turn would send Codex for permissions. */
export function codexPolicyKey(source: PermissionSource, override: CodexPolicyOverride): string {
  return source === "inherit" ? "inherit" : codexStableJson(override);
}

/** Codex's sandbox type in the kebab-case words its config uses (`read-only`, ...). */
function codexSandboxName(value: unknown): string | undefined {
  const type =
    typeof value === "string"
      ? value
      : value !== null && typeof value === "object" && "type" in value
        ? value.type
        : undefined;
  if (typeof type !== "string" || type.trim().length === 0) return undefined;
  return type.includes("-") ? type : type.replaceAll(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
}

/** Codex's approval policy in its own word; a granular policy is `granular`. */
function codexApprovalPolicyName(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value);
    return keys.length === 1 ? keys[0] : undefined;
  }
  return undefined;
}

/**
 * What Codex reported for a loaded thread, as the provider session's active
 * permission settings. Values stay in Codex's words.
 */
export function codexActivePermissionSettings(
  reported: CodexReportedSettings,
  reportedBy: ProviderActivePermissionReport,
  reportedAt: string,
): ProviderActivePermissionSettings {
  const nativeMode = codexApprovalPolicyName(reported.approvalPolicy);
  const approvalsReviewer =
    typeof reported.approvalsReviewer === "string" && reported.approvalsReviewer.trim()
      ? reported.approvalsReviewer
      : undefined;
  const sandbox = codexSandboxName(reported.sandbox);
  const permissionProfile = reported.activePermissionProfile?.id.trim() || undefined;
  return {
    ...(nativeMode === undefined ? {} : { nativeMode }),
    ...(approvalsReviewer === undefined ? {} : { approvalsReviewer }),
    ...(sandbox === undefined ? {} : { sandbox }),
    ...(permissionProfile === undefined ? {} : { permissionProfile }),
    reportedBy,
    reportedAt,
  };
}
