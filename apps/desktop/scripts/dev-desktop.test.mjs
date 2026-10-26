import * as NodeEvents from "node:events";
import { describe, expect, it } from "vite-plus/test";
import { superviseDesktopDevelopment } from "./dev-desktop.mjs";

function fixture() {
  const commands = [];
  const children = [];
  const supervisor = superviseDesktopDevelopment({
    cwd: "/repo/apps/desktop",
    env: {},
    spawnProcess: (command, args) => {
      commands.push([command, args]);
      const child = new NodeEvents.EventEmitter();
      child.signals = [];
      child.kill = (signal) => {
        child.signals.push(signal);
        return true;
      };
      children.push(child);
      return child;
    },
  });
  return { supervisor, commands, children };
}

describe("desktop development process ownership", () => {
  it("launches Electron only after all native bundles have been written", async () => {
    const { supervisor, commands, children } = fixture();
    expect(commands).toHaveLength(1);
    expect(commands[0][1]).toEqual(["pack"]);
    children[0].emit("close", 0);
    expect(commands[1][1]).toEqual(["scripts/dev-electron.mjs"]);
    supervisor.stop();
    expect(children[1].signals).toEqual(["SIGTERM"]);
    children[1].emit("close", 0);
    expect(await supervisor.completion).toBe(0);
  });
  it("does not launch an incomplete application after a compiler failure", async () => {
    const { supervisor, commands, children } = fixture();
    children[0].emit("close", 1);
    expect(commands).toHaveLength(1);
    expect(await supervisor.completion).toBe(1);
  });
});
