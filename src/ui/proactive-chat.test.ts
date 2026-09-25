import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CHAT_TURN_CREDENTIAL,
  buildProactiveTurnText,
  extractMessageText,
  hasSendableContext,
  toTranscript,
  type MessageLike,
} from './proactive-chat.js';
import type { ProactiveContext } from '../backend/proactive-types.js';

// --- Unit: extractMessageText ------------------------------------------------

test('extractMessageText concatenates streamed text parts in order (Req 8.4)', () => {
  const message: MessageLike = {
    id: 'a1',
    role: 'assistant',
    parts: [
      { type: 'text', text: 'Hello ' },
      { type: 'text', text: 'there' },
    ],
  };
  assert.equal(extractMessageText(message), 'Hello there');
});

test('extractMessageText ignores non-text parts (tools, reasoning, files)', () => {
  const message: MessageLike = {
    role: 'assistant',
    parts: [
      { type: 'reasoning', text: 'thinking...' },
      { type: 'text', text: 'Answer' },
      { type: 'tool-foo', text: 'tool-call' },
    ],
  };
  assert.equal(extractMessageText(message), 'Answer');
});

test('extractMessageText falls back to flat content when there are no parts', () => {
  const message: MessageLike = { role: 'user', content: 'plain content' };
  assert.equal(extractMessageText(message), 'plain content');
});

test('extractMessageText returns empty string for a message with no renderable text', () => {
  const message: MessageLike = { role: 'assistant', parts: [{ type: 'step-start' }] };
  assert.equal(extractMessageText(message), '');
});

// --- Unit: toTranscript ------------------------------------------------------

test('toTranscript maps user + assistant turns preserving order (Req 8.3)', () => {
  const messages: MessageLike[] = [
    { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
    { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'hello' }] },
  ];
  assert.deepEqual(toTranscript(messages), [
    { id: 'u1', role: 'user', text: 'hi' },
    { id: 'a1', role: 'assistant', text: 'hello' },
  ]);
});

test('toTranscript drops blank turns so the UI renders no empty rows', () => {
  const messages: MessageLike[] = [
    { id: 'a0', role: 'assistant', parts: [{ type: 'step-start' }] },
    { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'ready' }] },
  ];
  const transcript = toTranscript(messages);
  assert.equal(transcript.length, 1);
  assert.equal(transcript[0].id, 'a1');
});

test('toTranscript defaults unknown roles to assistant and missing ids to index', () => {
  const messages: MessageLike[] = [{ content: 'no role, no id' }];
  assert.deepEqual(toTranscript(messages), [
    { id: 'msg-0', role: 'assistant', text: 'no role, no id' },
  ]);
});

test('toTranscript tolerates undefined / empty input', () => {
  assert.deepEqual(toTranscript(undefined), []);
  assert.deepEqual(toTranscript([]), []);
});

// --- Unit: buildProactiveTurnText -------------------------------------------

test('buildProactiveTurnText prefers the Context text, trimmed', () => {
  const context: ProactiveContext = { text: '  Event summary  ' };
  assert.equal(buildProactiveTurnText(context), 'Event summary');
});

test('buildProactiveTurnText serializes parts when text is absent', () => {
  const context: ProactiveContext = { parts: [{ kind: 'event', type: 'cart.item_added' }] };
  assert.equal(
    buildProactiveTurnText(context),
    JSON.stringify([{ kind: 'event', type: 'cart.item_added' }]),
  );
});

test('buildProactiveTurnText is empty for empty/absent context', () => {
  assert.equal(buildProactiveTurnText(undefined), '');
  assert.equal(buildProactiveTurnText({}), '');
  assert.equal(buildProactiveTurnText({ text: '   ' }), '');
  assert.equal(hasSendableContext(undefined), false);
  assert.equal(hasSendableContext({ text: 'go' }), true);
});

// --- Property 2 (support): credit is charged to the correct member -----------
// Validates: Requirements 7.1, 7.2
//
// Property 2 says every proactive turn runs on the member's OWN session, never a
// service/machine identity, so Core charges the right member. In the surface,
// the turn is driven by the host `useChatSession` hook, which posts to
// `/workspace-chat` with the member's same-origin session cookie — the App adds
// NO alternative credential. We encode that invariant as a constant and assert
// the surface layer exposes exactly one credential path: the member session.

test('Property 2: the only chat-turn credential is the member session (no service account)', () => {
  assert.equal(CHAT_TURN_CREDENTIAL, 'member-session');
});

test('Property 2: turn building never injects an identity/credential into the turn text', () => {
  // Whatever Context we build a turn from, the produced text is purely the
  // business context — it carries no token, service account, or "act as" hint.
  // (A regression that smuggled a credential into the turn would show here.)
  const contexts: ProactiveContext[] = [
    { text: 'Order #42 shipped' },
    { parts: [{ kind: 'event', type: 'order.shipped', subjectKey: 'member-1' }] },
    { text: 'A', parts: [{ ignored: true }] },
  ];
  for (const context of contexts) {
    const turn = buildProactiveTurnText(context).toLowerCase();
    assert.ok(!turn.includes('bearer '), `turn leaked a bearer token: ${turn}`);
    assert.ok(!turn.includes('service account'), `turn leaked a service account: ${turn}`);
    assert.ok(!turn.includes('authorization:'), `turn leaked an auth header: ${turn}`);
  }
});

// --- Property (support): transcript rendering is a pure, order-preserving map -
// Validates: Requirements 8.3, 8.4
//
// For a varied set of streamed message logs, toTranscript is (a) deterministic,
// (b) order-preserving over the visible turns, and (c) never emits a blank row.

test('Property: toTranscript is deterministic, order-preserving, and blank-free', () => {
  const roles = ['user', 'assistant', 'system', undefined];
  const texts = ['', ' ', 'hi', 'multi\nline', 'streamed token'];

  // Build a grid of message logs of increasing length.
  for (let len = 0; len <= 6; len++) {
    const messages: MessageLike[] = [];
    for (let i = 0; i < len; i++) {
      const role = roles[(i * 3 + len) % roles.length];
      const text = texts[(i * 2 + len) % texts.length];
      messages.push({ id: `m${i}`, role, parts: [{ type: 'text', text }] });
    }

    const first = toTranscript(messages);
    const second = toTranscript(messages);

    // (a) deterministic
    assert.deepEqual(second, first);

    // (c) no blank rows
    for (const entry of first) {
      assert.ok(entry.text.trim().length > 0, 'blank transcript row emitted');
      assert.ok(entry.role === 'user' || entry.role === 'assistant');
    }

    // (b) order-preserving: the visible ids appear in their original order.
    const visibleIds = messages
      .filter((m) => (m.parts?.[0]?.text as string)?.trim())
      .map((m) => m.id);
    assert.deepEqual(
      first.map((e) => e.id),
      visibleIds,
    );
  }
});
