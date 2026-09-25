import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventQueueStore } from './event-queue.js';
import type { RoutedEvent } from './event-subject.js';

function makeEvent(overrides: Partial<RoutedEvent> = {}): RoutedEvent {
  return {
    type: 'order.shipped',
    subject: { memberId: 'member-1' },
    timestamp: '2024-05-05T00:00:00.000Z',
    data: { orderId: 'o-1' },
    ...overrides,
  };
}

// --- enqueue / list (Req 5.1) ------------------------------------------------

test('enqueue stores the Event into the member queue as pending (Req 5.1)', () => {
  const queue = new EventQueueStore({ now: () => Date.parse('2024-05-05T01:00:00.000Z') });
  const queued = queue.enqueue(makeEvent());
  assert.equal(queued.status, 'pending');
  assert.equal(queued.type, 'order.shipped');
  assert.deepEqual(queued.payload, { orderId: 'o-1' });
  assert.equal(queued.subject.memberId, 'member-1');

  const pending = queue.listPending('member-1');
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.id, queued.id);
});

test('queue is per member — events do not leak across members', () => {
  const queue = new EventQueueStore({ now: () => Date.parse('2024-05-05T01:00:00.000Z') });
  queue.enqueue(makeEvent({ subject: { memberId: 'member-1' } }));
  queue.enqueue(makeEvent({ subject: { memberId: 'member-2' } }));
  queue.enqueue(makeEvent({ subject: { memberId: 'member-2' } }));
  assert.equal(queue.pendingCount('member-1'), 1);
  assert.equal(queue.pendingCount('member-2'), 2);
  assert.equal(queue.pendingCount('member-3'), 0);
});

test('enqueue preserves order (oldest first) and forwards idempotencyKey', () => {
  const queue = new EventQueueStore({ now: () => Date.parse('2024-05-05T01:00:00.000Z') });
  queue.enqueue(makeEvent({ type: 'a', idempotencyKey: 'k-a' }));
  queue.enqueue(makeEvent({ type: 'b' }));
  const pending = queue.listPending('member-1');
  assert.deepEqual(pending.map((e) => e.type), ['a', 'b']);
  assert.equal(pending[0]?.idempotencyKey, 'k-a');
});

test('receivedAt is derived from the Event timestamp', () => {
  const queue = new EventQueueStore({ now: () => Date.parse('2024-05-05T01:00:00.000Z') });
  const queued = queue.enqueue(makeEvent({ timestamp: '2024-05-05T00:30:00.000Z' }));
  assert.equal(queued.receivedAt, Date.parse('2024-05-05T00:30:00.000Z'));
});

test('receivedAt falls back to now when the timestamp is unparseable', () => {
  const now = Date.parse('2024-05-05T01:00:00.000Z');
  const queue = new EventQueueStore({ now: () => now });
  const queued = queue.enqueue(makeEvent({ timestamp: 'not-a-date' }));
  assert.equal(queued.receivedAt, now);
});

test('list returns copies so callers cannot mutate internal state', () => {
  const queue = new EventQueueStore({ now: () => Date.parse('2024-05-05T01:00:00.000Z') });
  queue.enqueue(makeEvent());
  const copy = queue.list('member-1');
  copy[0]!.status = 'processed';
  assert.equal(queue.listPending('member-1').length, 1, 'internal state unchanged');
});

// --- markProcessed (Req 6.4 / Task 8 groundwork) -----------------------------

test('markProcessed flips status and removes the Event from pending', () => {
  const queue = new EventQueueStore({ now: () => Date.parse('2024-05-05T01:00:00.000Z') });
  const queued = queue.enqueue(makeEvent());
  assert.equal(queue.markProcessed('member-1', queued.id), true);
  assert.equal(queue.pendingCount('member-1'), 0);
  assert.equal(queue.list('member-1')[0]?.status, 'processed');
});

test('markProcessed returns false for an unknown Event id', () => {
  const queue = new EventQueueStore({ now: () => Date.parse('2024-05-05T01:00:00.000Z') });
  queue.enqueue(makeEvent());
  assert.equal(queue.markProcessed('member-1', 'nope'), false);
});

// --- retention policy (Req 5.3) ----------------------------------------------

test('an Event older than the retention window is expired and dropped (Req 5.3)', () => {
  let now = Date.parse('2024-05-05T00:00:00.000Z');
  const queue = new EventQueueStore({ retentionMs: 60_000, now: () => now });
  queue.enqueue(makeEvent({ timestamp: '2024-05-05T00:00:00.000Z' }));
  assert.equal(queue.pendingCount('member-1'), 1);

  // Advance past the retention window.
  now = Date.parse('2024-05-05T00:02:00.000Z');
  assert.equal(queue.pendingCount('member-1'), 0, 'expired Event dropped');
  assert.equal(queue.listPending('member-1').length, 0);
});

test('an Event within the retention window is kept (Req 5.3)', () => {
  let now = Date.parse('2024-05-05T00:00:00.000Z');
  const queue = new EventQueueStore({ retentionMs: 60_000, now: () => now });
  queue.enqueue(makeEvent({ timestamp: '2024-05-05T00:00:00.000Z' }));
  now = Date.parse('2024-05-05T00:00:30.000Z');
  assert.equal(queue.pendingCount('member-1'), 1, 'within window still queued');
});

test('constructor rejects a non-positive retention window', () => {
  assert.throws(() => new EventQueueStore({ retentionMs: 0 }), RangeError);
  assert.throws(() => new EventQueueStore({ retentionMs: -1 }), RangeError);
});
