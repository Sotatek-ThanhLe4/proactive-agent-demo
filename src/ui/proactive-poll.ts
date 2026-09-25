/**
 * App_Surface online polling plumbing — pure helpers (Task 4, Req 4.1–4.4, 9.1).
 *
 * OQ1 resolved to POLL. While the member has the App open, the Surface polls the
 * App_Backend `GET /events/poll` (with the member's session) to learn whether a
 * new Event arrived (Req 9.1). For each returned Event it must, WITHOUT the
 * member typing (Req 4.4): take the App-loaded Context, turn it into the turn
 * text, and drive a `/workspace-chat` turn with the member's own session (Req
 * 4.2), then render the reply (Req 4.3) and acknowledge the Event so it is not
 * delivered again (Req 9.3).
 *
 * The React surface uses the host `useChatSession` hook + `fetch` to do the
 * actual polling and turn. Those are browser-only and not unit-testable, so the
 * deterministic, side-effect-free decisions live here:
 *   - parsing a poll response into deliverable items;
 *   - turning delivered Events into the exact proactive turn text to send;
 *   - deciding which Event ids to acknowledge after a successful turn.
 *
 * Everything here is dependency-free and isomorphic so it runs identically in
 * the browser surface and in Node unit tests.
 */

import type { ProactiveContext } from '../backend/proactive-types.js';
import { buildProactiveTurnText } from './proactive-chat.js';

/** Path the open Surface polls for new online Events (Req 9.1). */
export const POLL_PATH = '/events/poll';
/** Path the Surface calls to acknowledge Events it has processed (Req 9.3). */
export const ACK_PATH = '/events/ack';

/**
 * The minimal fetch signature these helpers need. Both the browser `fetch` and
 * the platform `useAppFetch()` (which injects the member's invocation token)
 * satisfy it, so the surface can hand either in and tests can inject a stub.
 */
export type FetchLike = (path: string, init?: RequestInit) => Promise<Response>;

/** One Event handed to the Surface by the poll endpoint. */
export interface PolledEvent {
  id: string;
  type: string;
  timestamp?: string;
  idempotencyKey?: string;
  context: ProactiveContext;
}

/** The shape of the `GET /events/poll` JSON response. */
export interface PollResponseLike {
  memberId?: string;
  events?: ReadonlyArray<PolledEvent> | undefined;
}

/** One proactive turn the Surface should send, plus the Event it came from. */
export interface ProactiveTurnPlan {
  /** The Event id to acknowledge once this turn has started. */
  eventId: string;
  /**
   * The Event type, carried so the rate controller's type filter can decide
   * whether this turn is "worth responding to" (Task 11, Req 10.3, 10.4).
   */
  type: string;
  /** The exact user-turn text to POST to `/workspace-chat` (Req 4.2, 4.4). */
  text: string;
}

/**
 * Normalize a raw poll response body into a clean list of PolledEvents.
 *
 * Tolerant of a missing/oddly-shaped body (a transient network state is not a
 * crash): anything without a string `id` is dropped.
 */
export function parsePollResponse(body: PollResponseLike | undefined): PolledEvent[] {
  const events = body?.events;
  if (!Array.isArray(events)) return [];
  return events.filter(
    (event): event is PolledEvent =>
      !!event && typeof event.id === 'string' && event.id.trim().length > 0,
  );
}

/**
 * Build the proactive turns to send for a batch of polled Events (Req 4.2, 4.4).
 *
 * - preserves order (Events are handled oldest first);
 * - skips Events whose Context yields no sendable text, so the Surface never
 *   posts an empty turn;
 * - is a pure function of its input, so the same poll response always yields the
 *   same plan (testable, deterministic).
 */
export function planProactiveTurns(events: ReadonlyArray<PolledEvent>): ProactiveTurnPlan[] {
  if (!Array.isArray(events)) return [];
  const plans: ProactiveTurnPlan[] = [];
  for (const event of events) {
    const text = buildProactiveTurnText(event.context);
    if (text.length === 0) continue;
    plans.push({ eventId: event.id, type: event.type, text });
  }
  return plans;
}

/**
 * The ids to acknowledge after processing a poll response (Req 9.3).
 *
 * We acknowledge EVERY delivered Event id — including ones that produced no
 * sendable turn — because a Context-less Event has been seen and must not be
 * re-delivered forever. Events that failed to start a turn are NOT passed here
 * by the caller, so they stay buffered for retry (Req 9.3).
 */
export function acknowledgedIds(events: ReadonlyArray<PolledEvent>): string[] {
  if (!Array.isArray(events)) return [];
  return events.map((event) => event.id).filter((id) => typeof id === 'string' && id.length > 0);
}

/**
 * Poll the App_Backend for new online Events (Req 9.1).
 *
 * Uses the member's own session — same-origin request carrying the member's
 * cookie, exactly like the `/workspace-chat` call — so the Backend both marks
 * the member Online (Req 4.1) and scopes the result to this member. `fetchImpl`
 * is injectable for tests.
 */
export async function fetchPoll(fetchImpl: FetchLike = fetch): Promise<PolledEvent[]> {
  const response = await fetchImpl(POLL_PATH, {
    method: 'GET',
    headers: { accept: 'application/json' },
    credentials: 'same-origin',
  });
  if (!response.ok) {
    throw new Error(`poll request failed: HTTP ${response.status}`);
  }
  return parsePollResponse((await response.json()) as PollResponseLike);
}

/**
 * Acknowledge the Events the Surface has processed so they are not delivered
 * again (Req 9.3). A no-op when there are no ids. `fetchImpl` is injectable.
 */
export async function acknowledgeEvents(
  ids: ReadonlyArray<string>,
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  if (!Array.isArray(ids) || ids.length === 0) return;
  const response = await fetchImpl(ACK_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ ids }),
  });
  if (!response.ok) {
    throw new Error(`ack request failed: HTTP ${response.status}`);
  }
}
