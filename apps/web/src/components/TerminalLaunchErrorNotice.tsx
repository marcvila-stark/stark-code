import { useNavigate } from "@tanstack/react-router";
import type { EnvironmentId, ProviderInstanceId } from "@starkfuture/contracts";
import { Button } from "./ui/button";

/** Startup refusals also stay visible when no terminal renderer has started. */
export function TerminalLaunchErrorNotice(props: {
  readonly message: string;
  readonly environmentId: EnvironmentId;
  readonly providerInstanceId?: ProviderInstanceId;
}) {
  const navigate = useNavigate();
  return (
    <div role="alert" className="space-y-3 border-b bg-background p-4">
      <p className="text-sm text-destructive">{props.message}</p>
      {props.providerInstanceId ? (
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            void navigate({
              to: "/settings/providers",
              search: {
                environmentId: props.environmentId,
                ...(props.providerInstanceId ? { instanceId: props.providerInstanceId } : {}),
              },
            })
          }
        >
          Open provider settings
        </Button>
      ) : null}
    </div>
  );
}
