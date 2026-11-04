import type {
  EffectivePermissionRow,
  ProviderInstanceConfig,
  ProviderInstanceId,
  ProviderPermissionSettings,
  ProviderSessionId,
} from "@starkfuture/contracts";
import * as Effect from "effect/Effect";

/**
 * What Codex's `config/read` (effective config for a cwd) and
 * `configRequirements/read` (managed requirements) report, keeping only the
 * permission keys. Values stay as Codex sent them.
 */
export interface CodexConfiguredPermissionsReport {
  readonly config: {
    readonly approval_policy?: unknown;
    readonly approvals_reviewer?: unknown;
    readonly sandbox_mode?: unknown;
    readonly default_permissions?: unknown;
  };
  /** Null when no requirements are configured; undefined when Codex did not say. */
  readonly requirements?:
    | {
        readonly allowedApprovalPolicies?: ReadonlyArray<unknown> | null;
        readonly allowedSandboxModes?: ReadonlyArray<unknown> | null;
        readonly defaultPermissions?: string | null;
      }
    | null
    | undefined;
}

/** Reads a cwd's report from a Codex app-server; undefined when Codex could not answer. */
export type CodexConfigReader = (
  cwd: string,
) => Effect.Effect<CodexConfiguredPermissionsReport | undefined>;

const readers = new Map<string, CodexConfigReader>();

/**
 * Lets the effective-permissions inspector ask a configured Codex instance
 * through its adapter's status app-server. Returns the unregister function,
 * which the adapter runs when its scope closes.
 */
export function registerCodexConfigReader(
  providerInstanceId: string,
  reader: CodexConfigReader,
): () => void {
  readers.set(providerInstanceId, reader);
  return () => {
    if (readers.get(providerInstanceId) === reader) readers.delete(providerInstanceId);
  };
}

const NOT_REPORTED = { configured: null, rows: [] } as const;
const CONFIG_READ_TIMEOUT = "10 seconds";

/**
 * What Codex's configuration resolves to for the next launch in `cwd`, read
 * from `config/read` and `configRequirements/read` of the chat's Codex
 * instance. Configuration is not proof of a running session, and it does not
 * depend on the session or the instance's stored config, which the Claude
 * reader needs and this one ignores. Null when Codex cannot be asked; the
 * inspector then says Codex did not report it.
 */
export const readCodexConfiguredPermissions = (input: {
  readonly cwd: string | null;
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerSessionId: ProviderSessionId | null;
  /** The chat's provider instance as configured; undefined when it no longer exists. */
  readonly instance?: ProviderInstanceConfig | undefined;
}): Effect.Effect<{
  readonly configured: ProviderPermissionSettings | null;
  readonly rows: ReadonlyArray<EffectivePermissionRow>;
}> =>
  Effect.gen(function* () {
    if (input.cwd === null) return NOT_REPORTED;
    const reader = readers.get(input.providerInstanceId);
    if (reader === undefined) return NOT_REPORTED;
    const report = yield* reader(input.cwd).pipe(
      Effect.timeout(CONFIG_READ_TIMEOUT),
      Effect.catchCause(() => Effect.succeed(undefined)),
    );
    return report === undefined ? NOT_REPORTED : codexConfiguredPermissions(report);
  });

const nonEmpty = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

/** An approval policy in Codex's own word; a granular policy is `granular`. */
function approvalPolicyName(value: unknown): string | undefined {
  if (typeof value === "string") return nonEmpty(value);
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value);
    return keys.length === 1 ? keys[0] : undefined;
  }
  return undefined;
}

const APPROVAL_POLICY_LABELS: Readonly<Record<string, string>> = {
  untrusted: "Asks before commands it does not trust",
  "on-request": "Asks when Codex decides it should",
  "on-failure": "Asks when a sandboxed command fails",
  never: "Never asks",
  granular: "Asks for the categories it lists",
};
const REVIEWER_LABELS: Readonly<Record<string, string>> = {
  user: "You",
  auto_review: "Codex automatic review",
  guardian_subagent: "Codex automatic review",
};
const SANDBOX_LABELS: Readonly<Record<string, string>> = {
  "read-only": "Read-only",
  "workspace-write": "Writes inside the workspace",
  "danger-full-access": "No sandbox",
};

const CONFIG_DETAIL = "Codex's configuration for the next launch in this folder.";
const UNSET = "Not set: Codex's default";

/** The configured settings and inspector rows for one `config/read` report. */
export function codexConfiguredPermissions(report: CodexConfiguredPermissionsReport): {
  readonly configured: ProviderPermissionSettings;
  readonly rows: ReadonlyArray<EffectivePermissionRow>;
} {
  const approvalPolicy = approvalPolicyName(report.config.approval_policy);
  const reviewer = nonEmpty(report.config.approvals_reviewer);
  const sandbox = nonEmpty(report.config.sandbox_mode);
  const profile = nonEmpty(report.config.default_permissions);
  const configRow = (
    id: string,
    label: string,
    nativeValue: string | undefined,
    labels: Readonly<Record<string, string>>,
  ): EffectivePermissionRow => ({
    id,
    kind: "configured",
    label,
    value: nativeValue === undefined ? UNSET : (labels[nativeValue] ?? nativeValue),
    ...(nativeValue === undefined ? {} : { nativeValue }),
    origin: "codex-config",
    detail: CONFIG_DETAIL,
  });
  const requirements = report.requirements ?? undefined;
  const allowedList = (values: ReadonlyArray<unknown> | null | undefined) => {
    const names = (values ?? []).flatMap((value) => {
      const name = approvalPolicyName(value);
      return name === undefined ? [] : [name];
    });
    return names.length === 0 ? undefined : names.join(", ");
  };
  const allowedPolicies = allowedList(requirements?.allowedApprovalPolicies);
  const allowedSandboxes = allowedList(requirements?.allowedSandboxModes);
  const requiredProfile = nonEmpty(requirements?.defaultPermissions);
  const requirementRow = (id: string, label: string, value: string): EffectivePermissionRow => ({
    id,
    kind: "configured",
    label,
    value,
    origin: "requirements",
    detail: "Set by your organization's Codex requirements; chats cannot go beyond it.",
  });
  return {
    configured: {
      // Configuration is what a chat that uses Codex's own settings runs with.
      permissionSource: "inherit",
      ...(approvalPolicy === undefined ? {} : { nativeMode: approvalPolicy }),
      ...(reviewer === undefined ? {} : { approvalsReviewer: reviewer }),
      ...(sandbox === undefined ? {} : { sandbox }),
      ...(profile === undefined ? {} : { permissionProfile: profile }),
    },
    rows: [
      configRow(
        "codex-config-approval-policy",
        "Approval policy",
        approvalPolicy,
        APPROVAL_POLICY_LABELS,
      ),
      configRow(
        "codex-config-approvals-reviewer",
        "Approvals reviewed by",
        reviewer,
        REVIEWER_LABELS,
      ),
      // A permission profile replaces the legacy sandbox mode.
      profile === undefined
        ? configRow("codex-config-sandbox", "Sandbox", sandbox, SANDBOX_LABELS)
        : configRow("codex-config-permission-profile", "Permission profile", profile, {}),
      ...(allowedPolicies === undefined
        ? []
        : [
            requirementRow(
              "codex-requirements-approval-policies",
              "Allowed approval policies",
              allowedPolicies,
            ),
          ]),
      ...(allowedSandboxes === undefined
        ? []
        : [
            requirementRow(
              "codex-requirements-sandbox-modes",
              "Allowed sandboxes",
              allowedSandboxes,
            ),
          ]),
      ...(requiredProfile === undefined
        ? []
        : [
            requirementRow(
              "codex-requirements-default-permissions",
              "Required permission profile",
              requiredProfile,
            ),
          ]),
    ],
  };
}
