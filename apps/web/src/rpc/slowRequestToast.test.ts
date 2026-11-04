import { ORCHESTRATION_V2_WS_METHODS, WS_METHODS } from "@starkfuture/contracts";
import { describe, expect, it } from "vite-plus/test";

import { SLOW_RPC_ACK_THRESHOLD_MS, type SlowRpcAckRequest } from "./requestLatencyState";
import {
  INITIAL_SLOW_REQUEST_TOAST_STATE,
  SLOW_BACKGROUND_REPEAT_QUIET_MS,
  describeSlowRequests,
  dismissSlowRequestToast,
  stepSlowRequestToast,
  type SlowRequestToastState,
} from "./slowRequestToast";

let nextRequestId = 0;
const slow = (method: string): SlowRpcAckRequest => {
  nextRequestId += 1;
  return {
    requestId: String(nextRequestId),
    method,
    startedAt: "2026-10-28T18:00:00.000Z",
    startedAtMs: 0,
    tag: `${method} · env-1`,
    thresholdMs: SLOW_RPC_ACK_THRESHOLD_MS,
  };
};

/** Runs a sequence of slow-request snapshots and returns what each one shows. */
function run(
  steps: ReadonlyArray<readonly [atMs: number, requests: ReadonlyArray<SlowRpcAckRequest>]>,
  start: SlowRequestToastState = INITIAL_SLOW_REQUEST_TOAST_STATE,
) {
  let state = start;
  const shown = steps.map(([atMs, requests]) => {
    const step = stepSlowRequestToast(state, requests, atMs);
    state = step.state;
    return step.show.map((request) => request.method);
  });
  return { shown, state };
}

describe("slow request toast copy", () => {
  it("says a slow background check does not delay the reply", () => {
    expect(describeSlowRequests([slow(WS_METHODS.mcpServersList)])).toEqual({
      title: "A background check is slow",
      description:
        "Checking connectors is taking longer than 15s. This check does not delay your reply.",
      impact: "not-delayed",
    });
    expect(
      describeSlowRequests([
        slow(WS_METHODS.mcpServersList),
        slow(WS_METHODS.serverRefreshUsageRates),
      ]).description,
    ).toBe(
      "2 requests are taking longer than 15s: checking connectors, checking usage limits. These checks do not delay your reply.",
    );
  });

  it("says the reply may wait when sending a chat action is slow", () => {
    const copy = describeSlowRequests([
      slow(WS_METHODS.mcpServersList),
      slow(ORCHESTRATION_V2_WS_METHODS.dispatchCommand),
    ]);
    expect(copy.title).toBe("Some requests are slow");
    expect(copy.description).toContain("Your reply may be delayed until it finishes.");
  });

  it("makes no claim about the reply for a request it does not know", () => {
    const copy = describeSlowRequests([
      slow(WS_METHODS.mcpServersList),
      slow(WS_METHODS.serverGetConfig),
    ]);
    expect(copy.impact).toBe("unknown");
    expect(copy.description).not.toContain("reply");
    expect(copy.description).toContain("a server request");
  });
});

describe("slow request toast episodes", () => {
  it("keeps one toast for an episode and closes it when nothing is slow", () => {
    const send = slow(ORCHESTRATION_V2_WS_METHODS.dispatchCommand);
    const connectors = slow(WS_METHODS.mcpServersList);
    expect(
      run([
        [0, [send]],
        [1_000, [send, connectors]],
        [2_000, [connectors]],
        [3_000, []],
      ]).shown,
    ).toEqual([
      [ORCHESTRATION_V2_WS_METHODS.dispatchCommand],
      [ORCHESTRATION_V2_WS_METHODS.dispatchCommand, WS_METHODS.mcpServersList],
      [WS_METHODS.mcpServersList],
      [],
    ]);
  });

  it("stays closed for the rest of an episode once the user closes it", () => {
    const first = run([[0, [slow(WS_METHODS.serverGetConfig)]]]);
    const dismissed = dismissSlowRequestToast(first.state);
    const config = slow(WS_METHODS.serverGetConfig);
    expect(
      run(
        [
          [1_000, [config, slow(ORCHESTRATION_V2_WS_METHODS.dispatchCommand)]],
          [2_000, []],
          [3_000, [config]],
        ],
        dismissed,
      ).shown,
    ).toEqual([[], [], [WS_METHODS.serverGetConfig]]);
  });

  it("does not reopen a toast for a background check it reported minutes ago", () => {
    const poll = () => slow(WS_METHODS.mcpServersList);
    expect(
      run([
        [0, [poll()]],
        [20_000, []],
        // The next poll is slow again, as polls of a busy provider are.
        [45_000, [poll()]],
        [60_000, []],
        [20_000 + SLOW_BACKGROUND_REPEAT_QUIET_MS, [poll()]],
      ]).shown,
    ).toEqual([[WS_METHODS.mcpServersList], [], [], [], [WS_METHODS.mcpServersList]]);
  });

  it("reports a request the reply waits on every time it is slow", () => {
    const send = () => slow(ORCHESTRATION_V2_WS_METHODS.dispatchCommand);
    expect(
      run([
        [0, [send()]],
        [20_000, []],
        [45_000, [send()]],
      ]).shown,
    ).toEqual([
      [ORCHESTRATION_V2_WS_METHODS.dispatchCommand],
      [],
      [ORCHESTRATION_V2_WS_METHODS.dispatchCommand],
    ]);
  });
});
