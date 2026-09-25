/**
 * Deterministic member → Conversation mapping (Task 1, Req 3, Property 6).
 *
 * Each member has exactly ONE Conversation with the agent. The App never
 * creates a second conversation for a member; instead the conversationId is
 * DERIVED from the member's identity so the same member always resolves to the
 * same conversation, and reopening the App reuses the existing one (Req 3.2).
 *
 * The mapping is:
 *   - deterministic: same identity in → same conversationId out (Req 3.3);
 *   - total for valid identities: any valid member identity yields exactly one
 *     conversationId (Req 3.1);
 *   - tenant-scoped: the org + workspace are folded into the key so the same
 *     user in two workspaces cannot collide onto one conversation.
 *
 * It is intentionally pure and dependency-free (no `node:crypto`, no React) so
 * the SAME function runs in the App_Surface (browser) and in the App_Backend /
 * unit tests, and so Property 6 can be checked without any I/O.
 */

/** The verified member identity the App maps to a single Conversation. */
export interface MemberIdentity {
  /** Organization scope (from verified tenant claims). */
  organizationId: string;
  /** Workspace scope (from verified tenant claims). */
  workspaceId: string;
  /** Stable member id (the logged-in user's id). */
  userId: string;
}

/** A namespace prefix so App-derived ids are recognizable and collision-safe. */
const CONVERSATION_ID_PREFIX = 'pea';

export class InvalidMemberIdentityError extends Error {
  constructor(field: string) {
    super(`member identity is missing a valid ${field}`);
    this.name = 'InvalidMemberIdentityError';
  }
}

/**
 * Build the canonical, order-stable key for a member identity. Components are
 * joined with a separator that cannot appear inside the (opaque) ids so two
 * different identities can never serialize to the same key.
 */
export function memberIdentityKey(identity: MemberIdentity): string {
  const organizationId = requireField(identity.organizationId, 'organizationId');
  const workspaceId = requireField(identity.workspaceId, 'workspaceId');
  const userId = requireField(identity.userId, 'userId');
  // The '\u0000' separator is not a valid character in any of these ids.
  return [organizationId, workspaceId, userId].join('\u0000');
}

/**
 * Derive the single, deterministic conversationId for a member.
 *
 * Same identity → same id (Property 6). The digest is a hex string produced by
 * a pure isomorphic hash so it is stable across the browser surface and the
 * Node backend/tests.
 */
export function deriveConversationId(identity: MemberIdentity): string {
  const key = memberIdentityKey(identity);
  return `${CONVERSATION_ID_PREFIX}_${hashHex(key)}`;
}

function requireField(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvalidMemberIdentityError(field);
  }
  return value.trim();
}

/**
 * Deterministic, isomorphic string hash. Uses a 128-bit digest built from four
 * independent FNV-1a-style lanes over the UTF-8 code units, rendered as a
 * fixed-width lowercase hex string. Dependency-free so it runs identically in
 * the browser and in Node — no `SubtleCrypto` (async) or `node:crypto`.
 *
 * This is NOT a cryptographic hash; it only needs to be stable and to spread
 * distinct identities across a large space so per-member conversations do not
 * collide in practice.
 */
export function hashHex(input: string): string {
  // Four lanes with distinct offset bases to widen the effective digest.
  let h0 = 0x811c9dc5;
  let h1 = 0x01000193;
  let h2 = 0x811c9dc5 ^ 0x9e3779b9;
  let h3 = 0x01000193 ^ 0x85ebca6b;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h0 = Math.imul(h0 ^ c, 0x01000193) >>> 0;
    h1 = Math.imul(h1 ^ ((c << 5) | (c >>> 3)), 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (c + i), 0x01000193) >>> 0;
    h3 = Math.imul(h3 ^ ((c * 131 + i * 17) >>> 0), 0x01000193) >>> 0;
  }
  return [h0, h1, h2, h3].map(toHex8).join('');
}

function toHex8(value: number): string {
  return (value >>> 0).toString(16).padStart(8, '0');
}
