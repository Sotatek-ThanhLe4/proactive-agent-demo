import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  InvalidEventError,
  readEventSubject,
  routeInboundEvent,
} from './event-subject.js';

// --- readEventSubject (Req 2.2, 2.3) ----------------------------------------

test('readEventSubject reads a top-level memberId', () => {
  const subject = readEventSubject({ type: 'order.shipped', memberId: 'member-1' });
  assert.equal(subject.memberId, 'member-1');
});

test('readEventSubject reads a top-level subjectKey alias', () => {
  const subject = readEventSubject({ type: 'order.shipped', subjectKey: 'member-2' });
  assert.equal(subject.memberId, 'member-2');
});

test('readEventSubject reads a nested subject.memberId', () => {
  const subject = readEventSubject({ type: 'x', subject: { memberId: 'member-3' } });
  assert.equal(subject.memberId, 'member-3');
});

test('readEventSubject trims surrounding whitespace', () => {
  const subject = readEventSubject({ memberId: '  member-4  ' });
  assert.equal(subject.memberId, 'member-4');
});

test('readEventSubject rejects a missing Subject (Req 2.3)', () => {
  assert.throws(
    () => readEventSubject({ type: 'order.shipped' }),
    (error: unknown) =>
      error instanceof InvalidEventError && error.reason === 'MISSING_SUBJECT',
  );
});

test('readEventSubject rejects an empty Subject (Req 2.3)', () => {
  assert.throws(
    () => readEventSubject({ memberId: '   ' }),
    (error: unknown) =>
      error instanceof InvalidEventError && error.reason === 'MISSING_SUBJECT',
  );
});

test('readEventSubject rejects a non-object body', () => {
  assert.throws(
    () => readEventSubject('nope'),
    (error: unknown) => error instanceof InvalidEventError && error.reason === 'MALFORMED_BODY',
  );
});

// --- routeInboundEvent (Req 2.2, 2.3, 2.4) ----------------------------------

test('routeInboundEvent keeps type, subject, and untouched data (Req 2.4)', () => {
  const data = { orderId: 'o-9', nested: { a: 1 } };
  const routed = routeInboundEvent({ type: 'order.shipped', memberId: 'm-1', data });
  assert.equal(routed.type, 'order.shipped');
  assert.equal(routed.subject.memberId, 'm-1');
  // The business payload is forwarded byte-for-byte, not interpreted.
  assert.deepEqual(routed.data, data);
});

test('routeInboundEvent forwards a provided idempotencyKey', () => {
  const routed = routeInboundEvent({ type: 't', memberId: 'm', idempotencyKey: ' k-1 ' });
  assert.equal(routed.idempotencyKey, 'k-1');
});

test('routeInboundEvent defaults timestamp to a valid ISO string when absent', () => {
  const routed = routeInboundEvent({ type: 't', memberId: 'm' });
  assert.ok(!Number.isNaN(Date.parse(routed.timestamp)));
});

test('routeInboundEvent preserves a provided timestamp', () => {
  const routed = routeInboundEvent({ type: 't', memberId: 'm', timestamp: '2024-05-05T00:00:00.000Z' });
  assert.equal(routed.timestamp, '2024-05-05T00:00:00.000Z');
});

test('routeInboundEvent rejects an event with no valid Subject (Req 2.3)', () => {
  assert.throws(
    () => routeInboundEvent({ type: 'order.shipped' }),
    (error: unknown) =>
      error instanceof InvalidEventError && error.reason === 'MISSING_SUBJECT',
  );
});

test('routeInboundEvent rejects an event with no type', () => {
  assert.throws(
    () => routeInboundEvent({ memberId: 'm-1' }),
    (error: unknown) => error instanceof InvalidEventError && error.reason === 'MISSING_TYPE',
  );
});

// --- property-style: any event without a Subject is always rejected ----------

test('property: an event lacking any member identity is never routed (Req 2.3)', () => {
  const memberlessBodies: unknown[] = [
    { type: 't' },
    { type: 't', memberId: '' },
    { type: 't', subjectKey: '   ' },
    { type: 't', subject: {} },
    { type: 't', subject: { memberId: '' } },
    { type: 't', memberId: null },
    { type: 't', memberId: 42 },
    { type: 't', subject: 'not-an-object' },
  ];
  for (const body of memberlessBodies) {
    assert.throws(
      () => routeInboundEvent(body),
      (error: unknown) => error instanceof InvalidEventError,
      `expected ${JSON.stringify(body)} to be rejected`,
    );
  }
});

test('property: any event with a non-empty member id and type is routed', () => {
  const ids = ['m', 'member-123', 'guest:dep:sess', 'a'.repeat(200)];
  const types = ['t', 'order.shipped', 'cart.item_added'];
  for (const memberId of ids) {
    for (const type of types) {
      const routed = routeInboundEvent({ type, memberId });
      assert.equal(routed.subject.memberId, memberId);
      assert.equal(routed.type, type);
    }
  }
});
