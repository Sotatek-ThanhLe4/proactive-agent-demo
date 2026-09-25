import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import express, { type RequestHandler } from 'express';
import { registerEventPollRoutes, type EventPollResponse } from './event-poll-routes.js';
import { OnlineDeliveryStore } from './online-delivery.js';
import { PresenceStateStore } from './presence-state.js';
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

/**
 * Fake auth middleware: reads the member id from the `x-test-member` header and
 * populates `response.locals.sota.sub` the way requireSotaInvocation would from
 * a verified token. Keeps the routes testable without a real Core JWKS.
 */
const authenticate: RequestHandler = (request, response, next) => {
  const sub = request.header('x-test-member');
  response.locals.sota = sub ? { sub } : {};
  next();
};

function startApp() {
  const presence = new PresenceStateStore({ ttlMs: 30_000 });
  const delivery = new OnlineDeliveryStore();
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  registerEventPollRoutes(app, { presence, delivery, authenticate });
  const server = app.listen(0, '127.0.0.1');
  const closed = new Promise<void>((resolve) => server.on('close', () => resolve()));
  const ready = new Promise<void>((resolve) => server.on('listening', () => resolve()));
  return { presence, delivery, server, closed, ready };
}

const started = startApp();
await started.ready;
const port = (started.server.address() as AddressInfo).port;

after(() => {
  started.server.close();
  return started.closed;
});

async function poll(member: string | undefined) {
  return fetch(`http://127.0.0.1:${port}/events/poll`, {
    headers: member ? { 'x-test-member': member } : {},
  });
}

async function ack(member: string, ids: string[]) {
  return fetch(`http://127.0.0.1:${port}/events/ack`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-member': member },
    body: JSON.stringify({ ids }),
  });
}

test('polling marks the member Online (Req 4.1)', async () => {
  const member = 'poll-member-online';
  assert.equal(started.presence.isOnline(member), false);
  const response = await poll(member);
  assert.equal(response.status, 200);
  assert.equal(started.presence.isOnline(member), true, 'a poll is a heartbeat → Online');
});

test('poll returns buffered Events with loaded Context for a proactive turn (Req 4.2, 9.1)', async () => {
  const member = 'poll-member-events';
  started.delivery.buffer(makeEvent(member, { type: 'order.shipped', data: { orderId: 'o-9' } }));

  const response = await poll(member);
  assert.equal(response.status, 200);
  const body = (await response.json()) as EventPollResponse;
  assert.equal(body.memberId, member);
  assert.equal(body.events.length, 1);
  const event = body.events[0];
  assert.equal(event.type, 'order.shipped');
  // Context is loaded so the Surface can send a turn WITHOUT the member typing.
  assert.ok(event.context.text && event.context.text.length > 0, 'Context text present');
});

test('poll leaves Events pending until acknowledged (Req 9.3)', async () => {
  const member = 'poll-member-pending';
  started.delivery.buffer(makeEvent(member));

  await poll(member);
  assert.equal(started.delivery.pendingCount(member), 1, 'poll is a peek, not a pop');

  const second = await poll(member);
  const body = (await second.json()) as EventPollResponse;
  assert.equal(body.events.length, 1, 'unacknowledged Event redelivered on next poll');
});

test('ack removes the processed Events (Req 9.3)', async () => {
  const member = 'poll-member-ack';
  const a = started.delivery.buffer(makeEvent(member, { type: 'a' }));
  const b = started.delivery.buffer(makeEvent(member, { type: 'b' }));

  const response = await ack(member, [a.id]);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { acknowledged: number };
  assert.equal(body.acknowledged, 1);
  assert.equal(started.delivery.pendingCount(member), 1);

  const remaining = started.delivery.poll(member);
  assert.equal(remaining[0].id, b.id);
});

test('poll without a member identity is rejected 401', async () => {
  const response = await poll(undefined);
  assert.equal(response.status, 401);
});

test('member identity comes from claims, not the body — one member cannot poll another', async () => {
  const victim = 'victim-member';
  started.delivery.buffer(makeEvent(victim));
  // Attacker authenticates as themselves; their claims decide the member.
  const response = await poll('attacker-member');
  const body = (await response.json()) as EventPollResponse;
  assert.equal(body.memberId, 'attacker-member');
  assert.equal(body.events.length, 0, 'attacker sees only their own Events');
  assert.equal(started.delivery.pendingCount(victim), 1, "victim's Events untouched");
});
