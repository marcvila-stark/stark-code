import { ORCHESTRATION_V2_WS_METHODS, WS_METHODS } from "@starkfuture/contracts";

import type { SlowRpcAckRequest } from "./requestLatencyState";

/**
 * Plain names for the requests the slow-request toast can name. Anything not
 * listed is "A server request"; the toast's details still show the method.
 */
const REQUEST_NAMES = new Map<string, string>([
  [ORCHESTRATION_V2_WS_METHODS.dispatchCommand, "Sending your chat action"],
  [ORCHESTRATION_V2_WS_METHODS.launchThread, "Starting the chat"],
  [ORCHESTRATION_V2_WS_METHODS.getThreadProjection, "Loading the chat"],
  [ORCHESTRATION_V2_WS_METHODS.getTurnDiff, "Loading changes"],
  [ORCHESTRATION_V2_WS_METHODS.getFullThreadDiff, "Loading changes"],
  [WS_METHODS.mcpServersList, "Checking connectors"],
  [WS_METHODS.mcpAppsToolInfo, "Checking connectors"],
  [WS_METHODS.serverGetUsageSummary, "Checking usage limits"],
  [WS_METHODS.serverRefreshUsageRates, "Checking usage limits"],
  [WS_METHODS.providerReadContextUsage, "Checking context use"],
  [WS_METHODS.providerReadSessionCatalog, "Listing agent sessions"],
  [WS_METHODS.providerReadPermissionRules, "Reading permission rules"],
  [WS_METHODS.providerReadEffectivePermissions, "Reading permissions"],
  [WS_METHODS.claudeAccountsSnapshot, "Checking Claude accounts"],
  [WS_METHODS.vcsRefreshStatus, "Checking Git status"],
  [WS_METHODS.vcsListRefs, "Listing branches"],
  [WS_METHODS.serverGetHostResources, "Reading diagnostics"],
  [WS_METHODS.serverGetProcessDiagnostics, "Reading diagnostics"],
  [WS_METHODS.serverGetTraceDiagnostics, "Reading diagnostics"],
  [WS_METHODS.serverGetProcessResourceHistory, "Reading diagnostics"],
  [WS_METHODS.serverGetResourceTelemetryHistory, "Reading diagnostics"],
  [WS_METHODS.serverReportClientActivity, "Reporting app activity"],
  [WS_METHODS.serverReportHostPowerState, "Reporting app activity"],
]);

/**
 * Requests that only inspect or report state beside the conversation. The
 * agent never waits for them, so their slowness cannot delay a reply. Many
 * poll a busy provider and are slow while it works or awaits an approval.
 */
const BACKGROUND_METHODS = new Set<string>([
  WS_METHODS.mcpServersList,
  WS_METHODS.mcpAppsToolInfo,
  WS_METHODS.serverGetUsageSummary,
  WS_METHODS.serverRefreshUsageRates,
  WS_METHODS.providerReadContextUsage,
  WS_METHODS.providerReadSessionCatalog,
  WS_METHODS.providerReadPermissionRules,
  WS_METHODS.providerReadEffectivePermissions,
  WS_METHODS.claudeAccountsSnapshot,
  WS_METHODS.vcsRefreshStatus,
  WS_METHODS.vcsListRefs,
  WS_METHODS.serverGetHostResources,
  WS_METHODS.serverGetProcessDiagnostics,
  WS_METHODS.serverGetTraceDiagnostics,
  WS_METHODS.serverGetProcessResourceHistory,
  WS_METHODS.serverGetResourceTelemetryHistory,
  WS_METHODS.serverReportClientActivity,
  WS_METHODS.serverReportHostPowerState,
]);

/** Requests a reply waits on: sending, answering, stopping or starting a chat. */
const REPLY_METHODS = new Set<string>([
  ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
  ORCHESTRATION_V2_WS_METHODS.launchThread,
]);

/** A background check already reported this recently does not raise another toast. */
export const SLOW_BACKGROUND_REPEAT_QUIET_MS = 5 * 60_000;

export function slowRequestName(method: string): string {
  return REQUEST_NAMES.get(method) ?? "A server request";
}

/**
 * Whether the slow requests can delay the agent's reply. Only requests known
 * to be background checks may claim they do not; unknown ones claim nothing.
 */
export function slowRequestReplyImpact(
  methods: Iterable<string>,
): "not-delayed" | "may-delay" | "unknown" {
  let impact: "not-delayed" | "unknown" = "not-delayed";
  for (const method of methods) {
    if (REPLY_METHODS.has(method)) return "may-delay";
    if (!BACKGROUND_METHODS.has(method)) impact = "unknown";
  }
  return impact;
}

export function describeSlowRequests(requests: ReadonlyArray<SlowRpcAckRequest>): {
  readonly title: string;
  readonly description: string;
  readonly impact: ReturnType<typeof slowRequestReplyImpact>;
} {
  const names = [...new Set(requests.map((request) => slowRequestName(request.method)))];
  // Thresholds vary per method, so report the smallest one the batch has passed.
  const thresholdSeconds = Math.round(
    Math.min(...requests.map((request) => request.thresholdMs)) / 1000,
  );
  const impact = slowRequestReplyImpact(requests.map((request) => request.method));
  const several = requests.length > 1;
  const waiting =
    names.length === 1
      ? `${names[0]} is taking longer than ${thresholdSeconds}s.`
      : `${requests.length} requests are taking longer than ${thresholdSeconds}s: ${names
          .map((name) => name.toLowerCase())
          .join(", ")}.`;
  const consequence =
    impact === "not-delayed"
      ? several
        ? " These checks do not delay your reply."
        : " This check does not delay your reply."
      : impact === "may-delay"
        ? " Your reply may be delayed until it finishes."
        : "";
  return {
    title:
      impact === "not-delayed"
        ? several
          ? "Background checks are slow"
          : "A background check is slow"
        : several
          ? "Some requests are slow"
          : "A request is slow",
    description: `${waiting}${consequence}`,
    impact,
  };
}

/**
 * One toast covers an episode: from the first slow request until nothing is
 * slow. Within it the toast updates in place, and once the user closes it, it
 * stays closed until the episode ends.
 */
export interface SlowRequestToastState {
  /** Methods the current episode's toast has named. */
  readonly shownMethods: ReadonlySet<string>;
  readonly dismissed: boolean;
  /** When each background method's last shown episode ended, in epoch ms. */
  readonly backgroundReportedAt: ReadonlyMap<string, number>;
}

export const INITIAL_SLOW_REQUEST_TOAST_STATE: SlowRequestToastState = {
  shownMethods: new Set(),
  dismissed: false,
  backgroundReportedAt: new Map(),
};

export function dismissSlowRequestToast(state: SlowRequestToastState): SlowRequestToastState {
  return state.dismissed ? state : { ...state, dismissed: true };
}

/**
 * Decides the toast for the current slow requests. Polled background checks
 * finish and start again, which used to open a fresh toast each time; one
 * already reported in the last few minutes now stays quiet.
 */
export function stepSlowRequestToast(
  state: SlowRequestToastState,
  requests: ReadonlyArray<SlowRpcAckRequest>,
  nowMs: number,
): {
  readonly state: SlowRequestToastState;
  readonly show: ReadonlyArray<SlowRpcAckRequest>;
} {
  if (requests.length === 0) {
    if (state.shownMethods.size === 0 && !state.dismissed) return { state, show: [] };
    const backgroundReportedAt = new Map(state.backgroundReportedAt);
    for (const method of state.shownMethods) {
      if (BACKGROUND_METHODS.has(method)) backgroundReportedAt.set(method, nowMs);
    }
    return {
      state: { shownMethods: new Set(), dismissed: false, backgroundReportedAt },
      show: [],
    };
  }
  if (state.dismissed) return { state, show: [] };
  const show = requests.filter((request) => {
    if (state.shownMethods.has(request.method) || !BACKGROUND_METHODS.has(request.method)) {
      return true;
    }
    const reportedAt = state.backgroundReportedAt.get(request.method);
    return reportedAt === undefined || nowMs - reportedAt >= SLOW_BACKGROUND_REPEAT_QUIET_MS;
  });
  if (show.every((request) => state.shownMethods.has(request.method))) {
    return { state, show };
  }
  return {
    state: {
      ...state,
      shownMethods: new Set([...state.shownMethods, ...show.map((request) => request.method)]),
    },
    show,
  };
}
