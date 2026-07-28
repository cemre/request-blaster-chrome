// queue.js — a sequential, jittered, interruptible work queue.
//
// Used for both profile hydration and accept/reject actions. The pacing exists
// because Instagram action-blocks accounts that make friendship writes too
// fast, and there is no published limit to code against.

// One fixed pace for writes. The panel used to expose conservative/fast
// alternatives; they were removed with the Pace picker, and nothing reads a
// per-user value any more.
export const PACING = {
  moderate: { min: 1500, max: 3000 },
  hydration: { min: 1800, max: 2600 },
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class ThrottledQueue {
  /**
   * @param items      work items
   * @param handler    async (item, index) => { ok, blocked?, error? }
   * @param pacing     { min, max } delay in ms between items
   * @param onProgress ({ done, total, item, result }) => void
   * @param onFinish   ({ done, total, halted, stopped, failures }) => void
   */
  constructor({ items, handler, pacing, onProgress, onFinish }) {
    this.items = items;
    this.handler = handler;
    this.pacing = pacing;
    this.onProgress = onProgress || (() => {});
    this.onFinish = onFinish || (() => {});

    this.running = false;
    this.stopped = false;
    this.halted = null; // set to the blocking error if Instagram pushes back
    this.done = 0;
    this.failures = [];
  }

  get total() {
    return this.items.length;
  }

  stop() {
    this.stopped = true;
  }

  async run() {
    if (this.running) return;
    this.running = true;

    for (let index = 0; index < this.items.length; index += 1) {
      if (this.stopped) break;

      const item = this.items[index];
      let result;
      try {
        result = await this.handler(item, index);
      } catch (err) {
        result = { ok: false, error: String(err) };
      }

      this.done += 1;

      // A rate-limit or challenge response means stop entirely. Retrying into
      // an action block is how a temporary throttle becomes a long one.
      if (result && result.blocked) {
        this.halted = result.error || 'rate_limited';
        this.onProgress({ done: this.done, total: this.total, item, result });
        break;
      }

      if (!result || !result.ok) {
        this.failures.push({ item, error: result?.error || 'unknown error' });
      }

      this.onProgress({ done: this.done, total: this.total, item, result });

      const isLast = index === this.items.length - 1;
      if (!isLast && !this.stopped) {
        const { min, max } = this.pacing;
        await sleep(min + Math.random() * (max - min));
      }
    }

    this.running = false;
    this.onFinish({
      done: this.done,
      total: this.total,
      halted: this.halted,
      stopped: this.stopped,
      failures: this.failures,
    });
  }
}
