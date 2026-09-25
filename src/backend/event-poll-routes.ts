import type { Express } from 'express';
import type { RequestHandler } from 'express';
import type { OnlineDeliveryStore, DeliverableEvent } from './online-delivery.js';
import type { PresenceStateStore } from './presence-state.js';
import { loadProactiveContext } from './proactive-context.js';
import type { ProactiveContext } from './proactive-types.js';

/**
 * Task 4 (OQ1 — POLL) — App_Backend endpoints the App_Surface polls to learn
 * there is a new Event and to acknowledge ones it has processed (Req 4.1, 9.1,
 * 9.2, 9.3).
 *
 * The Surface is a native module running in the member's browser with the
 * member's session, so it reaches these routes through Core with a verified
 * invocation token. The member identity is taken from the VERIFIED token claims
 * (`sub`), never from the request body — the Surface cannot poll on behalf of
 * another member.
 *
 * Two routes:
 *   - `GET  /events/poll` — heartbeat + peek. Marks the member Online (so an
 *     Event arriving now is delivered, not queued — Req 4.1) and returns the
 *     Events waiting for them, each with its loaded Context (Req 4.2 seam) so
 *     the Surface can run a `/workspace-chat` turn WITHOUT the member typing
 *     (Req 4.4). Events are left buffered until acknowledged (Req 9.3).
 *   - `POST /events/ack` — the Surface confirms it has driven a turn for the
 *     given Event ids; only then are they removed (Req 9.3). A poll that is
 *     never acked re-delivers on the next poll (at-least-once; Core enforces
 *     idempotency on the turn).
 *
 * The App does NOT run the agent here (Req 1.2, Property 2): the backend only
 * tells the Surface what to say and the Surface calls Core with the member's own
 * session.
 */

/** One Event delivered to the Surface, with the Context it should send. */
export interface DeliveredEvent {
  id: string;
  type: string;
  timestamp: string;
  idempotencyKey?: string;
  /** App-loaded Context the Surface turns into the proactive turn text. */
  context: ProactiveContext;
}

export interface EventPollResponse {
  memberId: string;
  events: DeliveredEvent[];
}

export interface EventPollOptions {
  presence: PresenceStateStore;
  delivery: OnlineDeliveryStore;
  /**
   * Auth middleware that verifies the member's invocation token and populates
   * `response.locals.sota` with the member claims (`sub`). Injected so this
   * module stays testable without a real Core JWKS.
   */
  authenticate: RequestHandler;
  /**
   * App-owned Context loader for a buffered Event (Req 4.2). Defaults to the
   * scaffold `loadProactiveContext`; a tenant can override per its own business.
   */
  loadContext?: (event: DeliverableEvent) => Promise<ProactiveContext>;
}

/** Read the member id from the VERIFIED token claims (`sub`). */
function memberIdFromClaims(locals: Record<string, unknown>): string | undefined {
  const claims = locals.sota as { sub?: unknown } | undefined;
  const sub = claims?.sub;
  return typeof sub === 'string' && sub.trim().length > 0 ? sub.trim() : undefined;
}

/** Default Context loader: reuse the scaffold loader over the buffered Event. */
async function defaultLoadContext(event: DeliverableEvent): Promise<ProactiveContext> {
  return loadProactiveContext({
    type: event.type,
    subjectKey: event.memberId,
    ...(event.idempotencyKey ? { idempotencyKey: event.idempotencyKey } : {}),
    timestamp: event.timestamp,
    data: event.data,
  });
}

export function registerEventPollRoutes(app: Express, options: EventPollOptions): void {
  const { presence, delivery, authenticate } = options;
  const loadContext = options.loadContext ?? defaultLoadContext;

  // GET /events/poll — heartbeat + peek pending Events with their Context.
  app.get('/events/poll', authenticate, async (_request, response) => {
    const memberId = memberIdFromClaims(response.locals);
    if (!memberId) {
      response.status(401).json({ code: 'AUTH_ERROR', message: 'Missing member identity' });
      return;
    }

    // Heartbeat: the Surface is open and polling → the member is Online, so a
    // new Event is delivered here rather than queued (Req 4.1).
    presence.markOnline(memberId);

    const pending = delivery.poll(memberId);
    let events: DeliveredEvent[];
    try {
      events = await Promise.all(
        pending.map(async (event) => ({
          id: event.id,
          type: event.type,
          timestamp: event.timestamp,
          ...(event.idempotencyKey ? { idempotencyKey: event.idempotencyKey } : {}),
          context: await loadContext(event),
        })),
      );
    } catch (error) {
      // Context loading failed → keep Events buffered (Req 9.3) and report so
      // the Surface retries on the next poll. Nothing is acknowledged.
      console.error(
        JSON.stringify({
          event: 'proactive_poll_context_failed',
          memberId,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      response.status(500).json({ code: 'APP_ERROR', message: 'Failed to load event context' });
      return;
    }

    const body: EventPollResponse = { memberId, events };
    response.status(200).json(body);
  });

  // POST /events/ack — remove Events the Surface has confirmed it processed.
  app.post('/events/ack', authenticate, (request, response) => {
    const memberId = memberIdFromClaims(response.locals);
    if (!memberId) {
      response.status(401).json({ code: 'AUTH_ERROR', message: 'Missing member identity' });
      return;
    }
    const ids = readIds((request.body as { ids?: unknown } | undefined)?.ids);
    // Refresh the heartbeat too: an ack proves the Surface is still open.
    presence.markOnline(memberId);
    const removed = delivery.acknowledge(memberId, ids);
    response.status(200).json({ memberId, acknowledged: removed });
  });
}

/** Coerce the request `ids` into a clean array of non-empty strings. */
function readIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((id): id is string => typeof id === 'string' && id.trim().length > 0);
}
