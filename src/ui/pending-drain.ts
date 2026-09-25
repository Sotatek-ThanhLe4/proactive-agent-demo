/**
 * App_Surface pending-drain plumbing — pure helpers (Task 7, Req 6.1, 6.2).
 *
 * When the member opens the App_Surface, the Surface must:
 *   1. retrieve the member's pending Events from the App_Backend (Req 6.1);
 *   2. load Context from those Events (Req 6.2);
 *   3. drive a workspace-chat turn on the member's own session (Req 6.2,
 *      Property 2) — reusing the SAME chat path as Task 2 (online turns).
 *
 * The network fetch, the host `useChatSession` hook, and React are browser-only
 * and not unit-testable, so the deterministic, side-effect-free pieces live
 * here:
 *   - fetching + validating the `/events/pending` response into typed Events;
 *   - turning the pending Events into the single turn text to send.
 *
 * This module reuses the backend Context loader (`loadProactiveContext`) and
 * the Task 2 turn builder (`buildProactiveTurnText`) so a queued Event produces
 * a turn identically to a live online Event — one code path, one behaviour.
 *
 * Mark-processed / no-replay (Task 8, Req 6.4, Property 5) IS wired here now:
 * `acknowledgePendingEvents` POSTs the drained Event ids to
 * `/events/pending/ack` on the member's own session so the Backend flips them
 * to `processed`. The caller (the React surface) acks each Event only AFTER its
 * turn has been driven, so a failed turn leaves the Event pending for the next
 * open (Req 9.3). Because acking is idempotent on the Backend, a retried ack is
 * harmless. This mirrors the online ack seam (`/events/ack`).
 *
 * Merge / rate-limit (Task 10) is still NOT done here — this module exposes the
 * drained Events and turn text as data so that seam can wrap it.
 */

import { loadProactiveContext } from '../backend/proactive-context.js';
import {
  pendingEventToInbound,
  type PendingEventDto,
  type PendingEventsResponse,
} from '../backend/pending-events.js';
import type { ProactiveContext } from '../backend/proactive-types.js';
import { buildProactiveTurnText } from './proactive-chat.js';
import type { FetchLike } from './proactive-poll.js';

/** Path the Surface polls on open for the member's pending Events (Req 6.1). */
export const PENDING_EVENTS_PATH = '/events/pending';
/**
 * Path the Surface calls to mark drained pending Events processed so a later
 * open does not replay them (Task 8, Req 6.4, Property 5).
 */
export const PENDING_ACK_PATH = '/events/pending/ack';

/** Narrow, validate an unknown JSON body into a typed pending-events response. */
export function parsePendingEventsResponse(body: unknown): PendingEventsResponse {
  if (!isRecord(body) || typeof body.memberId !== 'string' || !Array.isArray(body.events)) {
    throw new TypeError('malformed pending-events response');
  }
  const events: PendingEventDto[] = [];
  for (const raw of body.events) {
    if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.type !== 'string') {
      // Skip a malformed row rather than fail the whole drain: a single bad
      // record must not strand every other pending Event (fail-safe, Req 9.3).
      continue;
    }
    events.push({
      id: raw.id,
      type: raw.type,
      payload: raw.payload,
      ...(typeof raw.idempotencyKey === 'string' ? { idempotencyKey: raw.idempotencyKey } : {}),
      receivedAt: typeof raw.receivedAt === 'number' ? raw.receivedAt : Date.now(),
    });
  }
  return { memberId: body.memberId, events };
}

/**
 * Fetch the member's pending Events from the App_Backend (Req 6.1).
 *
 * Uses the member's own session — the request is same-origin and carries the
 * member's cookie, exactly like the `/workspace-chat` call — so the Backend
 * scopes the result to this member. `fetchImpl` is injectable for tests.
 */
export async function fetchPendingEvents(
  fetchImpl: FetchLike = fetch,
): Promise<PendingEventsResponse> {
  const response = await fetchImpl(PENDING_EVENTS_PATH, {
    method: 'GET',
    headers: { accept: 'application/json' },
    credentials: 'same-origin',
  });
  if (!response.ok) {
    throw new Error(`pending-events request failed: HTTP ${response.status}`);
  }
  return parsePendingEventsResponse(await response.json());
}

/**
 * Load Context for a single pending Event, reusing the backend Context seam so
 * a queued Event and a live online Event build Context the same way (Req 6.2).
 */
export async function loadContextForPendingEvent(
  event: PendingEventDto,
  memberId: string,
): Promise<ProactiveContext> {
  return loadProactiveContext(pendingEventToInbound(event, memberId));
}

/** One drained Event together with the turn text it produces. */
export interface DrainedTurn {
  event: PendingEventDto;
  text: string;
}

/**
 * Turn the pending Events into the ordered list of turns to send. Loads Context
 * per Event (Req 6.2) and builds the turn text with the SAME builder Task 2
 * uses for online turns. Events that yield no sendable text are dropped so the
 * Surface never sends an empty proactive turn.
 *
 * Returns data only — it does NOT call `/workspace-chat`. The caller (the React
 * surface, or Task 10's merge/rate-limit seam) decides how many of these turns
 * actually run and on which session.
 */
export async function planPendingTurns(
  response: PendingEventsResponse,
): Promise<DrainedTurn[]> {
  const turns: DrainedTurn[] = [];
  for (const event of response.events) {
    const context = await loadContextForPendingEvent(event, response.memberId);
    const text = buildProactiveTurnText(context);
    if (text.length === 0) continue;
    turns.push({ event, text });
  }
  return turns;
}

/**
 * Mark the given drained pending Events processed so a later open does not
 * replay them (Task 8, Req 6.4, Property 5).
 *
 * POSTs the Event ids to `/events/pending/ack` on the member's own session
 * (same-origin cookie), exactly like `fetchPendingEvents`, so the Backend
 * scopes the mark to this member. A no-op when there are no ids. Because the
 * Backend treats an already-processed or unknown id as harmless, this is safe
 * to retry. The caller MUST call this only AFTER the turn for those Events has
 * been driven, so a failed turn leaves the Events pending for the next open.
 * `fetchImpl` is injectable for tests.
 */
export async function acknowledgePendingEvents(
  ids: ReadonlyArray<string>,
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  const clean = ids.filter((id): id is string => typeof id === 'string' && id.trim().length > 0);
  if (clean.length === 0) return;
  const response = await fetchImpl(PENDING_ACK_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ ids: clean }),
  });
  if (!response.ok) {
    throw new Error(`pending-ack request failed: HTTP ${response.status}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
