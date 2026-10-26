type MeterSnapshot = {
  levels: readonly number[];
  startedAt: number | null;
  stoppedAt: number | null;
};

const EMPTY: MeterSnapshot = { levels: [], startedAt: null, stoppedAt: null };
const HISTORY_LENGTH = 24;

/** Audio samples update the small recording indicator without rerendering the composer. */
export class NativeDictationMeter {
  private snapshot = EMPTY;
  private readonly listeners = new Set<() => void>();

  getSnapshot = (): MeterSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  start(): void {
    this.publish({ levels: [], startedAt: Date.now(), stoppedAt: null });
  }

  sample(level: number): void {
    if (
      this.snapshot.startedAt === null ||
      this.snapshot.stoppedAt !== null ||
      !Number.isFinite(level) ||
      level < 0 ||
      level > 1
    )
      return;
    this.publish({
      ...this.snapshot,
      levels: [...this.snapshot.levels.slice(-(HISTORY_LENGTH - 1)), level],
    });
  }

  stop(): void {
    if (this.snapshot.startedAt === null || this.snapshot.stoppedAt !== null) return;
    this.publish({ ...this.snapshot, stoppedAt: Date.now() });
  }

  reset(): void {
    if (this.snapshot !== EMPTY) this.publish(EMPTY);
  }

  private publish(snapshot: MeterSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}
