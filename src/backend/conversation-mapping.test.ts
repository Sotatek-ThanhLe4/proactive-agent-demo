import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  deriveConversationId,
  memberIdentityKey,
  hashHex,
  InvalidMemberIdentityError,
  type MemberIdentity,
} from './conversation-mapping.js';

function identity(overrides: Partial<MemberIdentity> = {}): MemberIdentity {
  return {
    organizationId: 'org-1',
    workspaceId: 'ws-1',
    userId: 'user-1',
    ...overrides,
  };
}

// --- Unit: determinism (Req 3.3) --------------------------------------------

test('deriveConversationId is deterministic: same identity → same id', () => {
  const a = deriveConversationId(identity());
  const b = deriveConversationId(identity());
  assert.equal(a, b);
});

test('deriveConversationId reuses the same id when the App reopens (Req 3.2)', () => {
  // Simulate two separate "open App" moments for the same member.
  const firstOpen = deriveConversationId(identity({ userId: 'member-42' }));
  const secondOpen = deriveConversationId(identity({ userId: 'member-42' }));
  assert.equal(firstOpen, secondOpen);
});

test('deriveConversationId returns a stable, namespaced, non-empty id (Req 3.1)', () => {
  const id = deriveConversationId(identity());
  assert.match(id, /^pea_[0-9a-f]{32}$/);
});

// --- Unit: distinctness / tenant scoping ------------------------------------

test('different members map to different conversations', () => {
  const a = deriveConversationId(identity({ userId: 'user-a' }));
  const b = deriveConversationId(identity({ userId: 'user-b' }));
  assert.notEqual(a, b);
});

test('same user in a different workspace maps to a different conversation', () => {
  const a = deriveConversationId(identity({ workspaceId: 'ws-1' }));
  const b = deriveConversationId(identity({ workspaceId: 'ws-2' }));
  assert.notEqual(a, b);
});

test('same user in a different organization maps to a different conversation', () => {
  const a = deriveConversationId(identity({ organizationId: 'org-1' }));
  const b = deriveConversationId(identity({ organizationId: 'org-2' }));
  assert.notEqual(a, b);
});

// --- Unit: invalid input (edge cases) ---------------------------------------

test('deriveConversationId rejects a missing userId', () => {
  assert.throws(
    () => deriveConversationId(identity({ userId: '' })),
    (error: unknown) =>
      error instanceof InvalidMemberIdentityError && /userId/.test(error.message),
  );
});

test('deriveConversationId rejects a whitespace-only workspaceId', () => {
  assert.throws(
    () => deriveConversationId(identity({ workspaceId: '   ' })),
    (error: unknown) =>
      error instanceof InvalidMemberIdentityError && /workspaceId/.test(error.message),
  );
});

test('memberIdentityKey trims components so incidental whitespace does not fork the id', () => {
  const trimmed = deriveConversationId(identity({ userId: 'user-1' }));
  const padded = deriveConversationId(identity({ userId: '  user-1  ' }));
  assert.equal(trimmed, padded);
});

test('key components cannot collide across field boundaries', () => {
  // ("orgab","ws","u") vs ("org","abws","u") must not produce the same key.
  const a = memberIdentityKey(identity({ organizationId: 'orgab', workspaceId: 'ws' }));
  const b = memberIdentityKey(identity({ organizationId: 'org', workspaceId: 'abws' }));
  assert.notEqual(a, b);
});

// --- Property 6: one conversation per member, deterministic mapping ----------
// Validates: Requirements 3.1, 3.2, 3.3
//
// For a large, varied set of member identities:
//   (a) determinism  — deriving twice yields the identical id (a function);
//   (b) injectivity  — distinct identities yield distinct ids (one conv/member,
//                      no two members share a conversation).
// We exhaustively enumerate a grid of orgs × workspaces × users, which is a
// smart, structured generator over the identity input space.

test('Property 6: deterministic and one-to-one member → conversation mapping', () => {
  const orgs = ['org-1', 'org-2', 'org-α', 'org_3', 'ORG-1'];
  const workspaces = ['ws-1', 'ws-2', 'ws-α', 'ws_3', 'WS-1'];
  const users = ['u1', 'u2', 'user-α', 'user_3', 'U1', '638f0e1a2b3c4d5e6f7a8b9c'];

  const seen = new Map<string, MemberIdentity>();

  for (const organizationId of orgs) {
    for (const workspaceId of workspaces) {
      for (const userId of users) {
        const id: MemberIdentity = { organizationId, workspaceId, userId };

        // (a) determinism: same identity → same id, every time.
        const first = deriveConversationId(id);
        const second = deriveConversationId(id);
        assert.equal(second, first, `non-deterministic for ${JSON.stringify(id)}`);

        // (b) injectivity: no two distinct identities collide.
        const prior = seen.get(first);
        if (prior) {
          assert.deepEqual(
            prior,
            id,
            `collision: ${JSON.stringify(prior)} and ${JSON.stringify(id)} → ${first}`,
          );
        }
        seen.set(first, id);
      }
    }
  }

  // Sanity: every identity in the grid produced its own conversation.
  assert.equal(seen.size, orgs.length * workspaces.length * users.length);
});

test('hashHex is a stable fixed-width isomorphic digest', () => {
  assert.equal(hashHex('a'), hashHex('a'));
  assert.notEqual(hashHex('a'), hashHex('b'));
  assert.match(hashHex('anything'), /^[0-9a-f]{32}$/);
  assert.match(hashHex(''), /^[0-9a-f]{32}$/);
});
