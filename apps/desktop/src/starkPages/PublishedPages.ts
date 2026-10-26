import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type {
  StarkPublishedPagesStatus,
  StarkPublishedPagesOpenInput,
  StarkPublishedPageDocument,
  StarkPublishedPagesTool,
  StarkPublishedPagesReadInput,
  StarkPublishedPagesReadResult,
} from "@starkfuture/contracts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import { createPublishedPagesConnection } from "./publishedPagesConnection.ts";
import { encryptedPagesStore, keychainPagesStore } from "./publishedPagesStore.ts";
import { PublishedPagesFailure } from "./publishedPagesPolicy.ts";

export class PublishedPagesRequestError extends Schema.TaggedError<PublishedPagesRequestError>()(
  "PublishedPagesRequestError",
  {
    reason: Schema.Literals([
      "auth",
      "registration",
      "storage",
      "network",
      "invalid",
      "limit",
      "cancelled",
    ]),
  },
) {
  override get message() {
    return new PublishedPagesFailure(this.reason).message;
  }
}

export class PublishedPages extends Context.Service<
  PublishedPages,
  {
    readonly status: () => Effect.Effect<StarkPublishedPagesStatus, PublishedPagesRequestError>;
    readonly connect: () => Effect.Effect<StarkPublishedPagesStatus, PublishedPagesRequestError>;
    readonly disconnect: () => Effect.Effect<StarkPublishedPagesStatus, PublishedPagesRequestError>;
    readonly listTools: () => Effect.Effect<
      readonly StarkPublishedPagesTool[],
      PublishedPagesRequestError
    >;
    readonly openPage: (
      input: StarkPublishedPagesOpenInput,
    ) => Effect.Effect<StarkPublishedPageDocument, PublishedPagesRequestError>;
    readonly read: (
      input: StarkPublishedPagesReadInput,
    ) => Effect.Effect<StarkPublishedPagesReadResult, PublishedPagesRequestError>;
  }
>()("@starkfuture/desktop/starkPages/PublishedPages") {}

const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const storage = yield* ElectronSafeStorage.ElectronSafeStorage;
  const shell = yield* ElectronShell.ElectronShell;
  // These are the Promise callbacks required by the external MCP SDK's OAuth provider.
  const context = yield* Effect.context<never>();
  const runPromise = Effect.runPromiseWith(context);
  const connection = createPublishedPagesConnection({
    store:
      environment.platform === "darwin"
        ? keychainPagesStore({
            directory: environment.stateDir,
            createEntry: async (service, account) => {
              const Keyring = await import("@napi-rs/keyring");
              return new Keyring.AsyncEntry(service, account);
            },
          })
        : encryptedPagesStore({
            directory: environment.stateDir,
            available: () =>
              runPromise(
                Effect.gen(function* () {
                  if (!(yield* storage.isEncryptionAvailable)) return false;
                  const backend = yield* storage.selectedStorageBackend;
                  return (
                    environment.platform !== "linux" ||
                    (Option.isSome(backend) && backend.value !== "basic_text")
                  );
                }),
              ),
            encrypt: (value) => runPromise(storage.encryptString(value)),
            decrypt: (value) => runPromise(storage.decryptString(value)),
          }),
    openExternal: (url) => runPromise(shell.openExternal(url)),
  });
  yield* Effect.addFinalizer(() => Effect.promise(() => connection.dispose()));
  const request = <T>(operation: () => Promise<T>) =>
    Effect.tryPromise({
      try: operation,
      catch: (error) =>
        new PublishedPagesRequestError({
          reason: error instanceof PublishedPagesFailure ? error.reason : "network",
        }),
    });
  return PublishedPages.of({
    status: () => request(() => connection.status()),
    connect: () => request(() => connection.connect()),
    disconnect: () => request(() => connection.disconnect()),
    listTools: () => request(() => connection.listTools()),
    read: (input) => request(() => connection.read(input)),
    openPage: (input) => request(() => connection.openPage(input)),
  });
});

export const layer = Layer.effect(PublishedPages, make);
