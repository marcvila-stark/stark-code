import { it } from "@effect/vitest";
import * as DesktopRemoteUpdates from "./DesktopRemoteUpdates.ts";
it.effect("does not subscribe to remote update requests", () => DesktopRemoteUpdates.listen);
