import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  admitTurns,
  ADMIT_ALL_TYPES,
  DEFAULT_RATE_CONTROL_CONFIG,
  emptyRateState,
  type RateCandidate,
  type RateControlConfig,
  type RateState,
} from './rate-control.js';

/** A tiny candidate factory: just needs a stable eventId (+ optional type). */
function cand(eventId: string, type?: string): RateCandidate & { type?: string } {
  return type === undefined ? { eventId } : { eventId, type };
}

const CFG: RateControlConfig = {
  mergeWindowMs: 10_000,
  capWindowMs: 60_000,
  maxTurnsPerWindow: 3,
};

// --- merge window (Req 10.1) -------------------------------------------------

test('a burst delivered together admits at most one turn (Req 10.1)', () => {
  const burst = [cand('e1'), cand('e2'), cand('e3'), cand('e4')];
  const result = admitTurns(burst, { now: 1_000, config: CFG }, emptyRateState());
  assert.deepEqual(result.admitted.map((c) => c.eventId), ['e1']);
  assert.deepEqual(result.suppressed, [
    { eventId: 'e2', reason: 'merged' },
    { eventId: 'e3', reason: 'merged' },
    { eventId: 'e4', reason: 'merged' },
  ]);
});

test('events arriving within the merge window fold into the running turn (Req 10.1)', () => {
  const first = admitTurns([cand('e1')], { now: 1_000, config: CFG }, emptyRateState());
  assert.deepEqual(first.admitted.map((c) => c.eventId), ['e1']);

  // 5s later — still inside the 10s merge window — so this yields NO new turn.
  const second = admitTurns([cand('e2')], { now: 6_000, config: CFG }, first.state);
  assert.deepEqual(second.admitted, []);
  assert.deepEqual(second.suppressed, [{ eventId: 'e2', reason: 'merged' }]);
});

test('once the merge window elapses a new turn is admitted (Req 10.1)', () => {
  const first = admitTurns([cand('e1')], { now: 1_000, config: CFG }, emptyRateState());
  // 11s later — outside the 10s merge window — a fresh turn opens.
  const second = admitTurns([cand('e2')], { now: 12_000, config: CFG }, first.state);
  assert.deepEqual(second.admitted.map((c) => c.eventId), ['e2']);
  assert.deepEqual(second.suppressed, []);
});

// --- per-member cap (Req 10.2) ----------------------------------------------

test('the per-member cap suppresses turns beyond the window limit (Req 10.2)', () => {
  let state: RateState = emptyRateState();
  // Space calls > mergeWindowMs apart so merging never hides the cap. 3 allowed.
  const admittedIds: string[] = [];
  const suppressed: Array<{ eventId: string; reason: string }> = [];
  for (let i = 0; i < 5; i++) {
    const now = 1_000 + i * 11_000; // 11s apart, inside the 60s cap window
    const r = admitTurns([cand(`e${i}`)], { now, config: CFG }, state);
    state = r.state;
    admittedIds.push(...r.admitted.map((c) => c.eventId));
    suppressed.push(...r.suppressed);
  }
  // Only the cap (3) is admitted; the 4th and 5th are capped.
  assert.deepEqual(admittedIds, ['e0', 'e1', 'e2']);
  assert.deepEqual(suppressed, [
    { eventId: 'e3', reason: 'capped' },
    { eventId: 'e4', reason: 'capped' },
  ]);
});

test('cap frees up as old turns age out of the sliding window (Req 10.2)', () => {
  let state: RateState = emptyRateState();
  // Fill the cap at t=1s,12s,23s.
  for (const i of [0, 1, 2]) {
    const r = admitTurns([cand(`e${i}`)], { now: 1_000 + i * 11_000, config: CFG }, state);
    state = r.state;
  }
  // At t=34s (outside the 10s merge window of the 23s turn, inside the 60s cap
  // window of all three) the cap is full → capped, not merged.
  const capped = admitTurns([cand('e3')], { now: 34_000, config: CFG }, state);
  assert.deepEqual(capped.admitted, []);
  assert.deepEqual(capped.suppressed, [{ eventId: 'e3', reason: 'capped' }]);
  state = capped.state;

  // At t=62s the first two turns (1s,12s) have aged out of the 60s window, so a
  // turn is admitted again.
  const freed = admitTurns([cand('e4')], { now: 62_000, config: CFG }, state);
  assert.deepEqual(freed.admitted.map((c) => c.eventId), ['e4']);
});

// --- purity / determinism ----------------------------------------------------

test('admitTurns does not mutate the input state', () => {
  const state = emptyRateState();
  const snapshot: RateState = { lastAdmittedAt: state.lastAdmittedAt, admittedAtWindow: [...state.admittedAtWindow] };
  admitTurns([cand('e1')], { now: 1_000, config: CFG }, state);
  assert.deepEqual(state, snapshot);
});

test('admitTurns is deterministic for the same inputs', () => {
  const burst = [cand('e1'), cand('e2'), cand('e3')];
  const a = admitTurns(burst, { now: 5_000, config: CFG }, emptyRateState());
  const b = admitTurns(burst, { now: 5_000, config: CFG }, emptyRateState());
  assert.deepEqual(a, b);
});

test('empty candidate batch yields empty result and unchanged state', () => {
  const state = emptyRateState();
  const r = admitTurns([], { now: 1_000, config: CFG }, state);
  assert.deepEqual(r.admitted, []);
  assert.deepEqual(r.suppressed, []);
  assert.deepEqual(r.state, { lastAdmittedAt: null, admittedAtWindow: [] });
});

// --- type filter seam (Task 11 — default admit-all) --------------------------

test('the default type filter admits every type (Task 11 not yet applied)', () => {
  assert.equal(ADMIT_ALL_TYPES('anything'), true);
  assert.equal(ADMIT_ALL_TYPES(undefined), true);
});

test('a custom type filter can suppress non-worthy types without opening a turn', () => {
  const worthy = (type: string | undefined) => type === 'order.shipped';
  const burst = [cand('e1', 'noise'), cand('e2', 'order.shipped'), cand('e3', 'order.shipped')];
  const r = admitTurns(burst, {
    now: 1_000,
    config: CFG,
    typeFilter: worthy,
    getType: (c) => (c as { type?: string }).type,
  }, emptyRateState());
  // e1 filtered out (merged/recorded), e2 opens the turn, e3 merged.
  assert.deepEqual(r.admitted.map((c) => c.eventId), ['e2']);
  assert.deepEqual(r.suppressed, [
    { eventId: 'e1', reason: 'merged' },
    { eventId: 'e3', reason: 'merged' },
  ]);
});

// --- Property 7: Kiểm soát nhịp ---------------------------------------------
// **Validates: Requirements 10.1, 10.2**
//
// Property: for ANY sequence of bursty Events for a single member, driven
// through the shared rate controller (as BOTH the online poll and the pending
// drain do), the turns admitted within any merge window number at most one, and
// the turns admitted within any cap window never exceed maxTurnsPerWindow.
//
// No fast-check dependency in this app (tests use node:test); we exercise the
// property over a deterministic pseudo-random space of bursty arrival schedules.

/** Small deterministic PRNG (mulberry32) so the property runs are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('Property 7: bursty events yield at most one turn per merge window and never exceed the cap (Req 10.1, 10.2)', () => {
  const cfg = DEFAULT_RATE_CONTROL_CONFIG; // 10s merge, 60s cap window, 5/window
  for (let seed = 1; seed <= 200; seed++) {
    const rand = mulberry32(seed);
    let state: RateState = emptyRateState();
    let now = 0;
    let idCounter = 0;

    // Record every admitted turn's timestamp to check both invariants.
    const admittedTimes: number[] = [];

    const batches = 1 + Math.floor(rand() * 20); // 1..20 poll ticks / drains
    for (let b = 0; b < batches; b++) {
      // Advance time by a bursty gap: often tiny (same burst), sometimes large.
      const gap = rand() < 0.6 ? Math.floor(rand() * 3_000) : Math.floor(rand() * 90_000);
      now += gap;

      const burstSize = 1 + Math.floor(rand() * 6); // 1..6 events delivered together
      const candidates = Array.from({ length: burstSize }, () => cand(`e${idCounter++}`));

      const r = admitTurns(candidates, { now, config: cfg }, state);
      state = r.state;

      // Invariant A (Req 10.1): a single delivered batch admits at most one turn.
      assert.ok(
        r.admitted.length <= 1,
        `seed ${seed}: batch admitted ${r.admitted.length} turns (> 1)`,
      );

      for (const _ of r.admitted) admittedTimes.push(now);
    }

    // Invariant B (Req 10.1): no two admitted turns fall within one merge window.
    for (let i = 1; i < admittedTimes.length; i++) {
      assert.ok(
        admittedTimes[i] - admittedTimes[i - 1] >= cfg.mergeWindowMs,
        `seed ${seed}: two turns within the merge window (${admittedTimes[i - 1]} -> ${admittedTimes[i]})`,
      );
    }

    // Invariant C (Req 10.2): within any sliding cap window, at most cap turns.
    for (let i = 0; i < admittedTimes.length; i++) {
      const windowStart = admittedTimes[i];
      const inWindow = admittedTimes.filter(
        (t) => t >= windowStart && t < windowStart + cfg.capWindowMs,
      );
      assert.ok(
        inWindow.length <= cfg.maxTurnsPerWindow,
        `seed ${seed}: ${inWindow.length} turns in a cap window (> ${cfg.maxTurnsPerWindow})`,
      );
    }
  }
});
