import type {
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
} from "@starkfuture/contracts";
import type * as Stream from "effect/Stream";
import type { ManagedServerProvider } from "@starkfuture/provider-core/server/snapshot";
import type { ProviderInstance } from "@starkfuture/provider-core/server/driver";

export type ProviderSnapshotSource = {
  /** Owner identity rejects delayed publications from a replaced instance. */
  readonly instance: ProviderInstance;
  /**
   * Routing key — uniquely identifies this instance in the aggregated
   * snapshot list. Two different snapshot sources may share the same
   * driver kind (multiple instances of the same driver).
   */
  readonly instanceId: ProviderInstanceId;
  /** Driver implementation kind. */
  readonly driverKind: ProviderDriverKind;
  readonly getSnapshot: ManagedServerProvider["getSnapshot"];
  readonly refresh: ManagedServerProvider["refresh"];
  readonly streamChanges: Stream.Stream<ServerProvider>;
};
