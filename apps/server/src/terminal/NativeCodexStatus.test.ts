import { expect, it } from "vite-plus/test";
import { NativeCodexStatusParser } from "./NativeCodexStatus.ts";

const osc = (payload: string, end = "\x1b\\") => `\x1b]7501;${payload}${end}`;

it("decodes native status with BEL or ST at every possible chunk boundary", () => {
  for (const end of ["\x07", "\x1b\\"]) {
    const input =
      `ordinary output${osc("state=working:app=codex", end)}` +
      osc("state=blocked:app=codex:kind=question", end) +
      osc("state=clear", end);
    const expected = [
      { state: "working" },
      { state: "blocked", kind: "question" },
      { state: "clear" },
    ];
    for (let split = 0; split <= input.length; split++) {
      const parser = new NativeCodexStatusParser();
      expect([...parser.push(input.slice(0, split)), ...parser.push(input.slice(split))]).toEqual(
        expected,
      );
    }
    const parser = new NativeCodexStatusParser();
    expect([...input].flatMap((char) => parser.push(char))).toEqual(expected);
  }
});

it("keeps older Codex blocked status generic and recognizes only explicit newer kinds", () => {
  const parser = new NativeCodexStatusParser();
  expect(parser.push(osc("state=blocked:app=codex"))).toEqual([{ state: "blocked" }]);
  for (const kind of ["permission", "question", "auth"]) {
    expect(parser.push(osc(`state=blocked:app=codex:kind=${kind}`))).toEqual([
      { state: "blocked", kind },
    ]);
  }
  for (const state of ["idle", "working", "done", "error"]) {
    expect(parser.push(osc(`state=${state}:app=codex`))).toEqual([{ state }]);
  }
});

it("rejects terminal prose, other applications, malformed or duplicate fields, and oversized payloads", () => {
  const parser = new NativeCodexStatusParser();
  const invalid = [
    "state=blocked",
    "state=blocked:app=claude",
    "state=blocked:app=codex:app=codex",
    "state=blocked:app=codex:kind=permission:kind=auth",
    "state=blocked:app=codex:kind=unrecognized",
    "state=idle:app=codex:kind=permission",
    "state=blocked:app=codex:secret=not-retained",
    "state=clear:app=codex",
    "state=blocked:app=codex\n",
    `state=blocked:app=codex${" ".repeat(10_000)}`,
  ];
  expect(
    parser.push(
      "needs approval 7501;state=blocked:app=codex" +
        "\x1b]9;state=blocked:app=codex\x07" +
        invalid.map((payload) => osc(payload)).join(""),
    ),
  ).toEqual([]);
  expect(parser.push(osc("state=idle:app=codex"))).toEqual([{ state: "idle" }]);
});

it("recovers from abandoned sequences without interpreting their payload as status", () => {
  const parser = new NativeCodexStatusParser();
  expect(parser.push("\x1b]unclosed\x1b[31mno approval")).toEqual([]);
  expect(parser.push(`\x1b]${"x".repeat(300)}${osc("state=blocked:app=codex")}`)).toEqual([
    { state: "blocked" },
  ]);
});
