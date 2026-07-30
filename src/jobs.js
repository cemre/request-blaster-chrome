// jobs.js — the panel's write pipeline.
//
// Every accept, reject and follow-back the user asks for becomes a job and joins
// this list, which runs them one at a time. The serialisation is the point, not a
// simplification: Instagram action-blocks accounts whose friendship writes come
// too fast, PACING.moderate was picked to sit under a limit nobody publishes, and
// two queues running at once would double the rate it was chosen for. So this
// file adds queueing and specifically refuses to add concurrency — however many
// jobs are waiting, Instagram sees exactly the write rate it saw when the panel
// could only hold one.
//
// No DOM and no API client here. What it owns is the order of the work, which
// rows each job has laid claim to, and what a rate-limit halt does to everything
// still waiting behind it.

/**
 * The list, and the pump that walks it.
 *
 * `jobs[0]` is the one that runs; everything behind it is waiting its turn. A job
 * leaves the list only when it is finished, stopped or cancelled — a halted one
 * stays at the front, because a halt pauses the pipeline rather than emptying it.
 */
export class JobList {
  /**
   * @param runJob   async (job) => { halted?, stopped?, failures? } — perform the
   *                 job and resolve with the queue's own outcome envelope. It must
   *                 call `handled(job, id)` for every item it gets through, and
   *                 set `job.stop` to something that interrupts it while running.
   * @param onChange () => void — the list or a job's state moved; repaint.
   */
  constructor({ runJob, onChange = () => {} }) {
    this.runJob = runJob;
    this.onChange = onChange;
    this.jobs = [];

    // The halt reason while the pipeline is paused, else null. A string rather
    // than a flag because the banner quotes it back — "Instagram returned X" is
    // the only part of a block the user can act on.
    this.paused = null;

    // Guards the pump against re-entry. Every mutator calls pump(), and most of
    // them can be called from inside a running job's own callbacks.
    this.pumping = false;

    this.nextId = 1;
  }

  get head() {
    return this.jobs[0] || null;
  }

  /** Anything at all queued, running or paused — what beforeunload asks about. */
  get busy() {
    return this.jobs.length > 0;
  }

  /**
   * @param ids   the rows this job will act on, in order
   * @param scope 'requests' | 'log' — which list those ids index
   * @param names optional `Map<id, username>`, for handlers that need more than
   *              an id and must not depend on the row still being on screen
   */
  enqueue({ kind, scope, ids, names = null }) {
    const job = {
      id: this.nextId,
      kind,
      scope,
      names,
      // A Set rather than an index into `ids`, because what is left is the
      // question every other part of this file asks — the claim map reads it,
      // the counter derives from it, and a resumed job runs it.
      remaining: new Set(ids),
      // Held rather than derived, so the denominator does not shrink as the
      // numerator climbs and leave every bar reading "n / n".
      total: ids.length,
      state: 'queued',
      stop: null,
    };
    this.nextId += 1;

    this.jobs.push(job);
    this.onChange();
    this.pump();
    return job;
  }

  /**
   * Every row currently spoken for, as `Map<id, job>`.
   *
   * This is what replaced freezing the whole list. A claimed row is inert because
   * a queue is holding it; every other row stays live, so a second selection can
   * be built and fired while the first is still running.
   */
  claims() {
    const map = new Map();
    for (const job of this.jobs) {
      for (const id of job.remaining) map.set(id, job);
    }
    return map;
  }

  /**
   * This item has been attempted; it is not coming back.
   *
   * Called for plain failures too, which is what the queue's own `failures` list
   * has always meant. The one thing that must *not* go through here is an item
   * refused by a block — leaving it in `remaining` is what lets a resumed job
   * still hold the request Instagram would not take.
   */
  handled(job, id) {
    job.remaining.delete(id);
  }

  done(job) {
    return job.total - job.remaining.size;
  }

  /**
   * Drop a job, running or not, and release its rows back to the list.
   *
   * Deliberately does not put those rows back into the selection. Cancelling is
   * often the prelude to building a different selection, and silently merging
   * twenty-four rows into one already half-built is worse than re-picking them.
   */
  drop(jobId) {
    const index = this.jobs.findIndex((job) => job.id === jobId);
    if (index === -1) return;

    // Leaving the list *is* the release: claims() only walks `this.jobs`, so the
    // rows are free the moment the splice lands. `remaining` is deliberately left
    // standing — it is the job's own count of what it never got to, and the
    // outcome message this job is about to print reads `done()` off it. Clearing
    // it here once made a run stopped at 2 of 4 report "Stopped after 4 of 4".
    const [job] = this.jobs.splice(index, 1);
    // A running job cannot be torn out from under its own queue, so it is asked
    // to stop instead. Its runJob promise resolves shortly after, and pump()
    // finds it already gone from the list.
    if (job.state === 'running') job.stop?.();
    job.state = 'dropped';

    // Cancelling the halted job is the one way out of a pause that is not
    // Resume, so the pause has to lift with it — otherwise the banner goes on
    // offering to resume a pipeline whose reason for stopping has left.
    if (this.jobs.length === 0) this.paused = null;

    this.onChange();
    this.pump();
  }

  /** Instagram pushed back. Hold everything; nothing else writes until Resume. */
  pause(reason) {
    this.paused = reason || 'rate_limited';
    if (this.head) this.head.state = 'paused';
    this.onChange();
  }

  resume() {
    if (!this.paused) return;
    this.paused = null;
    if (this.head) this.head.state = 'queued';
    this.onChange();
    this.pump();
  }

  cancelAll() {
    for (const job of this.jobs) {
      if (job.state === 'running') job.stop?.();
      job.state = 'dropped';
    }
    // Emptying the list releases every claim at once; see drop() for why
    // `remaining` is left alone.
    this.jobs = [];
    this.paused = null;
    this.onChange();
  }

  async pump() {
    if (this.pumping || this.paused) return;

    const job = this.head;
    if (!job || job.state === 'running') return;

    this.pumping = true;
    job.state = 'running';
    this.onChange();

    let outcome;
    try {
      outcome = await this.runJob(job);
    } catch (err) {
      // runJob is not supposed to throw — ThrottledQueue catches per item — but
      // a throw that escaped would otherwise leave this job wedged at the front
      // marked 'running' forever, with every job behind it stuck too. Treated as
      // a halt so the pipeline pauses visibly rather than dying quietly.
      outcome = { halted: String(err) };
    } finally {
      this.pumping = false;
    }

    if (outcome?.halted) {
      this.pause(outcome.halted);
      return;
    }

    // Still at the front means it ended on its own terms — finished, or stopped
    // by its own button. If it is gone, drop()/cancelAll() already took it and
    // there is nothing here to remove.
    if (this.head === job) {
      // A stopped job still holds whatever it never reached, and goes on holding
      // it — the shift is what frees those rows, and the count is worth keeping.
      this.jobs.shift();
      job.state = 'done';
      this.onChange();
    }

    this.pump();
  }
}
