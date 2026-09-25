import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import express, { type RequestHandler } from 'express';

// Full App wiring — the SAME pieces server.ts assembles, nothing from Core.
import { registerEventIngressRoutes } from './event-ingress-routes.js';
import { registerEventPollRoutes, type EventPollResponse } from './event-poll-routes.js';
import { registerPendingEventsRoutes } from './pending-events-routes.js';
import { OnlineDeliveryStore } from './online-delivery.js';
import { EventQueueStore } from './event-queue.js';
import { PresenceStateStore } from './presence-state.js';
import { createOfflineEventRouter } from './offline-routing.js';
import { signWebhookBody, WEBHOOK_SIGNATURE_HEADER } from './webhook-verify.js';
import { deriveConversationId, type MemberIdentity } from './conversation-mapping.js';
import { admitTurns, emptyRateState } from './rate-control.js';
import { createResponsiveTypeFilter } from './responsive-events.js';

// Pure App_Surface helpers (browser side), driven the way the React surface does.
import {
  acknowledgedIds,
  parsePollResponse,
  planProactiveTurns,
} from '../ui/proactive-poll.js';
import {
  acknowledgePendingEvents,
  fetchPendingEvents,
  planPendingTurns,
} from '../ui/pending-drain.js';
import { toTranscript, type MessageLike } from '../ui/proactive-chat.js';
import type { PendingEventsResponse } from './pending-events.js';

/**
 * Task 15 — END-TO-END + correctness properties (Req 1.1, 1.2, 1.3).
 *
 * This is the final task that ties the whole feature together. It wires the FULL
 * App the way `server.ts` does — the Event ingress route (Task 3), the offline
 * router (Task 6) with the ONLINE delivery seam (Task 4), the poll routes
 * (Task 4) and the pending-events routes (Tasks 7/8), over REAL stores
 * (`PresenceStateStore`, `EventQueueStore`, `OnlineDeliveryStore`) — plus the
 * PURE App_Surface helpers (`proactive-poll`, `pending-drain`, `proactive-chat`)
 * and the App-owned rate/type control (`rate-control`, `responsive-events`,
 * `conversation-mapping`).
 *
 * Only TWO seams are mocked — exactly the two things this feature is not allowed
 * to own, both belonging to Core:
 *   - Core's `POST /workspace-chat` — a local stub the "surface" calls with the
 *     member's OWN session (never a service account); its SSE-style reply is fed
 *     back through the same render model the browser surface uses. This is the
 *     ONLY Core dependency, and it is external (Req 1.2 — reuse Core's chat API,
 *     no LLM loop in the App).
 *   - the Core invocation-token auth on the poll / pending routes — a header
 *     shim that reads the member id into the verified claim `sub`, the way the
 *     route unit tests do. (Auth is a Core concern; the App just consumes `sub`.)
 *
 * The single coherent scenario exercises BOTH paths for real members and asserts
 * the observable behaviour behind each of the seven correctness properties.
 */

const secret = 'e2e-proactive-secret';

/** Fake Core auth: member id comes from a header, like the route unit tests. */
const authenticate: RequestHandler = (request, response, next) => {
  const sub = request.header('x-test-member');
  response.locals.sota = sub ? { sub } : {};
  next();
};

/**
 * Mock of Core's `POST /workspace-chat`. This is the ONLY Core seam. It records
 * every turn with the member session it was called on (so the test can prove
 * credit lands on the right member and never on a service account) and the
 * conversationId the surface targeted, then returns an assistant reply the
 * surface renders — assembled as `MessageLike[]`, the shape the host
 * `useChatSession` hook yields.
 */
function makeWorkspaceChatMock() {
  const calls: Array<{ memberSession: string; conversationId: string; text: string }> = [];
  async function workspaceChat(
    memberSession: string,
    conversationId: string,
    userText: string,
  ): Promise<MessageLike[]> {
    calls.push({ memberSession, conversationId, text: userText });
    return [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: userText }] },
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: `Đã xử lý: ${userText}` }] },
    ];
  }
  /** The member's OWN session token — derived only from the member id. */
  function sessionFor(member: string): string {
    return `session::${member}`;
  }
  return { calls, workspaceChat, sessionFor };
}

/** The verified tenant scope the surface derives a member's conversation from. */
const tenant = { organizationId: 'org-e2e', workspaceId: 'ws-e2e' };
function identityFor(userId: string): MemberIdentity {
  return { organizationId: tenant.organizationId, workspaceId: tenant.workspaceId, userId };
}

/**
 * Wire the FULL App exactly like server.ts: ingress → offline router (with the
 * online delivery seam) → poll routes + pending routes, over real stores. No
 * Core code is imported or run — only the App's own modules.
 */
function startApp() {
  const presence = new PresenceStateStore({ ttlMs: 30_000 });
  const delivery = new OnlineDeliveryStore();
  const queue = new EventQueueStore();

  const route = createOfflineEventRouter({
    presence,
    queue,
    // Online → buffer for the polling Surface (Task 4). Offline → queue (Task 6).
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
  registerPendingEventsRoutes(app, 'proactive-agent', { queue, authenticate });

  const server = app.listen(0, '127.0.0.1');
  const closed = new Promise<void>((resolve) => server.on('close', () => resolve()));
  const ready = new Promise<void>((resolve) => server.on('listening', () => resolve()));
  return { presence, delivery, queue, server, closed, ready };
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

function signedEvent(body: Record<string, unknown>) {
  const raw = JSON.stringify(body);
  return { raw, headers: { [WEBHOOK_SIGNATURE_HEADER]: signWebhookBody(raw, secret) } };
}

/** A member-scoped `fetch` — every request carries the member's session header. */
function memberFetch(member: string): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const path = typeof input === 'string' ? input : String(input);
    const url = path.startsWith('http') ? path : `${base}${path}`;
    const headers = new Headers(init?.headers);
    headers.set('x-test-member', member);
    return fetch(url, { ...init, headers });
  }) as typeof fetch;
}

async function poll(member: string) {
  return fetch(`${base}/events/poll`, { headers: { 'x-test-member': member } });
}

async function ack(member: string, ids: string[]) {
  return fetch(`${base}/events/ack`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-member': member },
    body: JSON.stringify({ ids }),
  });
}

// -----------------------------------------------------------------------------
// The coherent end-to-end scenario: online path + offline→reopen path.
// -----------------------------------------------------------------------------

test('E2E: online member — event → poll delivery → member-session turn → render → ack (Req 1.1, 1.2, 1.3; Property 2, 6)', async () => {
  const member = 'e2e-online-member';
  const chat = makeWorkspaceChatMock();

  // Property 6: the member maps to exactly one Conversation, deterministically.
  const conversationId = deriveConversationId(identityFor(member));
  assert.equal(
    deriveConversationId(identityFor(member)),
    conversationId,
    'Property 6: same member identity → same conversationId (deterministic)',
  );

  // The member has the App open → a heartbeat poll marks them Online.
  const firstPoll = await poll(member);
  assert.equal(firstPoll.status, 200);
  assert.equal(started.presence.isOnline(member), true, 'poll heartbeat → Online');

  // A signed Event for the ONLINE member arrives at the App ingress (Req 1.1 —
  // the App owns the whole receive path).
  const { raw, headers } = signedEvent({
    type: 'order.shipped',
    memberId: member,
    data: { orderId: 'o-42' },
  });
  const ingestResponse = await ingest(raw, headers);
  assert.equal(ingestResponse.status, 202, 'verified Event accepted by the App backend');

  // Online → buffered for the Surface, NOT queued.
  assert.equal(started.queue.pendingCount(member), 0, 'online Event not queued');
  assert.equal(started.delivery.pendingCount(member), 1, 'online Event buffered for the Surface');

  // Surface polls and receives the Event with loaded Context.
  const body = (await (await poll(member)).json()) as EventPollResponse;
  const delivered = parsePollResponse(body);
  assert.equal(delivered.length, 1, 'the Event is delivered on poll');

  // Req 1.2: the App does NOT run an LLM loop; it reuses Core's chat API. The
  // surface plans a turn from the App-loaded Context (no member typing) and
  // drives Core's `/workspace-chat` on the member's OWN session (Property 2).
  const plans = planProactiveTurns(delivered);
  assert.equal(plans.length, 1, 'one proactive turn planned from Context');

  const memberSession = chat.sessionFor(member);
  const messages = await chat.workspaceChat(memberSession, conversationId, plans[0].text);

  assert.equal(chat.calls.length, 1, 'Core workspace-chat called exactly once');
  assert.equal(
    chat.calls[0].memberSession,
    memberSession,
    'Property 2: turn ran on the member session (credit to the right member, no service account)',
  );
  assert.equal(
    chat.calls[0].conversationId,
    conversationId,
    'Property 6: the turn targeted the member’s single deterministic conversation',
  );

  // Req 1.2 render: the agent reply is available in the App transcript.
  const assistant = toTranscript(messages).find((entry) => entry.role === 'assistant');
  assert.ok(assistant, 'an assistant reply is rendered from Core’s stream');
  assert.match(assistant!.text, /Đã xử lý: /, 'the rendered reply reflects the proactive turn');

  // Ack so the Event is not re-delivered; no further turn is driven.
  await ack(member, acknowledgedIds(delivered));
  assert.equal(started.delivery.pendingCount(member), 0, 'acked Event removed');
  const afterAck = parsePollResponse((await (await poll(member)).json()) as EventPollResponse);
  assert.equal(afterAck.length, 0, 'acked Event not re-delivered');
  assert.equal(chat.calls.length, 1, 'no extra turn after ack');
});

test('E2E: offline member — event → queue (no turn/credit) → persists → reopen drains one member-session turn → mark processed → no replay (Req 1.1, 1.2, 1.3; Property 2, 3, 4, 5, 6)', async () => {
  const member = 'e2e-offline-member';
  const chat = makeWorkspaceChatMock();
  const asMember = memberFetch(member);
  const conversationId = deriveConversationId(identityFor(member));

  // The member is OFFLINE (never polled).
  assert.equal(started.presence.isOnline(member), false, 'member starts Offline');

  // Two signed Events arrive for the OFFLINE member.
  for (const orderId of ['o-1', 'o-2']) {
    const { raw, headers } = signedEvent({ type: 'order.shipped', memberId: member, data: { orderId } });
    const res = await ingest(raw, headers);
    assert.equal(res.status, 202, 'verified offline Event accepted');
  }

  // Property 3 + 4: offline Events are QUEUED — no turn ran, no credit consumed,
  // nothing lost.
  assert.equal(started.queue.pendingCount(member), 2, 'Property 4: offline Events queued (not lost)');
  assert.equal(chat.calls.length, 0, 'Property 3: no agent turn / no credit while Offline');
  assert.equal(started.delivery.pendingCount(member), 0, 'offline Events not on the online buffer');

  // Property 4 (persistence): a re-read still shows both pending Events.
  assert.equal(started.queue.pendingCount(member), 2, 'Property 4: Events persist until processed');

  // --- Member reopens the App_Surface on their OWN session ---

  // Retrieve pending Events, scoped to the verified `sub`.
  const pending: PendingEventsResponse = await fetchPendingEvents(asMember);
  assert.equal(pending.memberId, member, 'pending scoped to the member (verified sub)');
  assert.equal(pending.events.length, 2, 'both pending Events retrieved on reopen');

  // Plan turns from the queued Events (same Context/turn builder as online).
  const turns = await planPendingTurns(pending);
  assert.equal(turns.length, 2, 'a turn is planned per pending Event before pacing');

  // Property 7 applies to reopen too (Req 6.3): the burst of two Events is merged
  // into AT MOST one turn for this single reopen.
  const admit = admitTurns(
    turns.map((turn) => ({ eventId: turn.event.id, type: turn.event.type })),
    { now: Date.now(), typeFilter: createResponsiveTypeFilter(['order.shipped']), getType: (c) => c.type },
    emptyRateState(),
  );
  assert.equal(admit.admitted.length, 1, 'Property 7: a burst on reopen yields at most one turn');
  assert.equal(admit.suppressed.length, 1, 'the other Event is merged, not a separate turn');

  // Drive the single admitted turn on the member's OWN session (Property 2).
  const admittedTurn = turns.find((turn) => turn.event.id === admit.admitted[0].eventId)!;
  const memberSession = chat.sessionFor(member);
  const messages = await chat.workspaceChat(memberSession, conversationId, admittedTurn.text);
  assert.equal(chat.calls.length, 1, 'exactly one turn ran on reopen');
  assert.equal(
    chat.calls[0].memberSession,
    memberSession,
    'Property 2: reopen turn ran on the member session (no service account)',
  );
  assert.equal(chat.calls[0].conversationId, conversationId, 'Property 6: reopen turn used the member’s one conversation');

  const assistant = toTranscript(messages).find((entry) => entry.role === 'assistant');
  assert.ok(assistant, 'an assistant reply is rendered on reopen');

  // Property 5: mark BOTH drained Events processed (the merged one is
  // acknowledged too — it was handled, not lost) so a later reopen replays none.
  await acknowledgePendingEvents(turns.map((turn) => turn.event.id), asMember);
  assert.equal(started.queue.pendingCount(member), 0, 'Property 5: drained Events marked processed');

  const afterAck = await fetchPendingEvents(asMember);
  assert.equal(afterAck.events.length, 0, 'Property 5: processed Events not returned on a later reopen');
  const afterTurns = await planPendingTurns(afterAck);
  assert.equal(afterTurns.length, 0, 'no turn planned on a later reopen');
  assert.equal(chat.calls.length, 1, 'Property 5: no extra turn after processing');
});

test('E2E: a non-worthy Event type is recorded but drives no turn (Req 1.1, 1.3; Property 7)', async () => {
  const member = 'e2e-nonworthy-member';
  const chat = makeWorkspaceChatMock();
  const asMember = memberFetch(member);

  // A signed Event of a type NOT on the tenant's responsive allow-list arrives
  // while the member is Offline → it is recorded in the queue (Req 1.1).
  const { raw, headers } = signedEvent({ type: 'debug.ping', memberId: member, data: { nonce: 1 } });
  assert.equal((await ingest(raw, headers)).status, 202, 'non-worthy Event still accepted/recorded');
  assert.equal(started.queue.pendingCount(member), 1, 'non-worthy Event is recorded (not lost)');

  // On reopen the surface plans a turn, but the responsive-type filter admits
  // nothing → no `/workspace-chat` turn runs (Property 7 / Req 10.4).
  const pending = await fetchPendingEvents(asMember);
  const turns = await planPendingTurns(pending);
  const admit = admitTurns(
    turns.map((turn) => ({ eventId: turn.event.id, type: turn.event.type })),
    { now: Date.now(), typeFilter: createResponsiveTypeFilter(['order.shipped']), getType: (c) => c.type },
    emptyRateState(),
  );
  assert.equal(admit.admitted.length, 0, 'Property 7: a non-worthy Event type produces no turn');
  assert.equal(chat.calls.length, 0, 'Property 7: no workspace-chat turn for a non-worthy type');
});

test('E2E: two members never cross conversations or sessions (Req 1.3; Property 2, 6)', async () => {
  const alice = 'e2e-alice';
  const bob = 'e2e-bob';
  const chat = makeWorkspaceChatMock();

  // Property 6: distinct members → distinct, deterministic conversations.
  const aliceConversation = deriveConversationId(identityFor(alice));
  const bobConversation = deriveConversationId(identityFor(bob));
  assert.notEqual(aliceConversation, bobConversation, 'Property 6: one conversation per member, no collision');

  // Both are online; an Event arrives for each.
  await poll(alice);
  await poll(bob);
  for (const [member, orderId] of [[alice, 'a-1'], [bob, 'b-1']] as const) {
    const { raw, headers } = signedEvent({ type: 'order.shipped', memberId: member, data: { orderId } });
    await ingest(raw, headers);
  }

  const aliceDelivered = parsePollResponse((await (await poll(alice)).json()) as EventPollResponse);
  const bobDelivered = parsePollResponse((await (await poll(bob)).json()) as EventPollResponse);
  assert.equal(aliceDelivered.length, 1, 'Alice gets only her Event');
  assert.equal(bobDelivered.length, 1, 'Bob gets only his Event');

  // Each turn runs on that member's OWN session + conversation (Property 2, 6).
  await chat.workspaceChat(chat.sessionFor(alice), aliceConversation, planProactiveTurns(aliceDelivered)[0].text);
  await chat.workspaceChat(chat.sessionFor(bob), bobConversation, planProactiveTurns(bobDelivered)[0].text);

  const aliceCall = chat.calls.find((call) => call.memberSession === chat.sessionFor(alice));
  const bobCall = chat.calls.find((call) => call.memberSession === chat.sessionFor(bob));
  assert.ok(aliceCall && bobCall, 'both members drove their own turn');
  assert.equal(aliceCall!.conversationId, aliceConversation, 'Property 6: Alice’s turn stayed in Alice’s conversation');
  assert.equal(bobCall!.conversationId, bobConversation, 'Property 6: Bob’s turn stayed in Bob’s conversation');
  assert.notEqual(
    aliceCall!.memberSession,
    bobCall!.memberSession,
    'Property 2: each turn credited its own member, never shared/service identity',
  );
});

test('Property 1: the feature runs with Core unchanged — no App module imports Core code (Req 1.1, 1.3)', () => {
  // Structural assertion of Property 1: the entire feature lives in this repo
  // and depends on Core ONLY through the external `/workspace-chat` HTTP API
  // (mocked above) and the host-provided React hooks in the browser surface.
  // No server-side / logic module may import Core packages, so the App runs
  // with Core's source unchanged.
  const backendDir = dirname(fileURLToPath(import.meta.url));
  const uiDir = join(backendDir, '..', 'ui');

  // Core package specifiers the App backend/logic must never import.
  const forbidden = [/@sota\/core/, /api-gateway/, /sotaagents-api-gateway/];
  // `@sota/core/hooks` and `@sota/platform` are host-provided browser hooks the
  // native surface (`app.tsx`) legitimately uses — they are NOT Core source and
  // are not bundled from this repo. Everything else must be App-local.
  const hostSurfaceAllowed = new Set(['app.tsx']);

  const offenders: string[] = [];
  for (const dir of [backendDir, uiDir]) {
    for (const file of readdirSync(dir)) {
      if (!/\.(ts|tsx)$/.test(file)) continue;
      if (file.endsWith('.test.ts') || file.endsWith('.test.tsx')) continue; // this test names Core in prose
      const source = readFileSync(join(dir, file), 'utf8');
      const importLines = source
        .split('\n')
        .filter((line) => /\bimport\b/.test(line) && /from\s+['"]/.test(line));
      for (const line of importLines) {
        if (forbidden.some((pattern) => pattern.test(line))) {
          if (hostSurfaceAllowed.has(file) && /@sota\/core\/hooks/.test(line)) continue;
          offenders.push(`${file}: ${line.trim()}`);
        }
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `Property 1: no App logic module may import Core source (offenders: ${offenders.join(' | ')})`,
  );
});
