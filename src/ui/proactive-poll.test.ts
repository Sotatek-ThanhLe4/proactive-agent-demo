import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ACK_PATH,
  acknowledgeEvents,
  acknowledgedIds,
  fetchPoll,
  parsePollResponse,
  planProactiveTurns,
  POLL_PATH,
  type FetchLike,
  type PolledEvent,
  type PollResponseLike,
} from './proactive-poll.js';

function polled(id: string, overrides: Partial<PolledEvent> = {}): PolledEvent {
  return {
    id,
    type: 'order.shipped',
    timestamp: '2024-05-05T00:00:00.000Z',
    context: { text: `Event for ${id}` },
    ...overrides,
  };
}

// --- parsePollResponse -------------------------------------------------------

test('parsePollResponse returns the events with valid ids', () => {
  const body: PollResponseLike = { memberId: 'm', events: [polled('d_1'), polled('d_2')] };
  const events = parsePollResponse(body);
  assert.deepEqual(events.map((event) => event.id), ['d_1', 'd_2']);
});

test('parsePollResponse drops entries without a string id', () => {
  const body = {
    memberId: 'm',
    events: [polled('d_1'), { type: 'x', context: {} }, { id: '   ', context: {} }],
  } as unknown as PollResponseLike;
  const events = parsePollResponse(body);
  assert.deepEqual(events.map((event) => event.id), ['d_1']);
});

test('parsePollResponse tolerates missing / malformed bodies', () => {
  assert.deepEqual(parsePollResponse(undefined), []);
  assert.deepEqual(parsePollResponse({}), []);
  assert.deepEqual(parsePollResponse({ events: undefined }), []);
});

// --- planProactiveTurns ------------------------------------------------------

test('planProactiveTurns builds one turn per Event, preserving order (Req 4.2, 4.4)', () => {
  const events = [
    polled('d_1', { context: { text: 'first' } }),
    polled('d_2', { context: { text: 'second' } }),
  ];
  assert.deepEqual(planProactiveTurns(events), [
    { eventId: 'd_1', type: 'order.shipped', text: 'first' },
    { eventId: 'd_2', type: 'order.shipped', text: 'second' },
  ]);
});

test('planProactiveTurns serializes parts when Context has no text', () => {
  const events = [polled('d_1', { context: { parts: [{ kind: 'event', type: 'order.shipped' }] } })];
  const plans = planProactiveTurns(events);
  assert.equal(plans.length, 1);
  assert.equal(plans[0].eventId, 'd_1');
  assert.equal(plans[0].text, JSON.stringify([{ kind: 'event', type: 'order.shipped' }]));
});

test('planProactiveTurns skips Events with no sendable Context (never posts empty turn)', () => {
  const events = [
    polled('d_1', { context: {} }),
    polled('d_2', { context: { text: 'ok' } }),
  ];
  assert.deepEqual(planProactiveTurns(events), [
    { eventId: 'd_2', type: 'order.shipped', text: 'ok' },
  ]);
});

test('planProactiveTurns is deterministic', () => {
  const events = [polled('d_1'), polled('d_2')];
  assert.deepEqual(planProactiveTurns(events), planProactiveTurns(events));
});

// --- acknowledgedIds ---------------------------------------------------------

test('acknowledgedIds returns every delivered id so seen Events are not redelivered forever', () => {
  const events = [polled('d_1', { context: {} }), polled('d_2', { context: { text: 'ok' } })];
  assert.deepEqual(acknowledgedIds(events), ['d_1', 'd_2']);
});

test('acknowledgedIds tolerates an empty batch', () => {
  assert.deepEqual(acknowledgedIds([]), []);
});

// --- fetchPoll ---------------------------------------------------------------

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('fetchPoll GETs the poll path and parses the events (Req 9.1)', async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const stub: FetchLike = async (path, init) => {
    calls.push({ path, init });
    return jsonResponse({ memberId: 'm', events: [polled('d_1')] });
  };
  const events = await fetchPoll(stub);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, POLL_PATH);
  assert.equal(calls[0].init?.method, 'GET');
  assert.deepEqual(events.map((event) => event.id), ['d_1']);
});

test('fetchPoll throws on a non-ok response so the caller retries (Req 9.3)', async () => {
  const stub: FetchLike = async () => jsonResponse({}, 500);
  await assert.rejects(() => fetchPoll(stub), /HTTP 500/);
});

// --- acknowledgeEvents -------------------------------------------------------

test('acknowledgeEvents POSTs the ids to the ack path (Req 9.3)', async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const stub: FetchLike = async (path, init) => {
    calls.push({ path, init });
    return jsonResponse({ acknowledged: 2 });
  };
  await acknowledgeEvents(['d_1', 'd_2'], stub);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, ACK_PATH);
  assert.equal(calls[0].init?.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { ids: ['d_1', 'd_2'] });
});

test('acknowledgeEvents is a no-op for an empty id list (no request)', async () => {
  let called = false;
  const stub: FetchLike = async () => {
    called = true;
    return jsonResponse({});
  };
  await acknowledgeEvents([], stub);
  assert.equal(called, false, 'no ack request when there is nothing to acknowledge');
});

test('acknowledgeEvents throws on a non-ok response', async () => {
  const stub: FetchLike = async () => jsonResponse({}, 500);
  await assert.rejects(() => acknowledgeEvents(['d_1'], stub), /HTTP 500/);
});
