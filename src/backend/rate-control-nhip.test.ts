/**
 * Unit test — kiểm soát nhịp (Task 12).
 *
 * This suite is COMPLEMENTARY to rate-control.test.ts (which exercises merge and
 * cap in isolation) and conversation-mapping.test.ts. Here we focus on the parts
 * the task calls out explicitly:
 *
 *   - Gộp (merge, Req 10.1) + trần (cap, Req 10.2) + lọc (filter, Req 10.3/10.4)
 *     working TOGETHER in a single paced batch — the combined interaction.
 *   - Loại Event không "đáng phản hồi" chỉ được GHI NHẬN, không mở lượt agent
 *     (Req 10.4) — asserted via the rate controller's `typeFilter` seam so this
 *     task is self-contained even before Task 11's responsive-events filter lands.
 *   - Conversation mapping tất định (deterministic) — reuse `deriveConversationId`.
 *
 * Framework: node:test (project convention). No mocks; pure functions only.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  admitTurns,
  emptyRateState,
  type RateCandidate,
  type RateControlConfig,
  type RateState,
  type TypeFilter,
} from './rate-control.js';
import {
  deriveConversationId,
  type MemberIdentity,
} from './conversation-mapping.js';

/** A candidate carrying an Event type, so the filter seam has something to read. */
interface TypedCandidate extends RateCandidate {
  type: string;
}

function ev(eventId: string, type: string): TypedCandidate {
  return { eventId, type };
}

const readType = (c: RateCandidate): string | undefined =>
  (c as Partial<TypedCandidate>).type;

/** Tight tunables so a single batch can hit merge, cap, and filter at once. */
const CFG: RateControlConfig = {
  mergeWindowMs: 10_000,
  capWindowMs: 60_000,
  maxTurnsPerWindow: 2,
};

/** Only these Event types are "đáng phản hồi" (worth a proactive turn). */
const WORTHY: ReadonlySet<string> = new Set(['order.shipped', 'ticket.assigned']);
const worthyFilter: TypeFilter = (type) => type !== undefined && WORTHY.has(type);

// --- Gộp + Lọc together (Req 10.1, 10.3, 10.4) ------------------------------

test('combined merge + filter: non-worthy types are only recorded, worthy burst folds to one turn (Req 10.1, 10.3, 10.4)', () => {
  // A mixed burst delivered together: noise, then two worthy events.
  const burst = [
    ev('n1', 'presence.ping'), // not worthy → recorded only
    ev('n2', 'metrics.tick'), //  not worthy → recorded only
    ev('w1', 'order.shipped'), // worthy → opens the single turn
    ev('w2', 'ticket.assigned'), // worthy → merged into the same turn
  ];

  const r = admitTurns(
    burst,
    { now: 1_000, config: CFG, typeFilter: worthyFilter, getType: readType },
    emptyRateState(),
  );

  // Only ONE worthy turn runs for the whole burst (gộp).
  assert.deepEqual(r.admitted.map((c) => c.eventId), ['w1']);
  // Non-worthy events are suppressed (recorded, not lost) and the extra worthy
  // event is merged — none of them spawn a turn (Req 10.4).
  assert.deepEqual(r.suppressed, [
    { eventId: 'n1', reason: 'merged' },
    { eventId: 'n2', reason: 'merged' },
    { eventId: 'w2', reason: 'merged' },
  ]);
});

test('a burst of only non-worthy events runs no turn at all (Req 10.4)', () => {
  const burst = [ev('n1', 'presence.ping'), ev('n2', 'metrics.tick')];
  const r = admitTurns(
    burst,
    { now: 1_000, config: CFG, typeFilter: worthyFilter, getType: readType },
    emptyRateState(),
  );
  assert.deepEqual(r.admitted, []);
  assert.deepEqual(r.suppressed, [
    { eventId: 'n1', reason: 'merged' },
    { eventId: 'n2', reason: 'merged' },
  ]);
  // No turn admitted → the cap window stays empty (nothing charged).
  assert.deepEqual(r.state.admittedAtWindow, []);
  assert.equal(r.state.lastAdmittedAt, null);
});

// --- Gộp + Trần + Lọc together across time (Req 10.1, 10.2, 10.3, 10.4) ------

test('combined merge + cap + filter across separated worthy events (Req 10.1, 10.2, 10.3, 10.4)', () => {
  let state: RateState = emptyRateState();
  const admittedIds: string[] = [];
  const suppressed: Array<{ eventId: string; reason: string }> = [];

  // Feed worthy and non-worthy events spaced > mergeWindowMs apart so merging
  // does not mask the cap. With maxTurnsPerWindow = 2, only the first two worthy
  // events get a turn; the third worthy is capped; non-worthy never counts.
  const schedule: Array<{ now: number; cand: TypedCandidate }> = [
    { now: 1_000, cand: ev('w1', 'order.shipped') }, // worthy → admitted (1)
    { now: 12_000, cand: ev('x1', 'presence.ping') }, // noise  → recorded only
    { now: 23_000, cand: ev('w2', 'ticket.assigned') }, // worthy → admitted (2)
    { now: 34_000, cand: ev('x2', 'metrics.tick') }, // noise  → recorded only
    { now: 45_000, cand: ev('w3', 'order.shipped') }, // worthy → capped (over 2)
  ];

  for (const step of schedule) {
    const r = admitTurns(
      [step.cand],
      { now: step.now, config: CFG, typeFilter: worthyFilter, getType: readType },
      state,
    );
    state = r.state;
    admittedIds.push(...r.admitted.map((c) => c.eventId));
    suppressed.push(...r.suppressed);
  }

  // Only two worthy turns admitted (the cap), non-worthy never opened a turn.
  assert.deepEqual(admittedIds, ['w1', 'w2']);
  // x1/x2 recorded (filtered), w3 capped.
  assert.deepEqual(suppressed, [
    { eventId: 'x1', reason: 'merged' },
    { eventId: 'x2', reason: 'merged' },
    { eventId: 'w3', reason: 'capped' },
  ]);
  // Exactly two turns are counted against the cap window.
  assert.equal(state.admittedAtWindow.length, 2);
});

test('non-worthy events do not consume the per-member cap (Req 10.2, 10.4)', () => {
  let state: RateState = emptyRateState();

  // Ten pieces of noise spaced apart — none should touch the cap.
  for (let i = 0; i < 10; i++) {
    const r = admitTurns(
      [ev(`n${i}`, 'presence.ping')],
      { now: 1_000 + i * 11_000, config: CFG, typeFilter: worthyFilter, getType: readType },
      state,
    );
    state = r.state;
    assert.deepEqual(r.admitted, []);
  }
  assert.equal(state.admittedAtWindow.length, 0);

  // A worthy event afterwards is still free to run (cap untouched by noise).
  const r = admitTurns(
    [ev('w1', 'order.shipped')],
    { now: 200_000, config: CFG, typeFilter: worthyFilter, getType: readType },
    state,
  );
  assert.deepEqual(r.admitted.map((c) => c.eventId), ['w1']);
});

// --- Determinism of the combined pacing path --------------------------------

test('combined merge+cap+filter pacing is deterministic for identical inputs', () => {
  const burst = [
    ev('n1', 'presence.ping'),
    ev('w1', 'order.shipped'),
    ev('w2', 'ticket.assigned'),
  ];
  const opts = { now: 5_000, config: CFG, typeFilter: worthyFilter, getType: readType };
  const a = admitTurns(burst, opts, emptyRateState());
  const b = admitTurns(burst, opts, emptyRateState());
  assert.deepEqual(a, b);
});

// --- Conversation mapping tất định (Req 3, called out by Task 12) ------------

test('deriveConversationId is deterministic under the pacing test too', () => {
  const identity: MemberIdentity = {
    organizationId: 'org-nhip',
    workspaceId: 'ws-nhip',
    userId: 'member-nhip',
  };
  // Deterministic: repeated derivation yields the identical conversationId.
  const first = deriveConversationId(identity);
  const second = deriveConversationId(identity);
  const third = deriveConversationId({ ...identity });
  assert.equal(second, first);
  assert.equal(third, first);
  assert.match(first, /^pea_[0-9a-f]{32}$/);
});

test('each member maps to a distinct deterministic conversation (Req 3)', () => {
  const base: MemberIdentity = {
    organizationId: 'org-nhip',
    workspaceId: 'ws-nhip',
    userId: 'member-a',
  };
  const other: MemberIdentity = { ...base, userId: 'member-b' };
  assert.notEqual(deriveConversationId(base), deriveConversationId(other));
  // And still stable across repeated calls (no hidden state).
  assert.equal(deriveConversationId(base), deriveConversationId(base));
});
