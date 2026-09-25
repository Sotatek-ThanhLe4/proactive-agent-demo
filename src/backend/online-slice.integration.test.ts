import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import express, { type RequestHandler } from 'express';
import { registerEventIngressRoutes } from './event-ingress-routes.js';
import { registerEventPollRoutes, type EventPollResponse } from './event-poll-routes.js';
import { OnlineDeliveryStore } from './online-delivery.js';
import { EventQueueStore } from './event-queue.js';
import { PresenceStateStore } from './presence-state.js';
import { createOfflineEventRouter } from './offline-routing.js';
import { signWebhookBody, WEBHOOK_SIGNATURE_HEADER } from './webhook-verify.js';
import {
  acknowledgedIds,
  parsePollResponse,
  planProactiveTurns,
} from '../ui/proactive-poll.js';
import { toTranscript, type MessageLike } from '../ui/proactive-chat.js';

/**
 * Task 5 — Integration test of the ONLINE vertical slice (Req 4.1–4.4).
 *
 * This wires the REAL backend pieces the way `server.ts` does — ingress route
 * (Task 3) → offline router (Task 6) with the ONLINE delivery seam (Task 4) →
 * poll routes (Task 4) over `OnlineDeliveryStore`/`PresenceStateStore` — plus
 * the PURE App_Surface helpers (`proactive-poll` + `proactive-chat`). Only two
 * seams are mocked, exactly the two things this test is not allowed to touch:
 *
 *   - Core's `POST /workspace-chat` — replaced by a local stub the "surface"
 *     calls with the member's session (no service account); its SSE-style reply
 *     is fed back through the same render model the browser surface uses.
 *   - the Core invocation-token auth on the poll routes — replaced by a header
 *     shim that reads the member id, the way `event-poll-routes.test.ts` does.
 *
 * The end-to-end assertion chain proves the online story:
 *   event → backend (ingress) → delivered on poll (Req 4.1) with loaded Context
 *   (Req 4.2) → surface plans a turn and "sends" it to workspace-chat WITHOUT
 *   the member typing (Req 4.4) → reply is rendered/available (Req 4.3) → ack so
 *   it is not re-delivered.
 */

const secret = 'online-slice-secret';

/** Fake Core auth: member id comes from a header, like event-poll-routes.test. */
const authenticate: RequestHandler = (request, response, next) => {
  const sub = request.header('x-test-member');
  response.locals.sota = sub ? { sub } : {};
  next();
};

/**
 * Mock of Core's `POST /workspace-chat`. Records the turn text and the fact that
 * it was called with the member's session (never a service account), then
 * returns an assistant reply the surface renders. Assembled as `MessageLike[]`
 * the way the host `useChatSession` hook yields messages.
 */
function makeWorkspaceChatMock() {
  const calls: Array<{ memberSession: string; text: string }> = [];
  async function workspaceChat(memberSession: string, userText: string): Promise<MessageLike[]> {
    calls.push({ memberSession, text: userText });
    return [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: userText }] },
      {
        id: 'a1',
        role: 'assistant',
        parts: [{ type: 'text', text: `Đã xử lý: ${userText}` }],
      },
    ];
  }
  return { calls, workspaceChat };
}

function startApp() {
  const presence = new PresenceStateStore({ ttlMs: 30_000 });
  const delivery = new OnlineDeliveryStore();
  const queue = new EventQueueStore();

  // Offline router with the ONLINE seam wired to the delivery buffer (Task 4):
  // an Event for an Online member is buffered for the Surface, NOT queued.
  const route = createOfflineEventRouter({
    presence,
    queue,
    onOnline: (event) => {
      delivery.buffer(event);
    },
  });

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
  registerEventPollRoutes(app, { presence, delivery, authenticate });

  const server = app.listen(0, '127.0.0.1');
  const closed = new Promise<void>((resolve) => server.on('close', () => resolve()));
  const ready = new Promise<void>((resolve) => server.on('listening', () => resolve()));
  return { presence, delivery, queue, server, closed, ready };
}

const started = startApp();
await started.ready;
const port = (started.server.address() as AddressInfo).port;

after(() => {
  started.server.close();
  return started.closed;
});

async function ingest(rawBody: string, headers: Record<string, string> = {}) {
  return fetch(`http://127.0.0.1:${port}/events/proactive`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: rawBody,
  });
}

async function poll(member: string) {
  return fetch(`http://127.0.0.1:${port}/events/poll`, {
    headers: { 'x-test-member': member },
  });
}

async function ack(member: string, ids: string[]) {
  return fetch(`http://127.0.0.1:${port}/events/ack`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-member': member },
    body: JSON.stringify({ ids }),
  });
}

test('online slice: event → poll delivery + context → workspace-chat turn → render → ack (Req 4.1–4.4)', async () => {
  const member = 'online-slice-member';
  const chat = makeWorkspaceChatMock();

  // The member has the App open → a poll marks them Online (heartbeat).
  const firstPoll = await poll(member);
  assert.equal(firstPoll.status, 200);
  assert.equal(started.presence.isOnline(member), true, 'poll heartbeat → Online');
  const firstBody = (await firstPoll.json()) as EventPollResponse;
  assert.equal(firstBody.events.length, 0, 'nothing waiting yet');

  // An Event for the ONLINE member arrives at the backend ingress (signed).
  const raw = JSON.stringify({
    type: 'order.shipped',
    memberId: member,
    data: { orderId: 'o-42' },
  });
  const ingestResponse = await ingest(raw, {
    [WEBHOOK_SIGNATURE_HEADER]: signWebhookBody(raw, secret),
  });
  assert.equal(ingestResponse.status, 202, 'verified Event accepted');

  // Req 4.1: because the member is Online it is delivered on poll, NOT queued.
  assert.equal(started.queue.pendingCount(member), 0, 'online Event is not queued');
  assert.equal(started.delivery.pendingCount(member), 1, 'online Event buffered for the Surface');

  // Surface polls again and receives the Event WITH loaded Context (Req 4.1, 4.2).
  const pollResponse = await poll(member);
  assert.equal(pollResponse.status, 200);
  const body = (await pollResponse.json()) as EventPollResponse;
  const delivered = parsePollResponse(body);
  assert.equal(delivered.length, 1, 'the Event is delivered on poll (Req 4.1)');
  assert.equal(delivered[0].type, 'order.shipped');
  assert.ok(
    delivered[0].context.text && delivered[0].context.text.length > 0,
    'Context is loaded so a turn can be sent without typing (Req 4.2)',
  );

  // Req 4.4: the surface plans a turn from the Context and "sends" it to
  // workspace-chat WITHOUT the member typing anything.
  const plans = planProactiveTurns(delivered);
  assert.equal(plans.length, 1, 'one proactive turn planned');
  assert.ok(plans[0].text.length > 0, 'turn text derived from Context, not member input');

  const memberSession = `session::${member}`; // member's own session, not a service account.
  const messages = await chat.workspaceChat(memberSession, plans[0].text);

  assert.equal(chat.calls.length, 1, 'workspace-chat called exactly once');
  assert.equal(chat.calls[0].memberSession, memberSession, 'called with the member session (Req 4.4 / Property 2)');
  assert.equal(chat.calls[0].text, plans[0].text, 'the planned proactive turn text was sent');

  // Req 4.3: the agent reply is rendered/available in the App transcript.
  const transcript = toTranscript(messages);
  const assistant = transcript.find((entry) => entry.role === 'assistant');
  assert.ok(assistant, 'an assistant reply is rendered (Req 4.3)');
  assert.match(assistant!.text, /Đã xử lý: /, 'the rendered reply reflects the proactive turn');

  // Ack the processed Event so it is not delivered again.
  const ackResponse = await ack(member, acknowledgedIds(delivered));
  assert.equal(ackResponse.status, 200);
  const ackBody = (await ackResponse.json()) as { acknowledged: number };
  assert.equal(ackBody.acknowledged, 1);
  assert.equal(started.delivery.pendingCount(member), 0, 'acked Event removed');

  // A subsequent poll delivers nothing and drives no further turn.
  const afterAck = await poll(member);
  const afterBody = (await afterAck.json()) as EventPollResponse;
  assert.equal(parsePollResponse(afterBody).length, 0, 'acked Event not re-delivered');
  assert.equal(chat.calls.length, 1, 'no extra workspace-chat turn after ack');
});

test('online slice: an unacknowledged Event is re-delivered on the next poll (Req 4.1 reliability)', async () => {
  const member = 'online-slice-retry';

  // Mark Online via a heartbeat poll, then ingest a signed Event.
  await poll(member);
  const raw = JSON.stringify({ type: 'cart.abandoned', memberId: member, data: { cartId: 'c-1' } });
  await ingest(raw, { [WEBHOOK_SIGNATURE_HEADER]: signWebhookBody(raw, secret) });

  // First poll delivers it but the surface never acks (e.g. the turn failed).
  const first = parsePollResponse((await (await poll(member)).json()) as EventPollResponse);
  assert.equal(first.length, 1);

  // Next poll re-delivers the same Event so nothing is lost.
  const second = parsePollResponse((await (await poll(member)).json()) as EventPollResponse);
  assert.equal(second.length, 1, 'unacked Event redelivered');
  assert.equal(second[0].id, first[0].id, 'same Event id redelivered for dedupe');
});
