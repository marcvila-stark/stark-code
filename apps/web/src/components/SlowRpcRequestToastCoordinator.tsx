import { useEffect, useRef } from "react";

import { type SlowRpcAckRequest, useSlowRpcAckRequests } from "../rpc/requestLatencyState";
import {
  INITIAL_SLOW_REQUEST_TOAST_STATE,
  describeSlowRequests,
  dismissSlowRequestToast,
  slowRequestName,
  stepSlowRequestToast,
} from "../rpc/slowRequestToast";
import { toastManager } from "./ui/toast";

function SlowRequestDetails({ requests }: { requests: ReadonlyArray<SlowRpcAckRequest> }) {
  return (
    <ul className="space-y-2.5 text-xs text-muted-foreground">
      {requests.map((request) => (
        <li
          className="min-w-0 border-border/50 border-b pb-2 last:border-b-0 last:pb-0"
          key={request.requestId}
        >
          <div className="wrap-break-word font-medium text-foreground">
            {slowRequestName(request.method)}
          </div>
          <div className="wrap-break-word mt-0.5 text-3xs opacity-75">
            {request.tag} · started {new Date(request.startedAt).toLocaleTimeString()}
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * Shows one toast per slow-request episode, updated in place and closed once
 * nothing is slow. Closing it keeps it closed for the rest of the episode.
 */
export function SlowRpcRequestToastCoordinator() {
  const slowRequests = useSlowRpcAckRequests();
  const toastIdRef = useRef<ReturnType<typeof toastManager.add> | null>(null);
  const stateRef = useRef(INITIAL_SLOW_REQUEST_TOAST_STATE);

  useEffect(() => {
    const step = stepSlowRequestToast(stateRef.current, slowRequests, Date.now());
    stateRef.current = step.state;
    if (step.show.length === 0) {
      if (toastIdRef.current !== null) {
        toastManager.close(toastIdRef.current);
        toastIdRef.current = null;
      }
      return;
    }

    const { title, description, impact } = describeSlowRequests(step.show);
    const nextToast = {
      data: {
        expandableContent: <SlowRequestDetails requests={step.show} />,
        expandableDescriptionTrigger: true,
        expandableLabels: { collapse: "Hide requests", expand: "Show requests" },
        onClose: () => {
          stateRef.current = dismissSlowRequestToast(stateRef.current);
          toastIdRef.current = null;
        },
      },
      description,
      timeout: 0,
      title,
      type: impact === "not-delayed" ? ("info" as const) : ("warning" as const),
    };

    if (toastIdRef.current === null) {
      toastIdRef.current = toastManager.add(nextToast);
    } else {
      toastManager.update(toastIdRef.current, nextToast);
    }
  }, [slowRequests]);

  useEffect(
    () => () => {
      if (toastIdRef.current !== null) {
        toastManager.close(toastIdRef.current);
      }
    },
    [],
  );

  return null;
}
