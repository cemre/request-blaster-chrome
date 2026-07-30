import test from 'node:test';
import assert from 'node:assert/strict';

import { JobList } from '../src/jobs.js';

/**
 * A runJob stand-in that hands control back to the test.
 *
 * Every job parks on a promise the test resolves by hand, so ordering — which
 * job started, what the list looked like while it ran, what happened when it
 * ended — is asserted rather than raced against a timer.
 */
function harness({ onChange } = {}) {
  const started = [];
  let settle;

  const list = new JobList({
    onChange: onChange || (() => {}),
    runJob: (job) => {
      started.push(job);
      job.stop = () => { job.stopped = true; };
      return new Promise((resolve) => { settle = resolve; });
    },
  });

  return {
    list,
    started,
    /** Finish the job now in flight with the outcome a ThrottledQueue would give. */
    async finish(outcome = {}) {
      const resolve = settle;
      settle = null;
      resolve(outcome);
      // Two turns: one for the await inside pump(), one for the pump() it then
      // fires for the next job, which starts on its own microtask.
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

const ids = (job) => [...job.remaining];

test('the head runs and everything behind it waits', async () => {
  const { list, started } = harness();

  const first = list.enqueue({ kind: 'ignore', scope: 'requests', ids: ['a', 'b'] });
  const second = list.enqueue({ kind: 'approve', scope: 'requests', ids: ['c'] });

  await Promise.resolve();

  assert.deepEqual(started, [first]);
  assert.equal(first.state, 'running');
  assert.equal(second.state, 'queued');
});

test('a finished job hands off to the next', async () => {
  const { list, started, finish } = harness();

  const first = list.enqueue({ kind: 'ignore', scope: 'requests', ids: ['a'] });
  const second = list.enqueue({ kind: 'approve', scope: 'requests', ids: ['b'] });
  await Promise.resolve();

  list.handled(first, 'a');
  await finish({ failures: [] });

  assert.deepEqual(started, [first, second]);
  assert.equal(list.head, second);
  assert.equal(second.state, 'running');
});

test('claims cover every job, not just the running one', async () => {
  const { list } = harness();

  list.enqueue({ kind: 'ignore', scope: 'requests', ids: ['a', 'b'] });
  const second = list.enqueue({ kind: 'approve', scope: 'log', ids: ['c'] });
  await Promise.resolve();

  const claims = list.claims();
  assert.deepEqual([...claims.keys()].sort(), ['a', 'b', 'c']);
  // The scope rides on the job, which is what lets one claim map serve two lists.
  assert.equal(claims.get('c'), second);
  assert.equal(claims.get('c').scope, 'log');
});

test('a handled row stops being claimed', async () => {
  const { list } = harness();

  const job = list.enqueue({ kind: 'ignore', scope: 'requests', ids: ['a', 'b'] });
  await Promise.resolve();

  list.handled(job, 'a');
  assert.deepEqual([...list.claims().keys()], ['b']);
  assert.equal(list.done(job), 1);
});

// The whole reason `remaining` is a Set of what is left rather than a cursor:
// the item a block refused was never actioned, and a resumed job has to still
// be holding it.
test('a halt pauses the pipeline and keeps the refused item', async () => {
  const { list, started, finish } = harness();

  const first = list.enqueue({ kind: 'ignore', scope: 'requests', ids: ['a', 'b', 'c'] });
  const second = list.enqueue({ kind: 'approve', scope: 'requests', ids: ['d'] });
  await Promise.resolve();

  // 'a' went through; 'b' came back blocked, so it is never marked handled.
  list.handled(first, 'a');
  await finish({ halted: 'rate limited' });

  assert.equal(list.paused, 'rate limited');
  assert.equal(list.head, first);
  assert.equal(first.state, 'paused');
  assert.deepEqual(ids(first), ['b', 'c']);
  assert.equal(list.done(first), 1);

  // Nothing behind it started — that is the difference between pausing and
  // walking the next job straight into the same block.
  assert.deepEqual(started, [first]);
  assert.equal(second.state, 'queued');
});

test('resume restarts the halted job holding what it never got to', async () => {
  const { list, started, finish } = harness();

  const first = list.enqueue({ kind: 'ignore', scope: 'requests', ids: ['a', 'b', 'c'] });
  const second = list.enqueue({ kind: 'approve', scope: 'requests', ids: ['d'] });
  await Promise.resolve();

  list.handled(first, 'a');
  await finish({ halted: 'rate limited' });

  list.resume();
  await Promise.resolve();

  assert.equal(list.paused, null);
  assert.deepEqual(started, [first, first]);
  assert.deepEqual(ids(first), ['b', 'c']);

  list.handled(first, 'b');
  list.handled(first, 'c');
  await finish({ failures: [] });

  assert.equal(list.head, second);
});

test('enqueueing while paused does not restart the pipeline', async () => {
  const { list, started, finish } = harness();

  const first = list.enqueue({ kind: 'ignore', scope: 'requests', ids: ['a'] });
  await Promise.resolve();
  await finish({ halted: 'rate limited' });

  const late = list.enqueue({ kind: 'approve', scope: 'requests', ids: ['z'] });
  await Promise.resolve();

  assert.deepEqual(started, [first]);
  assert.equal(late.state, 'queued');
  // Still claimed, though — a row waiting behind a pause is as spoken for as
  // one waiting behind a running job.
  assert.ok(list.claims().has('z'));
});

test('cancelling the paused job lifts the pause with it', async () => {
  const { list, finish } = harness();

  const only = list.enqueue({ kind: 'ignore', scope: 'requests', ids: ['a'] });
  await Promise.resolve();
  await finish({ halted: 'rate limited' });

  assert.equal(list.paused, 'rate limited');
  list.drop(only.id);

  assert.equal(list.paused, null);
  assert.equal(list.busy, false);
  assert.equal(list.claims().size, 0);
});

test('cancelling a queued job releases its rows and leaves the run alone', async () => {
  const { list, started } = harness();

  const first = list.enqueue({ kind: 'ignore', scope: 'requests', ids: ['a'] });
  const second = list.enqueue({ kind: 'approve', scope: 'requests', ids: ['b', 'c'] });
  await Promise.resolve();

  list.drop(second.id);

  assert.deepEqual([...list.claims().keys()], ['a']);
  assert.deepEqual(list.jobs, [first]);
  assert.equal(first.state, 'running');
  assert.deepEqual(started, [first]);
});

test('cancelling the running job stops it and moves on', async () => {
  const { list, started, finish } = harness();

  const first = list.enqueue({ kind: 'ignore', scope: 'requests', ids: ['a', 'b'] });
  const second = list.enqueue({ kind: 'approve', scope: 'requests', ids: ['c'] });
  await Promise.resolve();

  list.drop(first.id);
  assert.equal(first.stopped, true);
  // Released the moment it left the list, without waiting for its queue to
  // notice — the rows are not being written to any more either way.
  assert.deepEqual([...list.claims().keys()], ['c']);

  await finish({ stopped: true });
  assert.deepEqual(started, [first, second]);
});

// The outcome message reads done() off the job after it has left the list, so
// dropping it must not take its count with it. Clearing `remaining` in drop()
// once made a run stopped at 2 of 4 report "Stopped after 4 of 4".
test('a dropped job still knows how far it got', async () => {
  const { list } = harness();

  const job = list.enqueue({ kind: 'ignore', scope: 'requests', ids: ['a', 'b', 'c', 'd'] });
  await Promise.resolve();

  list.handled(job, 'a');
  list.handled(job, 'b');
  list.drop(job.id);

  assert.equal(list.claims().size, 0);
  assert.equal(list.done(job), 2);
});

test('a stopped job releases what it never reached', async () => {
  const { list, finish } = harness();

  const job = list.enqueue({ kind: 'ignore', scope: 'requests', ids: ['a', 'b', 'c'] });
  await Promise.resolve();

  list.handled(job, 'a');
  await finish({ stopped: true });

  assert.equal(list.busy, false);
  assert.equal(list.claims().size, 0);
});

test('a throw out of runJob pauses rather than wedging the list', async () => {
  const list = new JobList({
    runJob: () => Promise.reject(new Error('boom')),
  });

  const job = list.enqueue({ kind: 'ignore', scope: 'requests', ids: ['a'] });
  await Promise.resolve();
  await Promise.resolve();

  assert.ok(list.paused);
  assert.equal(job.state, 'paused');
  assert.equal(list.head, job);
});

test('cancelAll empties the list and clears the pause', async () => {
  const { list, finish } = harness();

  list.enqueue({ kind: 'ignore', scope: 'requests', ids: ['a'] });
  list.enqueue({ kind: 'approve', scope: 'requests', ids: ['b'] });
  await Promise.resolve();
  await finish({ halted: 'rate limited' });

  list.cancelAll();

  assert.equal(list.busy, false);
  assert.equal(list.paused, null);
  assert.equal(list.claims().size, 0);
});

test('the denominator does not move as rows are handled', async () => {
  const { list } = harness();

  const job = list.enqueue({ kind: 'ignore', scope: 'requests', ids: ['a', 'b', 'c'] });
  await Promise.resolve();

  list.handled(job, 'a');
  list.handled(job, 'b');

  assert.equal(job.total, 3);
  assert.equal(list.done(job), 2);
});

// ------------------------------------------------------------- guest jobs

/**
 * A guest brings its own runner, so it needs a harness whose runJob honours it.
 * That is exactly what panel.js's own runJob does for `job.run`.
 */
function guestHarness() {
  let settle;
  const list = new JobList({
    runJob: (job) => {
      if (job.run) return job.run(job);
      return new Promise((resolve) => { settle = resolve; });
    },
  });
  return {
    list,
    async finish(outcome = {}) {
      settle(outcome);
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

test('a guest job waits its turn behind a write', async () => {
  const { list, finish } = guestHarness();
  let harvestStarted = false;

  list.enqueue({ kind: 'ignore', scope: 'requests', ids: ['a'] });
  const guest = list.enqueue({
    kind: 'guest',
    scope: 'log',
    ids: ['1', '2'],
    spec: { label: 'Harvest', gerund: 'Harvesting' },
    run: () => { harvestStarted = true; return Promise.resolve({}); },
  });

  await Promise.resolve();

  // This is the whole point: the harvest is thousands of requests and it does
  // not make a single one of them while a write is in flight.
  assert.equal(harvestStarted, false);
  assert.equal(guest.state, 'queued');

  await finish({});
  assert.equal(harvestStarted, true);
});

test('a guest claims its rows while it is still waiting', async () => {
  const { list } = guestHarness();

  list.enqueue({ kind: 'ignore', scope: 'requests', ids: ['a'] });
  list.enqueue({
    kind: 'guest', scope: 'log', ids: ['1', '2'],
    spec: { label: 'Harvest', gerund: 'Harvesting' },
    run: () => new Promise(() => {}),
  });

  await Promise.resolve();

  // Queued is as spoken for as running: those rows are going to be harvested,
  // and ticking them for a second harvest in the meantime means doing it twice.
  const claims = list.claims();
  assert.equal(claims.get('1').spec.label, 'Harvest');
  assert.equal(claims.get('2').spec.label, 'Harvest');
});

test('a guest that halts pauses the pipeline behind it', async () => {
  const { list } = guestHarness();

  const guest = list.enqueue({
    kind: 'guest', scope: 'log', ids: ['1'],
    spec: { label: 'Harvest', gerund: 'Harvesting' },
    run: () => Promise.resolve({ halted: 'challenge_required' }),
  });
  list.enqueue({ kind: 'ignore', scope: 'requests', ids: ['a'] });

  await Promise.resolve();
  await Promise.resolve();

  // A read getting rate limited is the same warning as a write getting one, and
  // draining the queue into the same block is what the pause exists to stop.
  assert.equal(list.paused, 'challenge_required');
  assert.equal(list.head, guest);
});

test('a guest cancelled before its turn is told, so it can undo its own UI', async () => {
  const { list, finish } = guestHarness();
  let dropped = false;
  let ran = false;

  list.enqueue({ kind: 'ignore', scope: 'requests', ids: ['a'] });
  const guest = list.enqueue({
    kind: 'guest', scope: 'log', ids: ['1'],
    spec: { label: 'Harvest', gerund: 'Harvesting' },
    run: () => { ran = true; return Promise.resolve({}); },
    onDrop: () => { dropped = true; },
  });

  await Promise.resolve();
  list.drop(guest.id);

  assert.equal(dropped, true);
  assert.equal(ran, false);
  assert.equal(list.claims().size, 1); // the write's row, not the guest's

  // And the write behind it carries on untouched.
  await finish({});
  assert.equal(list.busy, false);
});

test('a running guest is stopped rather than told it was dropped', async () => {
  const { list } = guestHarness();
  let dropped = false;
  let stopped = false;

  const guest = list.enqueue({
    kind: 'guest', scope: 'log', ids: ['1'],
    spec: { label: 'Harvest', gerund: 'Harvesting' },
    run: ({ setStop } = {}) => new Promise(() => {}),
    onDrop: () => { dropped = true; },
  });
  await Promise.resolve();
  guest.stop = () => { stopped = true; };

  list.drop(guest.id);

  // It ends by the path it already has — its queue stops, its onFinish fires.
  // onDrop would be a second ending for the same event.
  assert.equal(stopped, true);
  assert.equal(dropped, false);
});

test('cancelAll tells every waiting guest, not just the head', async () => {
  const { list } = guestHarness();
  const dropped = [];

  list.enqueue({ kind: 'ignore', scope: 'requests', ids: ['a'] });
  list.enqueue({
    kind: 'guest', scope: 'log', ids: ['1'],
    spec: { label: 'Harvest', gerund: 'Harvesting' },
    run: () => Promise.resolve({}),
    onDrop: () => dropped.push('first'),
  });
  list.enqueue({
    kind: 'guest', scope: 'log', ids: ['2'],
    spec: { label: 'Harvest', gerund: 'Harvesting' },
    run: () => Promise.resolve({}),
    onDrop: () => dropped.push('second'),
  });

  await Promise.resolve();
  list.cancelAll();

  assert.deepEqual(dropped, ['first', 'second']);
  assert.equal(list.busy, false);
});
