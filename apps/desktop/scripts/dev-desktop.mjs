import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import * as NodePath from "node:path";

// oxlint-disable-next-line starkcode/no-global-process-runtime -- Standalone launcher has no Effect runtime.
const hostPlatform = process.platform;

/** Build native bundles before launch; Vite independently keeps the web UI live. */
export function superviseDesktopDevelopment({ spawnProcess = NodeChildProcess.spawn, cwd, env }) {
  const live = new Set();
  let stopping = false;
  let result = 0;
  let escalation;
  let finish;
  const completion = new Promise((resolve) => {
    finish = resolve;
  });
  const settle = () => {
    if (stopping && live.size === 0) {
      clearTimeout(escalation);
      finish(result);
    }
  };
  const stop = (exitCode = 0) => {
    if (stopping) return;
    stopping = true;
    result = exitCode;
    for (const child of live) child.kill("SIGTERM");
    escalation = setTimeout(() => {
      for (const child of live) child.kill("SIGKILL");
    }, 5_000);
    escalation.unref();
    settle();
  };
  const start = (command, args, onSuccess) => {
    const child = spawnProcess(command, args, {
      cwd,
      env,
      stdio: "inherit",
      shell: hostPlatform === "win32" && command.endsWith(".cmd"),
    });
    live.add(child);
    child.once("error", (error) => {
      console.error(error.message);
      stop(1);
    });
    child.once("close", (code) => {
      live.delete(child);
      if (!stopping && code === 0 && onSuccess) onSuccess();
      else if (!stopping) stop(code ?? 1);
      settle();
    });
    return child;
  };
  start(hostPlatform === "win32" ? "vp.cmd" : "vp", ["pack"], () =>
    start(process.execPath, ["scripts/dev-electron.mjs"]),
  );
  return { stop, completion };
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  const cwd = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
  const supervisor = superviseDesktopDevelopment({ cwd, env: process.env });
  const stop = () => supervisor.stop(0);
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.exitCode = await supervisor.completion;
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
}
