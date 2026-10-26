import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import { prepareStarkWorkbench } from "../../../scripts/prepare-stark-workbench.mjs";
import { buildDictation } from "./build-dictation.mjs";

import { desktopDir, resolveElectronLaunchCommand } from "./electron-launcher.mjs";

prepareStarkWorkbench();
buildDictation();

NodeChildProcess.execFileSync(
  process.execPath,
  [NodePath.join(desktopDir, "scripts/build-browser-secret.mjs")],
  { stdio: "inherit" },
);

const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;

const electronCommand = resolveElectronLaunchCommand(["dist-electron/main.cjs"]);
const child = NodeChildProcess.spawn(electronCommand.electronPath, electronCommand.args, {
  stdio: "inherit",
  cwd: desktopDir,
  env: childEnv,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
