// @effect-diagnostics nodeBuiltinImport:off
// This standalone Python fixture exercises the shipped subprocess program without live services.
import * as NodeChildProcess from "node:child_process";
import { describe, expect, it } from "@effect/vitest";
import {
  CLAUDE_ACCOUNT_IDENTITY_SCRIPT,
  claudeSwapPythonInterpreter,
} from "./ClaudeAccountIdentity.ts";

it("uses cswap's installed interpreter without guessing a different Python environment", () => {
  expect(claudeSwapPythonInterpreter("#!/opt/cswap/bin/python\nimport sys")).toBe(
    "/opt/cswap/bin/python",
  );
  expect(claudeSwapPythonInterpreter("#!/opt/My Tools/bin/python3.12\r\n")).toBe(
    "/opt/My Tools/bin/python3.12",
  );
  for (const launcher of [
    "#!/bin/sh\n",
    "#!/usr/bin/env python3\n",
    "#!/usr/bin/python -O\n",
    "binary",
    "",
  ]) {
    expect(claudeSwapPythonInterpreter(launcher)).toBeNull();
  }
});

// Execute the shipped helper against synthetic storage only; the real cswap modules,
// Keychain, files, network and account settings are never imported or accessed.
const fakeStorage = String.raw`
import json, sys, types, hashlib
fixture = json.loads(sys.argv[2])
profile_requests = 0
urllib = types.ModuleType("urllib")
urllib.request = types.ModuleType("urllib.request")
sys.modules["urllib"] = urllib
sys.modules["urllib.request"] = urllib.request
class FakeRequest:
    def __init__(self, url, headers, method): self.full_url, self.headers, self.method = url, headers, method
    def get_method(self): return self.method
    def get_header(self, name): return next((v for k, v in self.headers.items() if k.lower() == name.lower()), None)
urllib.request.HTTPRedirectHandler = type("HTTPRedirectHandler", (), {})
urllib.request.Request = FakeRequest
class FakeResponse:
    status = fixture.get("profile_status", 200)
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def read(self, limit):
        assert limit == 65_537
        if fixture.get("profile_too_large"): return b"x" * limit
        if fixture.get("profile_invalid_json"): return b"not json"
        return json.dumps(fixture.get("profile")).encode()
class FakeOpener:
    def open(self, request, timeout):
        global profile_requests
        profile_requests += 1
        assert timeout == 5
        assert request.full_url == "https://api.anthropic.com/api/oauth/profile"
        assert request.get_method() == "GET"
        assert request.get_header("User-agent") == "Stark-Code/1.0"
        if fixture.get("profile_failure"): raise OSError("fixture failure")
        return FakeResponse()
def fake_opener(handler):
    assert handler.redirect_request(None, None, 302, "redirect", {}, "https://elsewhere.test") is None
    return FakeOpener()
urllib.request.build_opener = fake_opener
class FakePath:
    reads = 0
    def __truediv__(self, segment): return self
    def read_text(self, encoding):
        FakePath.reads += 1
        accounts = json.loads(sys.argv[1])
        if fixture.get("roster_changed") and FakePath.reads > 1:
            accounts[1]["organizationUuid"] = "replaced-org"
        return json.dumps({"accounts": {str(account["number"]): account for account in accounts}})
for name in ("claude_swap", "claude_swap.credentials", "claude_swap.models", "claude_swap.oauth", "claude_swap.paths"):
    sys.modules[name] = types.ModuleType(name)
class Store:
    def __init__(self, host): self.reads = 0
    def _read_active_credentials(self):
        self.reads += 1
        key = "after" if self.reads > 1 and "after" in fixture else "live"
        return types.SimpleNamespace(value=fixture.get(key), keychain_unavailable=fixture.get("locked", False), degraded=fixture.get("degraded", False))
    def _read_account_credentials_ex(self, number, email):
        return (fixture.get("backups", {}).get(number, ""), number in fixture.get("unreadable", []))
sys.modules["claude_swap.credentials"].CredentialStore = Store
sys.modules["claude_swap.models"].Platform = types.SimpleNamespace(detect=lambda: "fixture")
sys.modules["claude_swap.paths"].get_backup_root = lambda: FakePath()
sys.modules["claude_swap.oauth"].credential_fingerprint = lambda value: hashlib.sha256(value.encode()).hexdigest() if value else None
sys.modules["claude_swap.oauth"].extract_oauth_data = lambda value: None if fixture.get("oauth_missing") else {"accessToken": value}
`;
const accounts = [
  { number: 1, email: "same@example.test", organizationUuid: "org-one" },
  { number: 2, email: "same@example.test", organizationUuid: "org-two" },
];
const pythonAvailable = NodeChildProcess.spawnSync("python3", ["--version"]).status === 0;
describe.skipIf(!pythonAvailable)("read-only credential identity helper", () => {
  function identify(fixture: Record<string, unknown>, roster = accounts) {
    const result = NodeChildProcess.spawnSync(
      "python3",
      [
        "-I",
        "-c",
        fakeStorage + CLAUDE_ACCOUNT_IDENTITY_SCRIPT + "\nprint(json.dumps(profile_requests))",
        JSON.stringify(roster),
        JSON.stringify(fixture),
      ],
      { encoding: "utf8", timeout: 5000 },
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain("private-token");
    expect(result.stdout).not.toContain("sha256");
    const lines = result.stdout.trim().split("\n");
    expect(JSON.parse(lines[1]!)).toBe(fixture.expected_requests ?? 0);
    return JSON.parse(lines[0]!);
  }
  it("matches one credential, not the shared email or saved active label", () => {
    expect(
      identify({
        live: "private-token-two",
        backups: { 1: "private-token-one", 2: "private-token-two" },
      }),
    ).toEqual({ schemaVersion: 1, identity: accounts[1] });
  });
  it("does not assign an organization when credentials are ambiguous, unavailable, or change mid-read", () => {
    const base = {
      live: "private-token-two",
      backups: { 1: "private-token-one", 2: "private-token-two" },
    };
    for (const fixture of [
      { ...base, backups: { 1: "private-token-two", 2: "private-token-two" } },
      { ...base, after: "private-token-one" },
      { ...base, live: "unknown-private-token", expected_requests: 1 },
      { ...base, locked: true },
      { ...base, degraded: true },
      { ...base, unreadable: ["1"] },
      { ...base, roster_changed: true },
    ])
      expect(identify(fixture)).toEqual({ schemaVersion: 1, identity: null });
  });
  it("recovers a rotated token only from a unique authenticated email and organization", () => {
    const fixture = {
      live: "rotated-private-token",
      backups: { 1: "private-token-one", 2: "private-token-two" },
      profile: {
        account: { uuid: "person-id", email: "same@example.test" },
        organization: { uuid: "org-two" },
      },
      expected_requests: 1,
    };
    expect(identify(fixture)).toEqual({ schemaVersion: 1, identity: accounts[1] });
    expect(identify(fixture, [...accounts, { ...accounts[1]!, number: 3 }])).toEqual({
      schemaVersion: 1,
      identity: null,
    });
    for (const patch of [
      { profile_status: 401 },
      { profile_status: 302 },
      { profile_failure: true },
      { profile_too_large: true },
      { profile_invalid_json: true },
      { profile: { account: { email: "same@example.test" }, organization: { uuid: "org-two" } } },
      {
        profile: {
          account: { uuid: "person-id", email: "different@example.test" },
          organization: { uuid: "org-two" },
        },
      },
      {
        profile: {
          account: { uuid: "person-id", email: "same@example.test" },
          organization: { uuid: "other-org" },
        },
      },
      { after: "another-private-token" },
      { roster_changed: true },
    ])
      expect(identify({ ...fixture, ...patch })).toEqual({ schemaVersion: 1, identity: null });
  });
});
