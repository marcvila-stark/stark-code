import * as ClientTracer from "./clientTracer";

export interface ClientTracingConfig {
  readonly exportIntervalMs?: number;
}

/** Client operations may be traced locally, but this app installs no exporter. */
export function configureClientTracing(_config: ClientTracingConfig = {}): Promise<void> {
  ClientTracer.setDelegate(null);
  return Promise.resolve();
}
