import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PENDING_ACK_PATH,
  PENDING_EVENTS_PATH,
  acknowledgePendingEvents,
  fetchPendingEvents,
  loadContextForPendingEvent,
  parsePendingEventsResponse,
  planPendingTurns,
} from './pending-drain.js';
import type { PendingEventsResponse } from '../backend/pending-events.js';

function response(events: PendingEventsResponse['events']): PendingEventsResponse {
  return { memberId: 'member-1', events };
}

// --- parsePendingEventsResponse ----------------------------------------------

test('parsePendingEventsResponse accepts a well-formed response', () => {
  const parsed = parsePendingEventsResponse({
    memberId: 'member-1',
    events: [{ id: 'q_1', type: 'order.shipped', payload: { orderId: 'o-1' }, receivedAt: 10 }],
  });
  assert.equal(parsed.memberId, 'member-1');
  assert.equal(parsed.events.length, 1);
  assert.equal(parsed.events[0]?.id, 'q_1');
});

test('parsePendingEventsResponse skips malformed rows rather than failing the drain (Req 9.3)', () => {
  const parsed = parsePendingEventsResponse({
    memberId: 'member-1',
    events: [
      { id: 'q_1', type: 'a', receivedAt: 1 },
      { type: 'no-id' }, // malformed → skipped
      { id: 'q_3', type: 'c', receivedAt: 3 },
    ],
  });
  assert.deepEqual(
    parsed.events.map((event) => event.id),
    ['q_1', 'q_3'],
  );
});

test('parsePendingEventsResponse throws on a structurally invalid body', () => {
  assert.throws(() => parsePendingEventsResponse(null), TypeError);
  assert.throws(() => parsePendingEventsResponse({ memberId: 'm' }), TypeError);
  assert.throws(() => parsePendingEventsResponse({ events: [] }), TypeError);
});

// --- fetchPendingEvents ------------------------------------------------------

test('fetchPendingEvents GETs the pending path on the member session and parses the body', async () => {
  let calledUrl = '';
  let calledInit: RequestInit | undefined;
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    calledUrl = String(url);
    calledInit = init;
    return {
      ok: true,
      status: 200,
      json: async () => response([{ id: 'q_1', type: 'a', payload: null, receivedAt: 1 }]),
    } as Response;
  }) as unknown as typeof fetch;

  const parsed = await fetchPendingEvents(fakeFetch);
  assert.equal(calledUrl, PENDING_EVENTS_PATH);
  assert.equal(calledInit?.method, 'GET');
  // Same-origin credentials = the member's own session (Property 2).
  assert.equal(calledInit?.credentials, 'same-origin');
  assert.equal(parsed.events.length, 1);
});

test('fetchPendingEvents throws when the backend returns a non-ok status', async () => {
  const fakeFetch = (async () => ({ ok: false, status: 500, json: async () => ({}) }) as Response) as unknown as typeof fetch;
  await assert.rejects(() => fetchPendingEvents(fakeFetch), /HTTP 500/);
});

// --- loadContextForPendingEvent (Req 6.2 — reuse the online Context seam) -----

test('loadContextForPendingEvent builds Context from the Event (same seam as online)', async () => {
  const context = await loadContextForPendingEvent(
    { id: 'q_1', type: 'order.shipped', payload: { orderId: 'o-1' }, receivedAt: 0 },
    'member-1',
  );
  assert.ok(context.text && context.text.includes('order.shipped'), 'Context summarizes the Event');
  assert.ok(Array.isArray(context.parts) && context.parts.length > 0, 'Context carries structured parts');
});

// --- planPendingTurns (Req 6.1 + 6.2) ----------------------------------------

test('planPendingTurns produces one turn per Event, in queue order, with sendable text', async () => {
  const turns = await planPendingTurns(
    response([
      { id: 'q_1', type: 'order.shipped', payload: { orderId: 'o-1' }, receivedAt: 1 },
      { id: 'q_2', type: 'cart.item_added', payload: { sku: 'x' }, receivedAt: 2 },
    ]),
  );
  assert.equal(turns.length, 2);
  assert.deepEqual(
    turns.map((turn) => turn.event.id),
    ['q_1', 'q_2'],
  );
  for (const turn of turns) {
    assert.ok(turn.text.length > 0, 'every planned turn has non-empty text');
  }
});

test('planPendingTurns returns no turns for an empty queue (nothing to send on open)', async () => {
  const turns = await planPendingTurns(response([]));
  assert.deepEqual(turns, []);
});

// --- acknowledgePendingEvents (Task 8, Req 6.4, Property 5) -------------------

test('acknowledgePendingEvents POSTs the ids to the ack path on the member session', async () => {
  let calledUrl = '';
  let calledInit: RequestInit | undefined;
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    calledUrl = String(url);
    calledInit = init;
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  }) as unknown as typeof fetch;

  await acknowledgePendingEvents(['q_1', 'q_2'], fakeFetch);
  assert.equal(calledUrl, PENDING_ACK_PATH);
  assert.equal(calledInit?.method, 'POST');
  // Same-origin credentials = the member's own session (scoped to their queue).
  assert.equal(calledInit?.credentials, 'same-origin');
  assert.deepEqual(JSON.parse(String(calledInit?.body)), { ids: ['q_1', 'q_2'] });
});

test('acknowledgePendingEvents is a no-op when there are no valid ids (never calls fetch)', async () => {
  let called = false;
  const fakeFetch = (async () => {
    called = true;
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  }) as unknown as typeof fetch;

  await acknowledgePendingEvents([], fakeFetch);
  await acknowledgePendingEvents(['', '   '], fakeFetch);
  assert.equal(called, false, 'no request is made without a real id');
});

test('acknowledgePendingEvents throws when the backend returns a non-ok status', async () => {
  const fakeFetch = (async () =>
    ({ ok: false, status: 500, json: async () => ({}) }) as Response) as unknown as typeof fetch;
  await assert.rejects(() => acknowledgePendingEvents(['q_1'], fakeFetch), /HTTP 500/);
});

// --- Property 2 (support): the drain never introduces a non-member credential -
// Validates: Requirements 6.2, 7.1
//
// The whole open→drain→turn flow runs on the member's own session. The planned
// turn text is purely business context — it must never smuggle a token, service
// account, or "act as" hint into the turn (which would let a turn run as someone
// other than the member and break Property 2).

test('Property 2: planned turn text carries no credential/identity hint', async () => {
  const turns = await planPendingTurns(
    response([
      { id: 'q_1', type: 'order.shipped', payload: { orderId: 'o-1', member: 'member-1' }, receivedAt: 1 },
      { id: 'q_2', type: 'note', payload: 'A plain note', receivedAt: 2 },
    ]),
  );
  for (const turn of turns) {
    const text = turn.text.toLowerCase();
    assert.ok(!text.includes('bearer '), `turn leaked a bearer token: ${text}`);
    assert.ok(!text.includes('service account'), `turn leaked a service account: ${text}`);
    assert.ok(!text.includes('authorization:'), `turn leaked an auth header: ${text}`);
  }
});
