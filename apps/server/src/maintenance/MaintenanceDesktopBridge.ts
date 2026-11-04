import type { DesktopMaintenanceRequest } from "@starkfuture/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as DesktopTelemetryReceiver from "../resourceTelemetry/DesktopTelemetryReceiver.ts";
import * as MaintenanceGate from "./MaintenanceGate.ts";

const handle = (
  gate: MaintenanceGate.MaintenanceGateService,
  request: DesktopMaintenanceRequest,
) => {
  switch (request.action) {
    case "prepare":
      return gate.prepare({ requestId: request.requestId, mode: request.mode ?? "probe" });
    case "renew":
      return gate.renew(request.requestId);
    case "release":
      return gate.release(request.requestId);
    case "resumeRecovery":
      return gate.resumeRecovery;
    case "status":
      return gate.status;
  }
};

/**
 * Serves the desktop app's maintenance requests over its private telemetry
 * channel: each request gets a `maintenanceStatus` reply with the gate's
 * state, blockers and recovery hold. Not parked behind activation, so a
 * backend that is still starting can still be asked.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const receiver = yield* DesktopTelemetryReceiver.DesktopTelemetryReceiver;
    const gate = yield* MaintenanceGate.MaintenanceGate;
    const requests = yield* receiver.maintenanceRequests;
    yield* requests.pipe(
      Stream.runForEach((request) =>
        handle(gate, request).pipe(
          Effect.flatMap((status) =>
            receiver.sendMaintenanceStatus({ replyTo: request.requestId, status }),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not answer a maintenance request", {
              action: request.action,
              cause,
            }),
          ),
        ),
      ),
      Effect.forkScoped,
    );
  }),
);
