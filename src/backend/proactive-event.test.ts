import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildProactiveTurnRequest, CoreClientError, requestProactiveTurn } from './core-client.js';
import { loadProactiveContext } from './proactive-context.js';
import {
  handleProactiveEvent,
  parseInboundEvent,
  ProactiveEventValidationError,
} from './proactive-event.js';
import type { InvocationClaims } from './sota-auth.js';
import type { InboundEvent, ProactiveTurnRequest, ProactiveTurnResult } from './proactive-types.js';

const claims: InvocationClaims = {
  iid: 'install-1',
  oid: 'org-1',
  wid: 'ws-1',
  sub: 'user-1',
  scp: ['event:proactive'],
};

const okResult: ProactiveTurnResult = {
  accepted: true,
  idempotencyKey: 'idem-1',
  conversationId: 'conv-1',
  contextMessageId: 'msg-1',
  contextRecorded: true,
  runId: 'run-1',
};

function event(overrides: Partial<InboundEvent> = {}): InboundEvent {
  return {
    type: 'cart.item_added',
    subjectKey: 'guest:dep-1:sess-1',
    idempotencyKey: 'idem-1',
    timestamp: '2024-01-01T00:00:00.000Z',
    mode: 'active',
    surface: 'guest',
    data: { productId: 'p-9' },
    ...overrides,
  };
}

// --- parseInboundEvent -------------------------------------------------------

test('parseInboundEvent accepts a well-formed event', () => {
  const parsed = parseInboundEvent(event());
  assert.equal(parsed.type, 'cart.item_added');
  assert.equal(parsed.subjectKey, 'guest:dep-1:sess-1');
  assert.equal(parsed.mode, 'active');
  assert.equal(parsed.surface, 'guest');
});

test('parseInboundEvent rejects a missing type naming the field', () => {
  assert.throws(
    () => parseInboundEvent({ subjectKey: 's' }),
    (error: unknown) =>
      error instanceof ProactiveEventValidationError && /type is required/.test(error.message),
  );
});

test('parseInboundEvent rejects a missing subjectKey', () => {
  assert.throws(
    () => parseInboundEvent({ type: 't' }),
    (error: unknown) =>
      error instanceof ProactiveEventValidationError && /subjectKey is required/.test(error.message),
  );
});

test('parseInboundEvent rejects an invalid mode', () => {
  assert.throws(
    () => parseInboundEvent({ type: 't', subjectKey: 's', mode: 'sideways' }),
    (error: unknown) => error instanceof ProactiveEventValidationError && /mode must be/.test(error.message),
  );
});

test('parseInboundEvent rejects a non-object body', () => {
  assert.throws(() => parseInboundEvent('nope'), ProactiveEventValidationError);
});

// --- loadProactiveContext ----------------------------------------------------

test('loadProactiveContext produces text and an app-owned event part', async () => {
  const context = await loadProactiveContext(event());
  assert.match(context.text ?? '', /cart\.item_added/);
  assert.ok(Array.isArray(context.parts));
  const part = context.parts?.[0] as Record<string, unknown>;
  assert.equal(part.kind, 'event');
  assert.deepEqual(part.data, { productId: 'p-9' });
});

// --- buildProactiveTurnRequest ----------------------------------------------

test('buildProactiveTurnRequest takes tenant from verified claims, not the body', async () => {
  const context = await loadProactiveContext(event());
  const spoofed = event({ subjectKey: 'guest:dep-1:sess-1' });
  const request = buildProactiveTurnRequest(spoofed, context, claims);
  assert.deepEqual(request.tenant, { organizationId: 'org-1', workspaceId: 'ws-1' });
});

test('buildProactiveTurnRequest fills a fresh idempotencyKey when the event omits one', async () => {
  const context = await loadProactiveContext(event({ idempotencyKey: undefined }));
  const request = buildProactiveTurnRequest(event({ idempotencyKey: undefined }), context, claims);
  assert.ok(request.idempotencyKey.length > 0);
});

test('buildProactiveTurnRequest fills timestamp when the event omits one', async () => {
  const context = await loadProactiveContext(event({ timestamp: undefined }));
  const request = buildProactiveTurnRequest(event({ timestamp: undefined }), context, claims);
  assert.ok(!Number.isNaN(Date.parse(request.timestamp)));
});

test('buildProactiveTurnRequest defaults mode to active and surface to guest', async () => {
  const bare = { type: 't', subjectKey: 's' } as InboundEvent;
  const context = await loadProactiveContext(bare);
  const request = buildProactiveTurnRequest(bare, context, claims);
  assert.equal(request.mode, 'active');
  assert.equal(request.surface, 'guest');
});

// --- requestProactiveTurn (injected fetch) ----------------------------------

test('requestProactiveTurn posts the Bearer credential and returns Core result', async () => {
  const request: ProactiveTurnRequest = buildProactiveTurnRequest(
    event(),
    await loadProactiveContext(event()),
    claims,
  );
  let seenAuth: string | undefined;
  let seenUrl: string | undefined;
  const fakeFetch: typeof fetch = async (url, init) => {
    seenUrl = String(url);
    seenAuth = new Headers(init?.headers).get('authorization') ?? undefined;
    return new Response(JSON.stringify(okResult), { status: 200 });
  };
  const result = await requestProactiveTurn(request, { claims, coreToken: 'core-tok' }, fakeFetch);
  assert.equal(result.conversationId, 'conv-1');
  assert.equal(seenAuth, 'Bearer core-tok');
  assert.match(seenUrl ?? '', /\/sota\/v1\/proactive\/turn$/);
});

test('requestProactiveTurn throws when the delegated Core token is missing', async () => {
  const request = buildProactiveTurnRequest(event(), await loadProactiveContext(event()), claims);
  await assert.rejects(
    () => requestProactiveTurn(request, { claims, coreToken: undefined }),
    (error: unknown) => error instanceof CoreClientError && /Missing delegated Core token/.test(error.message),
  );
});

test('requestProactiveTurn surfaces a Core 4xx with its status', async () => {
  const request = buildProactiveTurnRequest(event(), await loadProactiveContext(event()), claims);
  const fakeFetch: typeof fetch = async () =>
    new Response(JSON.stringify({ message: 'subjectKey is required' }), { status: 400 });
  await assert.rejects(
    () => requestProactiveTurn(request, { claims, coreToken: 'core-tok' }, fakeFetch),
    (error: unknown) =>
      error instanceof CoreClientError &&
      error.status === 400 &&
      /subjectKey is required/.test(error.message),
  );
});

// --- handleProactiveEvent (full flow, injected Core call) -------------------

test('handleProactiveEvent loads context, builds envelope, and calls Core', async () => {
  let captured: ProactiveTurnRequest | undefined;
  const callCore = async (req: ProactiveTurnRequest) => {
    captured = req;
    return okResult;
  };
  const result = await handleProactiveEvent(event(), { claims, coreToken: 'core-tok' }, { callCore });
  assert.equal(result.accepted, true);
  assert.equal(captured?.type, 'cart.item_added');
  assert.deepEqual(captured?.tenant, { organizationId: 'org-1', workspaceId: 'ws-1' });
  assert.ok(captured?.context.text);
});
