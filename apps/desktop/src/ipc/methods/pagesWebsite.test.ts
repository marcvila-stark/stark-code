import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import type { PagesWebsiteSnapshot } from "@starkfuture/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as Website from "../../starkPages/PagesWebsite.ts";
import { getState, hide, navigate, setBounds } from "./pagesWebsite.ts";

vi.mock("electron", () => ({}));

function fixture(options: { url?: string; development?: boolean; windowAvailable?: boolean } = {}) {
  const mainFrame = { url: options.url ?? "starkcode://app/" };
  const window = { webContents: { id: 42, mainFrame } };
  const event = { sender: { id: 42 }, senderFrame: mainFrame };
  const controller = {
    getState: vi.fn(() => ({
      url: "https://pages.starkfuture.com/",
      title: "Stark Pages",
      loading: false,
      canGoBack: false,
      canGoForward: false,
      signInRequired: false,
    })),
    setBounds: vi.fn(async (): Promise<PagesWebsiteSnapshot | null> => null),
    hide: vi.fn(),
    navigate: vi.fn(),
    dispose: vi.fn(),
  };
  const run = <A, E, R>(operation: Effect.Effect<A, E, R>) =>
    operation.pipe(
      Effect.provideService(ElectronWindow.ElectronWindow, {
        currentMainOrFirst: Effect.succeed(
          options.windowAvailable === false ? Option.none() : Option.some(window),
        ),
      } as never),
      Effect.provideService(DesktopEnvironment.DesktopEnvironment, {
        isDevelopment: options.development ?? false,
        devServerUrl: Option.some(new URL("http://localhost:5173")),
      } as never),
      Effect.provideService(Website.PagesWebsite, controller),
    );
  return { mainFrame, window, event, controller, run };
}
const bounds = { viewId: "view-one", x: 30, y: 80, width: 700, height: 600, visible: true };

describe("Pages website IPC trust boundary", () => {
  it.effect(
    "allows desktop main-frame controls and never accepts a renderer-selected target window",
    () =>
      Effect.gen(function* () {
        const f = fixture();
        yield* f.run(setBounds.handler(bounds, f.event));
        expect(f.controller.setBounds).toHaveBeenCalledExactlyOnceWith(f.window, bounds);
        yield* f.run(navigate.handler({ viewId: "view-one", action: "reload" }, f.event));
        expect(f.controller.navigate).toHaveBeenCalledExactlyOnceWith({
          viewId: "view-one",
          action: "reload",
        });
        yield* f.run(hide.handler("view-one", f.event));
        expect(f.controller.hide).toHaveBeenCalledExactlyOnceWith("view-one");
        expect(yield* f.run(getState.handler(undefined, f.event))).toMatchObject({
          title: "Stark Pages",
        });
      }),
  );

  it.effect(
    "rejects missing senders, other windows and same-URL child frames for every method",
    () =>
      Effect.gen(function* () {
        const f = fixture();
        for (const event of [
          undefined,
          { sender: { id: 43 }, senderFrame: f.mainFrame },
          { sender: { id: 42 }, senderFrame: { url: "starkcode://app/" } },
          { sender: { id: 42 } },
        ]) {
          for (const operation of [
            getState.handler(undefined, event as never),
            setBounds.handler(bounds, event as never),
            hide.handler("view-one", event as never),
            navigate.handler({ viewId: "view-one", action: "reload" }, event as never),
          ])
            expect(Exit.isFailure(yield* Effect.exit(f.run(operation)))).toBe(true);
        }
        expect(f.controller.getState).not.toHaveBeenCalled();
        expect(f.controller.setBounds).not.toHaveBeenCalled();
        expect(f.controller.hide).not.toHaveBeenCalled();
        expect(f.controller.navigate).not.toHaveBeenCalled();
      }),
  );

  it.effect(
    "rejects foreign main-frame origins and admits only the configured dev origin in development",
    () =>
      Effect.gen(function* () {
        for (const options of [
          { url: "https://pages.starkfuture.com/" },
          { url: "starkcode://other/" },
          { url: "starkcode://user:pass@app/" },
          { url: "http://localhost:5173/" },
          { url: "http://localhost:5174/", development: true },
          { windowAvailable: false },
        ]) {
          const f = fixture(options);
          expect(
            Exit.isFailure(yield* Effect.exit(f.run(getState.handler(undefined, f.event)))),
          ).toBe(true);
          expect(f.controller.getState).not.toHaveBeenCalled();
        }
        const dev = fixture({ url: "http://localhost:5173/chat", development: true });
        expect(yield* dev.run(getState.handler(undefined, dev.event))).toMatchObject({
          title: "Stark Pages",
        });
      }),
  );

  it.effect(
    "rejects non-finite or oversized geometry and unsupported actions before changing native contents",
    () =>
      Effect.gen(function* () {
        const f = fixture();
        const invalid = [
          { ...bounds, environmentId: "" },
          { ...bounds, environmentId: "x".repeat(257) },
          { ...bounds, x: NaN },
          { ...bounds, y: Infinity },
          { ...bounds, width: 50_001 },
          { ...bounds, height: -50_001 },
          { ...bounds, viewId: "" },
          { ...bounds, viewId: "x".repeat(129) },
          { ...bounds, visible: "yes" },
          { ...bounds, captureSnapshot: "yes" },
        ];
        for (const input of invalid)
          expect(Exit.isFailure(yield* Effect.exit(f.run(setBounds.handler(input, f.event))))).toBe(
            true,
          );
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              f.run(navigate.handler({ viewId: "view-one", action: "evaluate" }, f.event)),
            ),
          ),
        ).toBe(true);
        expect(f.controller.setBounds).not.toHaveBeenCalled();
        expect(f.controller.navigate).not.toHaveBeenCalled();
      }),
  );

  it.effect("awaits session acquisition and reports failures without leaking details", () =>
    Effect.gen(function* () {
      const f = fixture();
      f.controller.setBounds.mockRejectedValueOnce(new Error("private session detail"));
      const result = yield* Effect.exit(
        f.run(setBounds.handler({ ...bounds, environmentId: "local-env" }, f.event)),
      );
      expect(Exit.isFailure(result)).toBe(true);
      expect(JSON.stringify(result)).not.toContain("private session detail");
      expect(f.controller.setBounds).toHaveBeenCalledExactlyOnceWith(f.window, {
        ...bounds,
        environmentId: "local-env",
      });
    }),
  );

  it.effect("returns a bounded PNG backdrop only to the authorized main frame", () =>
    Effect.gen(function* () {
      const f = fixture();
      const image = { viewId: bounds.viewId, dataUrl: "data:image/png;base64,aGVsbG8=" };
      f.controller.setBounds.mockResolvedValue(image);
      expect(
        yield* f.run(
          setBounds.handler({ ...bounds, visible: false, captureSnapshot: true }, f.event),
        ),
      ).toEqual(image);
      f.controller.setBounds.mockResolvedValue({
        ...image,
        dataUrl: "https://external.test/image.png",
      });
      expect(Exit.isFailure(yield* Effect.exit(f.run(setBounds.handler(bounds, f.event))))).toBe(
        true,
      );
    }),
  );
});
