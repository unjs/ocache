// Exact percentiles from retained samples, plus the two process-level signals that
// explain them: CPU per request (which converts directly to cost per request) and event
// loop delay (which is what a blocking origin actually does to a server).

import { monitorEventLoopDelay } from "node:perf_hooks";

const MAX_SAMPLES = 4_000_000;

export class Samples {
  #values = new Float64Array(1024);
  #length = 0;
  dropped = 0;

  add(value: number): void {
    if (this.#length === MAX_SAMPLES) {
      this.dropped++;
      return;
    }
    if (this.#length === this.#values.length) {
      const grown = new Float64Array(Math.min(this.#values.length * 2, MAX_SAMPLES));
      grown.set(this.#values);
      this.#values = grown;
    }
    this.#values[this.#length++] = value;
  }

  get count(): number {
    return this.#length;
  }

  /** Sorts in place; call after the run. */
  percentiles(qs: number[]): number[] {
    if (this.#length === 0) return qs.map(() => 0);
    const view = this.#values.subarray(0, this.#length);
    view.sort();
    return qs.map((q) => {
      const index = Math.min(this.#length - 1, Math.max(0, Math.ceil(q * this.#length) - 1));
      return view[index]!;
    });
  }

  mean(): number {
    let total = 0;
    for (let i = 0; i < this.#length; i++) total += this.#values[i]!;
    return this.#length === 0 ? 0 : total / this.#length;
  }
}

export interface ProcessSample {
  cpuMs: number;
  wallMs: number;
  loopDelayP99Ms: number;
  loopDelayMaxMs: number;
}

/** Measures CPU and loop delay across a window. */
export function createProcessMeter() {
  const loop = monitorEventLoopDelay({ resolution: 1 });
  let cpu = process.cpuUsage();
  let wall = performance.now();
  loop.enable();
  return {
    reset() {
      cpu = process.cpuUsage();
      wall = performance.now();
      loop.reset();
    },
    read(): ProcessSample {
      const used = process.cpuUsage(cpu);
      return {
        cpuMs: (used.user + used.system) / 1000,
        wallMs: performance.now() - wall,
        loopDelayP99Ms: loop.percentile(99) / 1e6,
        loopDelayMaxMs: loop.max / 1e6,
      };
    },
    stop() {
      loop.disable();
    },
  };
}

/** Cache status mix, read from the handler's `x-cache` header. */
export class StatusTally {
  hit = 0;
  stale = 0;
  revalidated = 0;
  miss = 0;
  bypass = 0;
  notModified = 0;

  record(status: string | null | undefined): void {
    switch (status) {
      case "HIT": {
        this.hit++;
        break;
      }
      case "STALE": {
        this.stale++;
        break;
      }
      case "REVALIDATED": {
        this.revalidated++;
        break;
      }
      case "MISS": {
        this.miss++;
        break;
      }
      case "304": {
        // Answered from a stored entry without rebuilding the body.
        this.notModified++;
        break;
      }
      default: {
        this.bypass++;
      }
    }
  }

  get served(): number {
    return this.hit + this.stale + this.revalidated + this.miss + this.bypass + this.notModified;
  }

  /** Share of requests answered without waiting for the origin. */
  get fastPathRatio(): number {
    return this.served === 0 ? 0 : (this.hit + this.stale + this.notModified) / this.served;
  }
}
