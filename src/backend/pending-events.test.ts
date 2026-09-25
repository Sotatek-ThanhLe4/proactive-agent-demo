import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildPendingEventsResponse,
  pendingEventToInbound,
  toPendingEventDto,
} from './pending-events.js';
import type { QueuedEvent } from './event-queue.js';

function makeQueued(overrides: Partial<QueuedEvent> = {}): QueuedEvent {
  return {
    id: 'q_1',
    type: 'order.shipped',
    payload: { orderId: 'o-1' },
    subject: { memberId: 'member-1' },
    receivedAt: Date.parse('2024-05-05T00:00:00.000Z'),
    status: 'pending',
    ...overrides,
  };
}

// --- toPendingEventDto -------------------------------------------------------

test('toPendingEventDto exposes only Surface-facing fields (drops status)', () => {
  const dto = toPendingEventDto(makeQueued());
  assert.deepEqual(dto, {
    id: 'q_1',
    type: 'order.shipped',
    payload: { orderId: 'o-1' },
    receivedAt: Date.parse('2024-05-05T00:00:00.000Z'),
  });
  assert.ok(!('status' in dto), 'internal status must not leak to the Surface');
});

test('toPendingEventDto forwards idempotencyKey when present', () => {
  const dto = toPendingEventDto(makeQueued({ idempotencyKey: 'k-1' }));
  assert.equal(dto.idempotencyKey, 'k-1');
});

test('toPendingEventDto forwards the App-owned payload untouched (Req 2.4)', () => {
  const payload = { nested: { any: 'shape' }, list: [1, 2, 3] };
  const dto = toPendingEventDto(makeQueued({ payload }));
  assert.deepEqual(dto.payload, payload);
});

// --- buildPendingEventsResponse (Req 6.1) ------------------------------------

test('buildPendingEventsResponse preserves queue order (oldest first)', () => {
  const response = buildPendingEventsResponse('member-1', [
    makeQueued({ id: 'q_1', type: 'a' }),
    makeQueued({ id: 'q_2', type: 'b' }),
  ]);
  assert.equal(response.memberId, 'member-1');
  assert.deepEqual(
    response.events.map((event) => event.type),
    ['a', 'b'],
  );
});

test('buildPendingEventsResponse returns an empty list for no pending Events', () => {
  const response = buildPendingEventsResponse('member-1', []);
  assert.deepEqual(response, { memberId: 'member-1', events: [] });
});

// --- pendingEventToInbound (Req 6.2 — reuse the online Context seam) ----------

test('pendingEventToInbound maps to the InboundEvent the Context loader consumes', () => {
  const inbound = pendingEventToInbound(toPendingEventDto(makeQueued()), 'member-1');
  assert.equal(inbound.type, 'order.shipped');
  assert.equal(inbound.subjectKey, 'member-1');
  assert.equal(inbound.mode, 'active');
  assert.equal(inbound.surface, 'workspace');
  assert.deepEqual(inbound.data, { orderId: 'o-1' });
  assert.equal(inbound.timestamp, '2024-05-05T00:00:00.000Z');
});

test('pendingEventToInbound carries idempotencyKey through when present', () => {
  const dto = toPendingEventDto(makeQueued({ idempotencyKey: 'k-9' }));
  const inbound = pendingEventToInbound(dto, 'member-1');
  assert.equal(inbound.idempotencyKey, 'k-9');
});
