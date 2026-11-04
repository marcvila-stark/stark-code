import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
const root = import.meta.dirname;
const output = NodePath.join(root, "dist");
const manifest = JSON.parse(await NodeFSP.readFile(NodePath.join(root, "manifest.json"), "utf8"));
if (manifest.host_permissions?.length || manifest.permissions.includes("<all_urls>"))
  throw new Error("The capture extension must not ask for all-sites access.");
await NodeFSP.rm(output, { recursive: true, force: true });
await NodeFSP.mkdir(output, { recursive: true });
await NodeFSP.cp(NodePath.join(root, "src"), output, { recursive: true });
await NodeFSP.copyFile(
  NodePath.join(root, "manifest.json"),
  NodePath.join(output, "manifest.json"),
);
await NodeFSP.copyFile(
  NodePath.join(root, "../../assets/prod/stark-black-web-favicon-32x32.png"),
  NodePath.join(output, "icon.png"),
);
const digest = NodeCrypto.createHash("sha256")
  .update(Buffer.from(manifest.key, "base64"))
  .digest("hex")
  .slice(0, 32);
const id = digest.replace(/[0-9a-f]/g, (digit) =>
  String.fromCharCode(97 + Number.parseInt(digit, 16)),
);
await NodeFSP.writeFile(NodePath.join(output, "extension-id.txt"), id + "\n");
console.log(`Chrome capture built at ${output}\nExtension ID: ${id}`);
