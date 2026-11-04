import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as PublishedPages from "../../starkPages/PublishedPages.ts";
import { connect, openPage, read, status } from "./publishedPages.ts";

// These tests provide the Electron services; importing the package must not download a runtime.
vi.mock("electron", () => ({}));

describe("Published Pages IPC sender", () => {
  const mainFrame = { url: "starkcode://app/" };
  const window = { webContents: { id: 42, mainFrame } };
  const run = (
    event: unknown,
    operation = connect.handler(undefined, event as never),
    isDevelopment = false,
  ) =>
    operation.pipe(
      Effect.provideService(ElectronWindow.ElectronWindow, {
        currentMainOrFirst: Effect.succeedSome(window),
      } as never),
      Effect.provideService(DesktopEnvironment.DesktopEnvironment, {
        isDevelopment,
        devServerUrl: isDevelopment
          ? Option.some(new URL("http://127.0.0.1:4317/"))
          : Option.none(),
      } as never),
      Effect.provideService(PublishedPages.PublishedPages, {
        status: () => Effect.succeed({ state: "signed-out", message: null }),
        connect: () => Effect.succeed({ state: "connecting", message: null }),
        disconnect: () => Effect.succeed({ state: "signed-out", message: null }),
        listTools: () => Effect.succeed([]),
        read: () => Effect.succeed({ content: [], isError: false }),
        openPage: () =>
          Effect.succeed({
            root: "test",
            path: "index.html",
            source: "<p>Page</p>",
            mimeType: "text/html",
            assets: [],
            warnings: [],
            publicUrl: null,
          }),
      }),
    );

  it.effect(
    "allows the trusted main frame and rejects iframe, guest and missing sender events",
    () =>
      Effect.gen(function* () {
        expect(yield* run({ sender: { id: 42 }, senderFrame: mainFrame })).toEqual({
          state: "connecting",
          message: null,
        });
        for (const event of [
          undefined,
          { sender: { id: 43 }, senderFrame: mainFrame },
          { sender: { id: 42 }, senderFrame: { url: "starkcode://app/" } },
          { sender: { id: 42 }, senderFrame: { url: "http://127.0.0.1:4317/panel" } },
        ]) {
          expect(Exit.isFailure(yield* Effect.exit(run(event)))).toBe(true);
          expect(
            Exit.isFailure(
              yield* Effect.exit(
                run(event, openPage.handler({ root: "test", path: "index.html" }, event as never)),
              ),
            ),
          ).toBe(true);
        }
      }),
  );

  it.effect("serves Pages status only from the actual renderer scheme for its environment", () =>
    Effect.gen(function* () {
      const trusted = { sender: { id: 42 }, senderFrame: mainFrame };
      const statusFor = (isDevelopment: boolean, event: unknown) =>
        run(event, status.handler(undefined, event as never), isDevelopment);
      // Development runs first: the live renderer is starkcode-dev://app/#/... there.
      for (const isDevelopment of [true, false]) {
        const scheme = isDevelopment ? "starkcode-dev" : "starkcode";
        mainFrame.url = `${scheme}://app/#/pages`;
        expect(yield* statusFor(isDevelopment, trusted)).toEqual({
          state: "signed-out",
          message: null,
        });
        for (const url of [
          `${isDevelopment ? "starkcode" : "starkcode-dev"}://app/#/pages`,
          "http://127.0.0.1:4317/",
          "https://example.com/",
          "starkcode-other://app/",
          `${scheme}://other/`,
          `${scheme}://app:4317/`,
          `${scheme}://name@app/`,
          `${scheme}://name:secret@app/`,
        ]) {
          mainFrame.url = url;
          const exit = yield* Effect.exit(statusFor(isDevelopment, trusted));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({
              _tag: "PublishedPagesRequestError",
              reason: "invalid",
            });
          }
        }
        mainFrame.url = `${scheme}://app/#/pages`;
        for (const event of [
          undefined,
          { sender: { id: 43 }, senderFrame: mainFrame },
          { sender: { id: 42 }, senderFrame: { url: `${scheme}://app/#/pages` } },
        ]) {
          expect(Exit.isFailure(yield* Effect.exit(statusFor(isDevelopment, event)))).toBe(true);
        }
      }
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          mainFrame.url = "starkcode://app/";
        }),
      ),
    ),
  );

  it.effect("rejects unlisted tool names at the IPC schema before the service runs", () =>
    Effect.gen(function* () {
      const event = { sender: { id: 42 }, senderFrame: mainFrame };
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            run(event, read.handler({ tool: "pages_upload_begin", arguments: {} }, event as never)),
          ),
        ),
      ).toBe(true);
    }),
  );
});
