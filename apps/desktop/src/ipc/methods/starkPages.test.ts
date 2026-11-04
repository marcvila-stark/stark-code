import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as StarkPages from "../../starkPages/StarkPages.ts";
import { listPages } from "./starkPages.ts";

vi.mock("electron", () => ({}));

function fixture(url = "starkcode://app/", development = false) {
  const mainFrame = { url };
  const window = { webContents: { id: 42, mainFrame } };
  const event = { sender: { id: 42 }, senderFrame: mainFrame };
  const list = vi.fn(() => Effect.succeed([]));
  const run = <A, E, R>(operation: Effect.Effect<A, E, R>) =>
    operation.pipe(
      Effect.provideService(ElectronWindow.ElectronWindow, {
        currentMainOrFirst: Effect.succeed(Option.some(window)),
      } as never),
      Effect.provideService(DesktopEnvironment.DesktopEnvironment, {
        isDevelopment: development,
        devServerUrl: Option.some(new URL("http://localhost:5173")),
      } as never),
      Effect.provideService(StarkPages.StarkPages, { listPages: list } as never),
    );
  return { event, mainFrame, list, run };
}

it.effect("only the trusted main frame may read local document metadata", () =>
  Effect.gen(function* () {
    const f = fixture();
    expect(yield* f.run(listPages.handler("/project", f.event))).toEqual([]);
    expect(f.list).toHaveBeenCalledExactlyOnceWith("/project");
    f.list.mockClear();
    for (const event of [
      undefined,
      { sender: { id: 43 }, senderFrame: f.mainFrame },
      { sender: { id: 42 }, senderFrame: { url: "starkcode://app/" } },
      { sender: { id: 42 } },
    ])
      expect(yield* f.run(listPages.handler("/project", event as never))).toBeNull();
    expect(f.list).not.toHaveBeenCalled();
  }),
);

it.effect("rejects remote origins and accepts only this build's app scheme", () =>
  Effect.gen(function* () {
    // The main window loads starkcode-dev://app in development, never the dev server origin.
    for (const [url, dev, allowed] of [
      ["https://pages.starkfuture.com/", false, false],
      ["starkcode://other/", false, false],
      ["starkcode://user:pass@app/", false, false],
      ["starkcode://app:4317/", false, false],
      ["starkcode-dev://app/", false, false],
      ["http://localhost:5173/", false, false],
      ["http://localhost:5173/", true, false],
      ["starkcode://app/", true, false],
      ["starkcode-dev://app/", true, true],
    ] as const) {
      const f = fixture(url, dev);
      expect(yield* f.run(listPages.handler("/project", f.event))).toEqual(allowed ? [] : null);
      expect(f.list).toHaveBeenCalledTimes(allowed ? 1 : 0);
    }
  }),
);
