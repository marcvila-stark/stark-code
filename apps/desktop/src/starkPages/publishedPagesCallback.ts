// OAuth redirects are received only on an ephemeral loopback socket owned by this flow.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import * as NodeCrypto from "node:crypto";
import { PublishedPagesFailure } from "./publishedPagesPolicy.ts";

export async function pagesOAuthCallback(state: string, signal: AbortSignal) {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(5 * 60_000)]);
  let settle: (code: string) => void = () => undefined;
  let fail: (error: Error) => void = () => undefined;
  const code = new Promise<string>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  // Cancellation can precede the caller awaiting the browser callback.
  void code.catch(() => undefined);
  let callbackUrl = "";
  let finished = false;
  const server = NodeHttp.createServer((request, response) => {
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    let url: URL;
    try {
      url = new URL(request.url ?? "/", callbackUrl);
    } catch {
      response.writeHead(400).end("Invalid callback address.");
      return;
    }
    const states = url.searchParams.getAll("state");
    const codes = url.searchParams.getAll("code");
    const stateBytes = Buffer.from(states[0] ?? "");
    if (
      finished ||
      request.method !== "GET" ||
      request.headers.host !== new URL(callbackUrl).host ||
      url.origin !== new URL(callbackUrl).origin ||
      url.pathname !== "/stark-pages/callback" ||
      url.hash ||
      url.username ||
      url.password ||
      states.length !== 1 ||
      stateBytes.length !== Buffer.byteLength(state) ||
      !NodeCrypto.timingSafeEqual(stateBytes, Buffer.from(state))
    ) {
      response.writeHead(400).end("This callback does not match the pending Stark Pages sign-in.");
      return;
    }
    if (
      url.searchParams.getAll("error").length > 1 ||
      (url.searchParams.has("error") && codes.length)
    ) {
      response.writeHead(400).end("Invalid callback parameters.");
      return;
    }
    if (url.searchParams.has("error")) {
      finished = true;
      response
        .writeHead(400)
        .end("Stark Pages sign-in was declined. You can return to Stark Code.");
      fail(new PublishedPagesFailure("auth"));
      close();
      return;
    }
    if (codes.length !== 1 || !codes[0] || codes[0].length > 4096) {
      response.writeHead(400).end("The sign-in callback is incomplete.");
      return;
    }
    finished = true;
    response.writeHead(200).end("Stark Pages sign-in received. You can return to Stark Code.");
    settle(codes[0]);
    close();
  });
  server.maxHeadersCount = 32;
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  const abort = () => {
    finished = true;
    fail(new PublishedPagesFailure(signal.aborted ? "cancelled" : "auth"));
    close();
  };
  const close = () => {
    deadline.removeEventListener("abort", abort);
    server.close();
    server.closeIdleConnections();
  };
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  }).catch((error) => {
    close();
    throw error;
  });
  server.on("error", () => {
    fail(new PublishedPagesFailure("network"));
    close();
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    close();
    throw new PublishedPagesFailure("network");
  }
  callbackUrl = `http://127.0.0.1:${address.port}/stark-pages/callback`;
  deadline.addEventListener("abort", abort, { once: true });
  if (deadline.aborted) abort();
  return { url: callbackUrl, code, close };
}
