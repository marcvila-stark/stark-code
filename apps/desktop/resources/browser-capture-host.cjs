/* Chrome Native Messaging host. stdout contains framed JSON only. No provider credentials. */
"use strict";
const fs = require("node:fs");
const net = require("node:net");
const childProcess = require("node:child_process");
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024 - 4;
const MAX_QUEUED_MESSAGES = 24;
const decoder = new TextDecoder("utf-8", { fatal: true });
let config;
let stopped = false;
function reply(value, done) {
  let bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > MAX_RESPONSE_BYTES)
    bytes = Buffer.from(
      JSON.stringify({ ok: false, error: "Response exceeds the native message limit." }),
    );
  const header = Buffer.alloc(4);
  header.writeUInt32LE(bytes.length);
  process.stdout.write(Buffer.concat([header, bytes]), done);
}
function fail(message) {
  if (stopped) return;
  stopped = true;
  process.stdin.pause();
  reply({ ok: false, error: message }, () => process.exit(1));
}
try {
  config = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  if (
    process.argv[3] !== config.origin ||
    !/^chrome-extension:\/\/[a-p]{32}\/$/.test(config.origin) ||
    typeof config.socket !== "string" ||
    !/^[a-f0-9]{64}$/.test(config.capability)
  )
    throw new Error("Origin rejected");
} catch {
  fail("This Chrome extension is not connected to this Stark profile.");
}
function request(message) {
  return new Promise((resolve) => {
    const socket = net.createConnection(config.socket);
    let data = Buffer.alloc(0),
      settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(10_000, () =>
      finish({ ok: false, error: "Stark did not respond. Your capture is still pending." }),
    );
    socket.once("connect", () =>
      socket.end(JSON.stringify({ capability: config.capability, message }) + "\n"),
    );
    socket.on("data", (chunk) => {
      data = Buffer.concat([data, chunk]);
      if (data.length > MAX_RESPONSE_BYTES)
        return finish({ ok: false, error: "Invalid Stark response." });
      const newline = data.indexOf(10);
      if (newline >= 0) {
        try {
          finish(JSON.parse(decoder.decode(data.subarray(0, newline))));
        } catch {
          finish({ ok: false, error: "Invalid Stark response." });
        }
      }
    });
    socket.once("error", () => {
      if (message?.method === "open" && typeof config.appExecutable === "string") {
        const environment = { ...process.env };
        delete environment.ELECTRON_RUN_AS_NODE;
        const app = childProcess.spawn(config.appExecutable, [], {
          detached: true,
          stdio: "ignore",
          env: environment,
        });
        app.once("error", () =>
          finish({
            ok: false,
            error: "The connected Stark app could not be opened. Open it manually, then retry.",
          }),
        );
        app.once("spawn", () => {
          app.unref();
          finish({ ok: true, result: { opened: true } });
        });
        return;
      }
      finish({
        ok: false,
        error: "Stark is closed. Open it, then retry. Your capture stays in Chrome.",
      });
    });
    socket.once("end", () =>
      finish({ ok: false, error: "Stark disconnected. Your capture stays in Chrome." }),
    );
  });
}
let incoming = Buffer.alloc(0),
  serial = Promise.resolve(),
  queued = 0;
process.stdin.on("data", (chunk) => {
  if (stopped) return;
  incoming = Buffer.concat([incoming, chunk]);
  while (incoming.length >= 4) {
    const size = incoming.readUInt32LE(0);
    if (size === 0 || size > MAX_BYTES) return fail("Capture exceeds the size limit.");
    if (incoming.length < size + 4) return;
    if (queued >= MAX_QUEUED_MESSAGES) return fail("Too many pending capture requests.");
    const message = incoming.subarray(4, size + 4);
    incoming = incoming.subarray(size + 4);
    queued++;
    serial = serial.then(async () => {
      try {
        if (!stopped) reply(await request(JSON.parse(decoder.decode(message))));
      } catch {
        if (!stopped) reply({ ok: false, error: "Invalid browser capture request." });
      } finally {
        queued--;
      }
    });
  }
});
process.stdin.on("end", () => {
  void serial.then(() => {
    if (!stopped && incoming.length) fail("Incomplete native message.");
  });
});
