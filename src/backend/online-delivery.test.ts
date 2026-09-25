import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OnlineDeliveryStore } from './online-delivery.js';
import type { RoutedEvent } from './event-subject.js';

function makeEvent(memberId: string, overrides: Partial<RoutedEvent> = {}): RoutedEvent {
  return {
    type: 'order.shipped',
    subject: { memberId },
    timestamp: '2024-05-05T00:00:00.000Z',
    data: { orderId: 'o-1' },
    ...overrides,
  };
}

test('buffered Event is peekable via poll and left pending (Req 4.1, 9.3)', () => {
  const store = new OnlineDeliveryStore({ now: () => 1000 });
  const buffered = store.buffer(makeEvent('member-1'));

  const first = store.poll('member-1');
  assert.equal(first.length, 1);
  assert.equal(first[0].id, buffered.id);
  assert.equal(first[0].memberId, 'member-1');
  assert.deepEqual(first[0].data, { orderId: 'o-1' });

  // Poll is a peek, not a pop: still pending until acknowledged (Req 9.3).
  assert.equal(store.pendingCount('member-1'), 1);
  const second = store.poll('member-1');
  assert.equal(second.length, 1, 'a failed delivery must keep the Event for retry');
});

test('acknowledge removes only the confirmed ids (Req 9.3)', () => {
  const store = new OnlineDeliveryStore({ now: () => 1000 });
  const a = store.buffer(makeEvent('member-1', { type: 'a' }));
  const b = store.buffer(makeEvent('member-1', { type: 'b' }));
  assert.equal(store.pendingCount('member-1'), 2);

  const removed = store.acknowledge('member-1', [a.id]);
  assert.equal(removed, 1);
  const remaining = store.poll('member-1');
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].id, b.id);
});

test('acknowledge ignores unknown / duplicate ids harmlessly', () => {
  const store = new OnlineDeliveryStore({ now: () => 1000 });
  const a = store.buffer(makeEvent('member-1'));
  assert.equal(store.acknowledge('member-1', ['nope']), 0);
  assert.equal(store.acknowledge('member-1', [a.id]), 1);
  assert.equal(store.acknowledge('member-1', [a.id]), 0, 'duplicate ack is a no-op');
  assert.equal(store.pendingCount('member-1'), 0);
});

test('delivery buffer is per member', () => {
  const store = new OnlineDeliveryStore({ now: () => 1000 });
  store.buffer(makeEvent('member-1'));
  store.buffer(makeEvent('member-2'));
  store.buffer(makeEvent('member-2'));
  assert.equal(store.pendingCount('member-1'), 1);
  assert.equal(store.pendingCount('member-2'), 2);
  assert.equal(store.poll('member-3').length, 0);
});

test('buffer preserves order (oldest first) and forwards idempotencyKey', () => {
  const store = new OnlineDeliveryStore({ now: () => 1000 });
  store.buffer(makeEvent('m', { type: 't1', idempotencyKey: 'k1' }));
  store.buffer(makeEvent('m', { type: 't2' }));
  const events = store.poll('m');
  assert.deepEqual(events.map((event) => event.type), ['t1', 't2']);
  assert.equal(events[0].idempotencyKey, 'k1');
  assert.equal(events[1].idempotencyKey, undefined);
});

test('rejects an empty member id', () => {
  const store = new OnlineDeliveryStore();
  assert.throws(() => store.poll('  '), TypeError);
});
