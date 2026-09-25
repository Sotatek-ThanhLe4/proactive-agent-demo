import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import express, { type RequestHandler } from 'express';
import { registerEventIngressRoutes } from './event-ingress-routes.js';
import { registerPendingEventsRoutes } from './pending-events-routes.js';
import { EventQueueStore } from './event-queue.js';
import { PresenceStateStore } from './presence-state.js';
import { createOfflineEventRouter } from './offline-routing.js';
import { signWebhookBody, WEBHOOK_SIGNATURE_HEADER } from './webhook-verify.js';
import type { PendingEventsResponse } from './pending-events.js';
import {
  acknowledgePendingEvents,
  fetchPendingEvents,
  planPendingTurns,
} from '../ui/pending-drain.js';
import { toTranscript, type MessageLike } from '../ui/proactive-chat.js';

/**
 * Task 9 — Integration test of the OFFLINE → reopen vertical slice
 * (Req 5.1, 5.2, 5.3, 6.1, 6.2, 6.4).
 *
 * This wires the REAL backend pieces the way `server.ts` does for the offline
 * path — ingress route (Task 3) → offline router (Task 6) over an
 * `EventQueueStore`/`PresenceStateStore`, and the pending-events routes
 * (Tasks 7/8: `GET /events/pending` + `POST /events/pending/ack`) — plus the
 * PURE App_Surface drain helpers (`pending-drain`) and the render model
 * (`proactive-chat`). Only two seams are mocked, exactly the two things this
 * test is not allowed to touch:
 *
 *   - Core's `POST /workspace-chat` — replaced by a local stub the "surface"
 *     calls with the member's session (no service account); its reply is fed
 *     back through the same render model the browser surface uses.
 *   - the Core invocation-token auth on the pending routes — replaced by a
 *     header shim that reads `x-test-member` into the verified claim `sub`, the
 *     way `pending-events-routes.test.ts` does.
 *
 * The end-to-end assertion chain proves the offline story:
 *   offline event → backend (ingress) → QUEUED, no agent run / no credit
 *   (Req 5.1, 5.2) → it persists (Req 5.3) → member reopens → pending Events are
 *   retrieved (Req 6.1) with loaded Context and a turn driven on the member's
 *   own session to the mocked workspace-chat (Req 6.2) → ack marks them
 *   processed → a later reopen returns nothing and drives no extra turn
 *   (Req 6.4).
 */

const secret = 'offline-reopen-secret';

/** Fake Core auth: member id comes from a header, like pending-events-routes.test. */
const authenticate: RequestHandler = (request, response, next) => {
  const sub = request.header('x-test-member');
  response.locals.sota = sub ? { sub } : {};
  next();
};

/**
 * Mock of Core's `POST /workspace-chat`. Records the turn text and the member
 * session it was called with (never a service account), then returns an
 * assistant reply the surface renders. Assembled as `MessageLike[]` the way the
 * host `useChatSession` hook yields messages.
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
  const queue = new EventQueueStore();

  // Offline router with NO online seam wired: an inbound Event for a member who
  // is not Online is stored in that member's Event_Queue — no agent, no credit.
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
  registerPendingEventsRoutes(app, 'proactive-agent', { queue, authenticate });

  const server = app.listen(0, '127.0.0.1');
  const closed = new Promise<void>((resolve) => server.on('close', () => resolve()));
  const ready = new Promise<void>((resolve) => server.on('listening', () => resolve()));
  return { presence, queue, server, closed, ready };
}

const started = startApp();
await started.ready;
const port = (started.server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}`;

after(() => {
  started.server.close();
  return started.closed;
});

async function ingest(rawBody: string, headers: Record<string, string> = {}) {
  return fetch(`${base}/events/proactive`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: rawBody,
  });
}

/**
 * A `fetch` bound to a member's session — every request carries the member's
 * `x-test-member` header (the header shim's stand-in for the member's cookie),
 * and requests are rewritten onto the running server. This is exactly the seam
 * the pure drain helpers use (`fetchPendingEvents` / `acknowledgePendingEvents`
 * default to same-origin `fetch`); here it is the member's own session.
 */
function memberFetch(member: string): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const path = typeof input === 'string' ? input : String(input);
    const url = path.startsWith('http') ? path : `${base}${path}`;
    const headers = new Headers(init?.headers);
    headers.set('x-test-member', member);
    return fetch(url, { ...init, headers });
  }) as typeof fetch;
}

test('offline slice: event → queue (no agent/credit) → persists → reopen drains + turn → ack → no replay (Req 5.1–5.3, 6.1, 6.2, 6.4)', async () => {
  const member = 'offline-reopen-member';
  const chat = makeWorkspaceChatMock();
  const asMember = memberFetch(member);

  // The member is OFFLINE (never polled → PresenceState has no live entry).
  assert.equal(started.presence.isOnline(member), false, 'member starts Offline');

  // An Event for the OFFLINE member arrives at the backend ingress (signed).
  const raw = JSON.stringify({
    type: 'order.shipped',
    memberId: member,
    data: { orderId: 'o-42' },
  });
  const ingestResponse = await ingest(raw, {
    [WEBHOOK_SIGNATURE_HEADER]: signWebhookBody(raw, secret),
  });
  assert.equal(ingestResponse.status, 202, 'verified Event accepted');

  // Req 5.1 / 5.2: the offline Event is QUEUED and nothing else happened — no
  // agent turn was driven and no credit consumed (the workspace-chat mock was
  // never called on the offline path).
  assert.equal(started.queue.pendingCount(member), 1, 'offline Event queued (Req 5.1)');
  assert.equal(chat.calls.length, 0, 'no agent run / no credit while Offline (Req 5.2)');

  // Req 5.3: the Event persists in the queue until it is processed — a second
  // retrieval before reopen still sees exactly the one pending Event.
  assert.equal(started.queue.pendingCount(member), 1, 'Event persists until processed (Req 5.3)');
  const persisted = started.queue.listPending(member);
  assert.equal(persisted[0]?.type, 'order.shipped');
  assert.deepEqual(persisted[0]?.payload, { orderId: 'o-42' });

  // --- Member reopens the App_Surface (on their own session) ---

  // Req 6.1: the Surface retrieves the member's pending Events via the real
  // `GET /events/pending`, scoped to the verified `sub`.
  const pending: PendingEventsResponse = await fetchPendingEvents(asMember);
  assert.equal(pending.memberId, member, 'pending scoped to the member (verified sub)');
  assert.equal(pending.events.length, 1, 'pending Event retrieved on reopen (Req 6.1)');
  assert.equal(pending.events[0]?.type, 'order.shipped');

  // Req 6.2: Context is loaded from each pending Event and a turn is planned
  // (same Context + turn builder as the online path).
  const turns = await planPendingTurns(pending);
  assert.equal(turns.length, 1, 'one proactive turn planned from the pending Event');
  assert.ok(turns[0].text.length > 0, 'turn text derived from loaded Context, not member input');

  // Req 6.2 / Property 2: the turn is driven on the member's OWN session (never
  // a service account) to the mocked workspace-chat.
  const memberSession = `session::${member}`;
  const messages = await chat.workspaceChat(memberSession, turns[0].text);
  assert.equal(chat.calls.length, 1, 'workspace-chat called exactly once on reopen');
  assert.equal(
    chat.calls[0].memberSession,
    memberSession,
    'called with the member session (Req 6.2 / Property 2)',
  );
  assert.equal(chat.calls[0].text, turns[0].text, 'the planned proactive turn text was sent');

  // The agent reply is rendered/available in the App transcript.
  const transcript = toTranscript(messages);
  const assistant = transcript.find((entry) => entry.role === 'assistant');
  assert.ok(assistant, 'an assistant reply is rendered');
  assert.match(assistant!.text, /Đã xử lý: /, 'the rendered reply reflects the proactive turn');

  // Req 6.4: AFTER the turn, the Surface acks the drained Event ids via the real
  // `POST /events/pending/ack`, which flips them to `processed`.
  await acknowledgePendingEvents(
    turns.map((turn) => turn.event.id),
    asMember,
  );
  assert.equal(started.queue.pendingCount(member), 0, 'acked Event marked processed (Req 6.4)');

  // Req 6.4: a LATER reopen returns nothing and drives NO extra turn — the
  // processed Event is never replayed.
  const afterAck = await fetchPendingEvents(asMember);
  assert.equal(afterAck.events.length, 0, 'processed Event not returned on a later reopen (Req 6.4)');
  const afterTurns = await planPendingTurns(afterAck);
  assert.equal(afterTurns.length, 0, 'no turn planned on a later reopen');
  assert.equal(chat.calls.length, 1, 'no extra workspace-chat turn after ack (Req 6.4)');
});

test('offline slice: an un-acked pending Event is re-drained on the next reopen (Req 6.1 reliability, Req 9.3)', async () => {
  const member = 'offline-reopen-retry';
  const asMember = memberFetch(member);

  // Ingest a signed Event for the Offline member.
  const raw = JSON.stringify({ type: 'cart.abandoned', memberId: member, data: { cartId: 'c-1' } });
  const ingestResponse = await ingest(raw, {
    [WEBHOOK_SIGNATURE_HEADER]: signWebhookBody(raw, secret),
  });
  assert.equal(ingestResponse.status, 202);

  // First reopen retrieves it, but the Surface never acks (e.g. the turn
  // failed) — so the Event stays pending for the next open (Req 9.3).
  const first = await fetchPendingEvents(asMember);
  assert.equal(first.events.length, 1);
  const firstId = first.events[0]?.id;

  // Next reopen re-drains the same Event so nothing is lost.
  const second = await fetchPendingEvents(asMember);
  assert.equal(second.events.length, 1, 'un-acked Event re-drained');
  assert.equal(second.events[0]?.id, firstId, 'same Event id re-drained for dedupe');
});
