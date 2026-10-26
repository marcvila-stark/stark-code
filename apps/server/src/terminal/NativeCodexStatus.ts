export interface NativeCodexStatus {
  readonly state: "idle" | "working" | "blocked" | "done" | "error" | "clear";
  readonly kind?: "permission" | "question" | "auth";
}

/**
 * Codex's OSC 7501 lifecycle protocol, not text matching. Older CLIs omit
 * blocked.kind. Keep that state generic instead of inventing an approval.
 *
 * This is an unauthenticated terminal hint: it may only open the native UI,
 * never authorize work or resolve an approval. Feed only live managed Codex
 * output, with a fresh parser for each process; never replay saved history.
 */
export class NativeCodexStatusParser {
  private mode: "text" | "escape" | "osc" | "osc-escape" = "text";
  private payload = "";
  private overflow = false;

  push(chunk: string): NativeCodexStatus[] {
    const statuses: NativeCodexStatus[] = [];
    const finish = () => {
      if (!this.overflow) {
        if (this.payload === "7501;state=clear") {
          statuses.push({ state: "clear" });
        } else {
          const match =
            /^7501;state=(idle|working|blocked|done|error):app=codex(?::kind=(permission|question|auth))?$/.exec(
              this.payload,
            );
          if (match && (match[2] === undefined || match[1] === "blocked")) {
            statuses.push({
              state: match[1] as NativeCodexStatus["state"],
              ...(match[2] === undefined
                ? {}
                : { kind: match[2] as NonNullable<NativeCodexStatus["kind"]> }),
            });
          }
        }
      }
      this.mode = "text";
      this.payload = "";
      this.overflow = false;
    };
    for (const char of chunk) {
      if (this.mode === "text") {
        if (char === "\x1b") this.mode = "escape";
      } else if (this.mode === "escape") {
        if (char === "]") {
          this.mode = "osc";
          this.payload = "";
          this.overflow = false;
        } else if (char !== "\x1b") this.mode = "text";
      } else if (this.mode === "osc-escape") {
        if (char === "\\") finish();
        else if (char === "]") {
          // Recover from a malformed/unterminated sequence without retaining it.
          this.mode = "osc";
          this.payload = "";
          this.overflow = false;
        } else {
          this.mode = char === "\x1b" ? "escape" : "text";
          this.payload = "";
          this.overflow = false;
        }
      } else if (char === "\x07") finish();
      else if (char === "\x1b") this.mode = "osc-escape";
      else if (!this.overflow) {
        if (this.payload.length < 256) this.payload += char;
        else {
          this.payload = "";
          this.overflow = true;
        }
      }
    }
    return statuses;
  }
}
