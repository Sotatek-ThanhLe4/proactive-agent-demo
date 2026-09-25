import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { registerEventIngressRoutes } from './event-ingress-routes.js';
import { EventQueueStore } from './event-queue.js';
import { PresenceStateStore } from './presence-state.js';
import { createOfflineEventRouter } from './offline-routing.js';
import { signWebhookBody, WEBHOOK_SIGNATURE_HEADER } from './webhook-verify.js';

const secret = 'test-webhook-secret';

/**
 * Wire the ingress route (Task 3) to the offline router (Task 6) exactly like
 * server.ts, and start it on an ephemeral port. This proves an inbound Event
 * for an Offline member is stored in that member's Event_Queue end-to-end,
 * with no agent turn / credit (Property 3, 4).
 */
function startApp() {
  const presence = new PresenceStateStore();
  const queue = new EventQueueStore();
  const route = createOfflineEventRouter({ presence, queue });

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
  registerEventIngressRoutes(app, {
    webhookSecret: secret,
    onEvent: async (event) => {
      await route(event);
    },
  });
  const server = app.listen(0, '127.0.0.1');
  const closed = new Promise<void>((resolve) => server.on('close', () => resolve()));
  const ready = new Promise<void>((resolve) => server.on('listening', () => resolve()));
  return { presence, queue, server, closed, ready };
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

test('offline member: verified Event is accepted (202) and queued (Req 5.1)', async () => {
  const raw = JSON.stringify({ type: 'order.shipped', memberId: 'offline-member', data: { orderId: 'o-9' } });
  const response = await post(port, raw, { [WEBHOOK_SIGNATURE_HEADER]: signWebhookBody(raw, secret) });
  assert.equal(response.status, 202);

  const pending = started.queue.listPending('offline-member');
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.type, 'order.shipped');
  assert.deepEqual(pending[0]?.payload, { orderId: 'o-9' });
});

test('unverified / Subject-less Events are not queued (Req 2.1, 2.3)', async () => {
  const before = started.queue.pendingCount('offline-member');

  // Unverified source.
  const bad = JSON.stringify({ type: 'order.shipped', memberId: 'offline-member' });
  const r1 = await post(port, bad, { [WEBHOOK_SIGNATURE_HEADER]: 'sha256=deadbeef' });
  assert.equal(r1.status, 401);

  // Verified but no Subject.
  const noSubject = JSON.stringify({ type: 'order.shipped' });
  const r2 = await post(port, noSubject, { [WEBHOOK_SIGNATURE_HEADER]: signWebhookBody(noSubject, secret) });
  assert.equal(r2.status, 422);

  assert.equal(started.queue.pendingCount('offline-member'), before, 'rejected Events never queued');
});
