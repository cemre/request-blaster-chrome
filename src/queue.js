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
   * @param handler    async (item, index) => { ok, blocked?, loggedOut?, error? }
   * @param pacing     { min, max } delay in ms between items
   * @param onProgress ({ done, total, item, result }) => void
   * @param onFinish   ({ done, total, halted, haltReason, haltStatus, stopped, failures }) => void
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
    this.haltReason = null; // which kind of push-back it was — see content.js classify
    this.haltStatus = undefined;
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
        // Some handlers (e.g. harvest.js, via api.js's paginated fetchers)
        // throw an ApiError instead of returning a `{ ok: false }` envelope.
        // Duck-typed on `code` rather than importing ApiError from api.js so
        // this generic queue — shared by writes, hydration, and harvest —
        // stays dependency-free; any thrown error carrying the right code
        // halts exactly like a returned envelope would, so no caller can
        // route around the halt just by letting a call throw.
        const code = err?.code;
        result = code === 'blocked' || code === 'logged_out'
          ? {
            ok: false,
            blocked: code === 'blocked',
            loggedOut: code === 'logged_out',
            // Carried through rather than rebuilt: `reason` is the only thing
            // that can tell a throttle from a dead session downstream, and a
            // halt that arrives as a thrown error must not arrive knowing less
            // than the same halt returned as an envelope.
            reason: err.reason,
            status: err.status,
            error: err.message || String(err),
          }
          : { ok: false, error: String(err) };
      }

      this.done += 1;

      // A rate-limit, challenge, or logged-out response means stop entirely.
      // Retrying into an action block is how a temporary throttle becomes a
      // long one, and retrying while logged out just burns the rest of the
      // queue as identical failures.
      if (result && (result.blocked || result.loggedOut)) {
        this.halted = result.error || 'rate_limited';
        // `halted` is Instagram's own words and goes in the detail view; this
        // is what the banner's prose is written from. Kept apart because the
        // raw string is the one thing that must not be paraphrased away — and,
        // for a soft throttle, reads `login_required` while you are signed in.
        this.haltReason = result.reason;
        this.haltStatus = result.status;
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
      haltReason: this.haltReason,
      haltStatus: this.haltStatus,
      stopped: this.stopped,
      failures: this.failures,
    });
  }
}
