/**
 * App_Surface chat plumbing — pure helpers (Task 2, Req 1.2, 8.3, 8.4; Property 2).
 *
 * The App does NOT run its own LLM loop (Req 1.2). To run a turn, the surface
 * calls Core's existing `POST /workspace-chat` — in the member's browser, using
 * the member's Better Auth session (same-origin workspace cookie). Core then
 * attaches the turn to the member's conversation and charges credit to that
 * member (Req 7.1, 7.2, Property 2). There is NO service account and NO app
 * token on this path: the credential is simply the logged-in member's session.
 *
 * The React surface uses the host `useChatSession` hook to do the actual POST +
 * SSE. That hook is browser-only and not unit-testable, so the deterministic,
 * side-effect-free pieces live here:
 *   - turning a loaded Context into the exact text the surface sends;
 *   - turning host chat messages into a small render model for the transcript.
 *
 * Everything here is dependency-free and isomorphic so it runs identically in
 * the browser surface and in Node unit tests.
 */

import type { ProactiveContext } from '../backend/proactive-types.js';

/**
 * The member's session is the ONLY credential the surface uses to call
 * `/workspace-chat`. This enum documents (and lets tests assert) that the App
 * never introduces a machine/service identity for a proactive turn — the whole
 * point of Property 2.
 */
export const CHAT_TURN_CREDENTIAL = 'member-session' as const;
export type ChatTurnCredential = typeof CHAT_TURN_CREDENTIAL;

/** A single rendered line in the App's conversation transcript. */
export interface TranscriptEntry {
  id: string;
  role: 'user' | 'assistant';
  text: string;
}

/**
 * Minimal structural shape of a host chat message. We accept the shape the
 * `useChatSession` hook yields (an `ai` `UIMessage`) without importing it, so
 * this module stays isomorphic and testable: a `role`, optional `parts` (each a
 * `{ type, text }`), and an optional flat `content` fallback.
 */
export interface MessageLike {
  id?: string;
  role?: string;
  content?: unknown;
  parts?: ReadonlyArray<PartLike> | undefined;
}

export interface PartLike {
  type?: string;
  text?: unknown;
}

/**
 * Extract the human-readable text of a chat message.
 *
 * Prefers the streamed `text` parts (what the SSE stream fills in token by
 * token — Req 8.4) and concatenates them in order. Falls back to a flat
 * `content` string when a message has no parts. Non-text parts (tools,
 * reasoning, files) are ignored for this plain transcript.
 */
export function extractMessageText(message: MessageLike): string {
  const parts = message.parts;
  if (Array.isArray(parts) && parts.length > 0) {
    const text = parts
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text as string)
      .join('');
    if (text.length > 0) return text;
  }
  return typeof message.content === 'string' ? message.content : '';
}

/** Normalize a host role to the two roles the transcript renders. */
function normalizeRole(role: unknown): 'user' | 'assistant' {
  return role === 'user' ? 'user' : 'assistant';
}

/**
 * Build the transcript render model from the host chat messages.
 *
 * - preserves order (a conversation reads top to bottom);
 * - drops messages that have no visible text yet (e.g. an assistant turn that
 *   has only tool/step parts), so the UI never renders blank rows;
 * - is a pure function of its input, so the same messages always render the
 *   same transcript.
 */
export function toTranscript(messages: ReadonlyArray<MessageLike> | undefined): TranscriptEntry[] {
  if (!Array.isArray(messages)) return [];
  const entries: TranscriptEntry[] = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    const text = extractMessageText(message).trim();
    if (text.length === 0) continue;
    entries.push({
      id: typeof message.id === 'string' && message.id ? message.id : `msg-${index}`,
      role: normalizeRole(message.role),
      text,
    });
  }
  return entries;
}

/**
 * Turn a loaded Context (Req 4.2 / 6.2 seam) into the exact user-turn text the
 * surface sends to `/workspace-chat`. Deterministic and trimmed so the same
 * Context always produces the same turn and tests are stable.
 *
 * Prefers the Context `text`; if absent, serializes the structured `parts` as a
 * stable fallback so a proactive turn is never sent empty.
 */
export function buildProactiveTurnText(context: ProactiveContext | undefined): string {
  const text = context?.text;
  if (typeof text === 'string' && text.trim().length > 0) {
    return text.trim();
  }
  const parts = context?.parts;
  if (Array.isArray(parts) && parts.length > 0) {
    try {
      return JSON.stringify(parts);
    } catch {
      return String(parts);
    }
  }
  return '';
}

/** Whether there is any Context worth sending as a proactive turn. */
export function hasSendableContext(context: ProactiveContext | undefined): boolean {
  return buildProactiveTurnText(context).length > 0;
}
