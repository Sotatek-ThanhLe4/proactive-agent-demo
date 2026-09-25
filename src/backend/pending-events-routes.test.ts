import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import express, { type RequestHandler } from 'express';
import { registerPendingEventsRoutes } from './pending-events-routes.js';
import { EventQueueStore } from './event-queue.js';
import type { PendingEventsResponse } from './pending-events.js';
import type { RoutedEvent } from './event-subject.js';

function makeEvent(memberId: string, overrides: Partial<RoutedEvent> = {}): RoutedEvent {
  return {
    type: 'order.shipped',
    subject: { memberId },
    // Use "now" so the Event is within the queue's default retention window.
    timestamp: new Date().toISOString(),
    data: { orderId: 'o-1' },
    ...overrides,
  };
}

/**
 * Fake auth middleware: reads the member id from the `x-test-member` header and
 * populates `response.locals.sota.sub` the way requireSotaInvocation would from
 * a verified token. Keeps the route testable without a real Core JWKS.
 */
const authenticate: RequestHandler = (request, response, next) => {
  const sub = request.header('x-test-member');
  response.locals.sota = sub ? { sub } : {};
  next();
};

function startApp() {
  const queue = new EventQueueStore();
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  registerPendingEventsRoutes(app, 'test-app', { queue, authenticate });
  const server = app.listen(0, '127.0.0.1');
  const closed = new Promise<void>((resolve) => server.on('close', () => resolve()));
  const ready = new Promise<void>((resolve) => server.on('listening', () => resolve()));
  return { queue, server, closed, ready };
}

const started = startApp();
await started.ready;
const port = (started.server.address() as AddressInfo).port;

after(() => {
  started.server.close();
  return started.closed;
});

async function getPending(member: string | undefined) {
  return fetch(`http://127.0.0.1:${port}/events/pending`, {
    headers: member ? { 'x-test-member': member } : {},
  });
}

async function ackPending(member: string | undefined, ids: unknown) {
  return fetch(`http://127.0.0.1:${port}/events/pending/ack`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(member ? { 'x-test-member': member } : {}),
    },
    body: JSON.stringify({ ids }),
  });
}

test('on open, returns the member pending Events oldest-first (Req 6.1)', async () => {
  const member = 'pending-member';
  started.queue.enqueue(makeEvent(member, { type: 'a' }));
  started.queue.enqueue(makeEvent(member, { type: 'b', data: { orderId: 'o-2' } }));

  const response = await getPending(member);
  assert.equal(response.status, 200);
  const body = (await response.json()) as PendingEventsResponse;
  assert.equal(body.memberId, member);
  assert.deepEqual(
    body.events.map((event) => event.type),
    ['a', 'b'],
  );
  assert.deepEqual(body.events[1]?.payload, { orderId: 'o-2' });
});

test('a member with no pending Events gets an empty list', async () => {
  const response = await getPending('empty-member');
  assert.equal(response.status, 200);
  const body = (await response.json()) as PendingEventsResponse;
  assert.deepEqual(body, { memberId: 'empty-member', events: [] });
});

test('retrieval does not mutate the queue — Events stay pending for Task 8 (Req 6.4 seam)', async () => {
  const member = 'noconsume-member';
  started.queue.enqueue(makeEvent(member));
  await getPending(member);
  await getPending(member);
  assert.equal(
    started.queue.pendingCount(member),
    1,
    'reading pending Events must not mark them processed',
  );
});

test('a request without a member identity is rejected 401', async () => {
  const response = await getPending(undefined);
  assert.equal(response.status, 401);
});

test('member identity comes from claims, not the body — one member cannot read another (Req 6.1 scoping)', async () => {
  const victim = 'victim-member';
  started.queue.enqueue(makeEvent(victim));

  // Attacker authenticates as themselves; their claims decide the member.
  const response = await getPending('attacker-member');
  const body = (await response.json()) as PendingEventsResponse;
  assert.equal(body.memberId, 'attacker-member');
  assert.equal(body.events.length, 0, 'attacker sees only their own queue');
  assert.equal(started.queue.pendingCount(victim), 1, "victim's Events untouched");
});

// --- POST /events/pending/ack (Task 8, Req 6.4, Property 5) -------------------

test('ack marks a drained Event processed so it is not returned on a later open (Req 6.4)', async () => {
  const member = 'ack-member';
  const queued = started.queue.enqueue(makeEvent(member));

  const ackResponse = await ackPending(member, [queued.id]);
  assert.equal(ackResponse.status, 200);
  const ackBody = (await ackResponse.json()) as { memberId: string; processed: number };
  assert.deepEqual(ackBody, { memberId: member, processed: 1 });

  // A later open no longer sees the processed Event.
  const pending = await getPending(member);
  const body = (await pending.json()) as PendingEventsResponse;
  assert.equal(body.events.length, 0, 'processed Event is not replayed');
  assert.equal(started.queue.pendingCount(member), 0);
});

test('acking an already-processed id is a harmless no-op (idempotent)', async () => {
  const member = 'ack-idempotent-member';
  const queued = started.queue.enqueue(makeEvent(member));

  const first = await ackPending(member, [queued.id]);
  assert.equal(((await first.json()) as { processed: number }).processed, 1);

  const second = await ackPending(member, [queued.id]);
  assert.equal(second.status, 200);
  assert.equal(
    ((await second.json()) as { processed: number }).processed,
    0,
    'a repeated ack marks nothing new but does not error',
  );
});

test('acking an unknown id is a harmless no-op', async () => {
  const member = 'ack-unknown-member';
  const response = await ackPending(member, ['does-not-exist']);
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as { processed: number }).processed, 0);
});

test('ack without a member identity is rejected 401', async () => {
  const response = await ackPending(undefined, ['q_1']);
  assert.equal(response.status, 401);
});

test('ack is scoped to claims — one member cannot mark another member Events processed', async () => {
  const victim = 'ack-victim';
  const queued = started.queue.enqueue(makeEvent(victim));

  // Attacker (authenticated as themselves) tries to ack the victim's Event id.
  const response = await ackPending('ack-attacker', [queued.id]);
  assert.equal(response.status, 200);
  assert.equal(
    ((await response.json()) as { processed: number }).processed,
    0,
    "attacker cannot reach the victim's queue",
  );
  assert.equal(started.queue.pendingCount(victim), 1, "victim's Event stays pending");
});

test('ack tolerates a missing/oddly-shaped ids field (marks nothing, no error)', async () => {
  const member = 'ack-badbody-member';
  started.queue.enqueue(makeEvent(member));
  for (const badIds of [undefined, 'not-an-array', [1, 2, 3], [''], [null]]) {
    const response = await ackPending(member, badIds);
    assert.equal(response.status, 200, `ids=${JSON.stringify(badIds)}`);
    assert.equal(((await response.json()) as { processed: number }).processed, 0);
  }
  assert.equal(started.queue.pendingCount(member), 1, 'no valid id → nothing marked');
});

// Property 5 (Không xử lý lại): a processed Event is marked and does not create
// another agent turn. We model an "agent turn" as an Event being RETURNED by
// GET /events/pending — that is the only thing that drives a turn on reopen.
// The property: for any set of enqueued Events, once the Surface acks the ones
// it drove, no reopen ever returns them again — regardless of how many times
// the member reopens or how the acks are batched/repeated.
//
// Validates: Requirements 6.4
test('Property 5: an acked Event never reappears across arbitrary reopen/ack sequences', async () => {
  // Deterministic pseudo-random driver so the generated scenarios are stable.
  let seed = 0x5eed;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;

  for (let scenario = 0; scenario < 60; scenario += 1) {
    const member = `prop5-member-${scenario}`;
    const eventCount = 1 + Math.floor(rand() * 5);
    const ids: string[] = [];
    for (let i = 0; i < eventCount; i += 1) {
      ids.push(started.queue.enqueue(makeEvent(member, { type: `t${i}` })).id);
    }

    // The Surface drives + acks a random non-empty subset of the drained Events.
    const drivenAndAcked = new Set<string>();
    for (const id of ids) {
      if (rand() < 0.7) drivenAndAcked.add(id);
    }
    // Ensure at least one is acked so the property has teeth.
    if (drivenAndAcked.size === 0) drivenAndAcked.add(pick(ids));

    // Ack them, occasionally re-acking to exercise idempotency.
    const ackList = [...drivenAndAcked];
    if (rand() < 0.5) ackList.push(...drivenAndAcked); // duplicate acks
    await ackPending(member, ackList);

    // Reopen an arbitrary number of times: an acked Event must never come back,
    // and an un-acked Event must still be available to drive.
    const reopens = 1 + Math.floor(rand() * 3);
    for (let r = 0; r < reopens; r += 1) {
      const pending = await getPending(member);
      const body = (await pending.json()) as PendingEventsResponse;
      const returned = new Set(body.events.map((event) => event.id));
      for (const acked of drivenAndAcked) {
        assert.ok(!returned.has(acked), `acked Event ${acked} was replayed (scenario ${scenario})`);
      }
      for (const id of ids) {
        if (!drivenAndAcked.has(id)) {
          assert.ok(returned.has(id), `un-acked Event ${id} went missing (scenario ${scenario})`);
        }
      }
    }
  }
});
