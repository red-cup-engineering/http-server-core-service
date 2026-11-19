// internal/clock.ts — injectable wall/manual clock for deterministic timer-bearing modules.

export type ClockHandle = ReturnType<typeof setTimeout> | number;

export type Clock = {
  now(): number;
  schedule(atMs: number, fn: () => void): ClockHandle;
  interval(everyMs: number, fn: () => void): ClockHandle;
  cancel(handle: ClockHandle): void;
};

export type ManualClock = Clock & {
  tick(ms: number): number;
  advanceTo(absMs: number): number;
  set(absMs: number): void;
  pending(): number;
};

export function realClock(): Clock {
  return {
    now: () => Date.now(), // law-allow: wall-clock-as-data — the wall realization of the injectable Clock seam
    schedule(atMs, fn) {
      const timer = setTimeout(fn, Math.max(0, atMs - Date.now())); // law-allow: wall-clock-as-data — the wall realization of the injectable Clock seam
      timer.unref?.();
      return timer;
    },
    interval(everyMs, fn) {
      const timer = setInterval(fn, everyMs);
      timer.unref?.();
      return timer;
    },
    cancel(handle) {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
      clearInterval(handle as ReturnType<typeof setInterval>);
    },
  };
}

export function manualClock(start = 0): ManualClock {
  type Entry = { at: number; every: number; fn: () => void; seq: number };
  let time = start;
  let seq = 0;
  const timers = new Map<number, Entry>();

  function fireDue(): void {
    for (;;) {
      let next: { id: number; entry: Entry } | undefined;
      for (const [id, entry] of timers) {
        if (entry.at > time) continue;
        if (!next || entry.at < next.entry.at || (entry.at === next.entry.at && entry.seq < next.entry.seq)) {
          next = { id, entry };
        }
      }
      if (!next) return;
      if (next.entry.every > 0) next.entry.at += next.entry.every;
      else timers.delete(next.id);
      next.entry.fn();
    }
  }

  return {
    now: () => time,
    schedule(atMs, fn) {
      const id = ++seq;
      timers.set(id, { at: atMs, every: 0, fn, seq: id });
      return id;
    },
    interval(everyMs, fn) {
      const id = ++seq;
      timers.set(id, { at: time + everyMs, every: everyMs, fn, seq: id });
      return id;
    },
    cancel(handle) { timers.delete(Number(handle)); },
    tick(ms) {
      time += ms;
      fireDue();
      return time;
    },
    advanceTo(absMs) {
      time = Math.max(time, absMs);
      fireDue();
      return time;
    },
    set(absMs) { time = absMs; },
    pending: () => timers.size,
  };
}
