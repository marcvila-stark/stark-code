import * as Effect from "effect/Effect";

/**
 * Server-requested desktop installs stay off: an update restart needs the
 * explicit choice of someone at this Mac, after its own preconditions pass.
 * The server reports desktop updates as unavailable, so it never asks.
 */
export const listen = Effect.void;
