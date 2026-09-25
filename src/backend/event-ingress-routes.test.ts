import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { registerEventIngressRoutes } from './event-ingress-routes.js';
import type { RoutedEvent } from './event-subject.js';
import { signWebhookBody, WEBHOOK_SIGNATURE_HEADER } from './webhook-verify.js';

const secret = 'test-webhook-secret';

/**
 * Build a real express app wired exactly like server.ts (raw-body capture +
 * ingress route) and start it on an ephemeral port. `received` records the
 * events handed to `onEvent` so tests can assert routing without downstream.
 */
function startApp() {
  const received: RoutedEvent[] = [];
  const app = express();
  app.disable('x-powered-by');
  app.use(
    express.json({
      limit: '1mb',
      verify: (request, _response, buffer) => {
        (request as express.Request & { rawBody?: Buffer }).rawBody = Buffer.from(buffer);
      },
    }),
  );
  app.use((_request, response, next) => {
    response.setHeader('x-request-id', 'test-req');
    next();
  });
  registerEventIngressRoutes(app, {
    webhookSecret: secret,
    onEvent: (event) => {
      received.push(event);
    },
  });
  const server = app.listen(0, '127.0.0.1');
  const closed = new Promise<void>((resolve) => server.on('close', () => resolve()));
  const ready = new Promise<void>((resolve) => server.on('listening', () => resolve()));
  return { received, server, closed, ready };
}

async function post(port: number, rawBody: string, headers: Record<string, string>) {
  return fetch(`http://127.0.0.1:${port}/events/proactive`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: rawBody,
  });
}

const started = startApp();
await started.ready;
const port = (started.server.address() as AddressInfo).port;

after(() => {
  started.server.close();
  return started.closed;
});

test('accepts a verified event with a valid Subject (Req 2.1, 2.2)', async () => {
  const raw = JSON.stringify({ type: 'order.shipped', memberId: 'member-1', data: { orderId: 'o-1' } });
  const response = await post(port, raw, {
    [WEBHOOK_SIGNATURE_HEADER]: signWebhookBody(raw, secret),
  });
  assert.equal(response.status, 202);
  const body = (await response.json()) as { accepted: boolean; memberId: string };
  assert.equal(body.accepted, true);
  assert.equal(body.memberId, 'member-1');
  const last = started.received.at(-1);
  assert.equal(last?.subject.memberId, 'member-1');
  assert.deepEqual(last?.data, { orderId: 'o-1' });
});

test('rejects an unverified source with 401 and does not route (Req 2.1)', async () => {
  const before = started.received.length;
  const raw = JSON.stringify({ type: 'order.shipped', memberId: 'member-1' });
  const response = await post(port, raw, {
    [WEBHOOK_SIGNATURE_HEADER]: 'sha256=deadbeef',
  });
  assert.equal(response.status, 401);
  assert.equal(started.received.length, before, 'unverified event must not be routed');
});

test('rejects a missing signature with 401 (Req 2.1)', async () => {
  const raw = JSON.stringify({ type: 'order.shipped', memberId: 'member-1' });
  const response = await post(port, raw, {});
  assert.equal(response.status, 401);
});

test('rejects a verified event with no Subject with 422 and does not route (Req 2.3)', async () => {
  const before = started.received.length;
  const raw = JSON.stringify({ type: 'order.shipped' });
  const response = await post(port, raw, {
    [WEBHOOK_SIGNATURE_HEADER]: signWebhookBody(raw, secret),
  });
  assert.equal(response.status, 422);
  const body = (await response.json()) as { code: string };
  assert.equal(body.code, 'MISSING_SUBJECT');
  assert.equal(started.received.length, before, 'Subject-less event must not be routed');
});

test('verifies over the raw bytes so a tampered body after signing is rejected (Req 2.1)', async () => {
  const signedRaw = JSON.stringify({ type: 'order.shipped', memberId: 'member-1' });
  const signature = signWebhookBody(signedRaw, secret);
  const tamperedRaw = JSON.stringify({ type: 'order.shipped', memberId: 'attacker' });
  const response = await post(port, tamperedRaw, { [WEBHOOK_SIGNATURE_HEADER]: signature });
  assert.equal(response.status, 401);
});
