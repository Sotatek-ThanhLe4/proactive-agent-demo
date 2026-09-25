import type { Express, RequestHandler, Request } from 'express';
import { requireSotaInvocation, type InvocationClaims } from './sota-auth.js';
import type { EventQueueStore } from './event-queue.js';
import { buildPendingEventsResponse } from './pending-events.js';

/**
 * Pending-Events endpoint — the App_Surface calls this on OPEN to fetch the
 * member's pending queued Events (Task 7, Req 6.1).
 *
 * `GET /events/pending` is authenticated with the standard Sota invocation
 * guard. The member id is taken from the VERIFIED claim `sub` — never from a
 * query string or body — so the endpoint is inherently scoped to the caller:
 * a member can only ever drain their OWN Event_Queue. This is the same identity
 * the Surface uses to derive the member's single Conversation and to call
 * `/workspace-chat`, so the whole open→drain→turn flow stays on one member.
 *
 * `GET /events/pending` is retrieval only — it does not run agents, consume
 * credit, or mutate the queue.
 *
 * Task 8 (mark-processed / no-replay, Req 6.4, Property 5) adds the companion
 * write seam here: `POST /events/pending/ack`. After the Surface has driven a
 * workspace-chat turn for a drained Event, it calls this endpoint with the
 * queued Event ids; each id is flipped to `processed` via
 * `EventQueueStore.markProcessed`, which removes it from `listPending`. So on a
 * later open the same Event is no longer returned by `GET /events/pending` and
 * cannot create another agent turn (Property 5). This mirrors the online ack
 * seam (`POST /events/ack` on the delivery buffer) for the offline→reopen path.
 *
 * Both routes are scoped to the VERIFIED claim `sub`, so a member can only ever
 * drain and ack their OWN queue. Acking is idempotent and fail-safe: an
 * already-processed id or an unknown id is a harmless no-op, so a retried ack
 * (e.g. after a dropped response) never errors and never affects another
 * member. Turns are driven BEFORE the ack, so a failed turn leaves the Event
 * pending for the next open (Req 9.3) rather than silently dropping it.
 */
export interface PendingEventsRoutesOptions {
  /** Shared Event_Queue store (same instance the ingress/offline path fills). */
  queue: EventQueueStore;
  /**
   * Auth middleware that verifies the member's invocation token and populates
   * `response.locals.sota` with the member claims (`sub`). Injected so this
   * module stays testable without a real Core JWKS; defaults to the standard
   * Sota invocation guard for the `app:http` scope. Mirrors the poll routes.
   */
  authenticate?: RequestHandler;
}

/** Scope required to read a member's pending Events from the Surface. */
export const PENDING_EVENTS_SCOPE = 'app:http';

export function registerPendingEventsRoutes(
  app: Express,
  appId: string,
  options: PendingEventsRoutesOptions,
) {
  const { queue } = options;
  const authenticate = options.authenticate ?? requireSotaInvocation(appId, PENDING_EVENTS_SCOPE);

  app.get('/events/pending', authenticate, (_request, response) => {
    // The member id is the verified subject of the invocation token. Scoping to
    // `sub` (not a body/query field) is what makes this endpoint safe: there is
    // no way to ask for another member's queue.
    const memberId = memberIdFromClaims(response.locals);
    if (!memberId) {
      response
        .status(401)
        .json({ code: 'AUTH_ERROR', message: 'Invocation token has no member subject' });
      return;
    }

    const pending = queue.listPending(memberId);
    response.json(buildPendingEventsResponse(memberId, pending));
  });

  // POST /events/pending/ack — the Surface confirms it has driven a turn for the
  // given drained Event ids; each id is marked processed so it is not returned
  // (and cannot create another agent turn) on a later open (Req 6.4, Property 5).
  //
  // Scoped to the verified `sub`: a member can only ack their OWN queue. Marking
  // is idempotent — an already-processed or unknown id is a harmless no-op — so
  // a retried ack never errors. Returns how many ids were newly marked processed.
  app.post('/events/pending/ack', authenticate, (request, response) => {
    const memberId = memberIdFromClaims(response.locals);
    if (!memberId) {
      response
        .status(401)
        .json({ code: 'AUTH_ERROR', message: 'Invocation token has no member subject' });
      return;
    }

    const ids = readIds(request);
    // Only ids that are currently PENDING represent a real pending→processed
    // transition. An id that is unknown, expired, or already processed is a
    // harmless no-op — that idempotency is what makes retried acks safe (Req
    // 6.4). We compute the transition set against the live pending queue so a
    // repeated ack reports `processed: 0` rather than double-counting.
    const pendingIds = new Set(queue.listPending(memberId).map((event) => event.id));
    let processed = 0;
    for (const id of ids) {
      if (!pendingIds.has(id)) continue;
      if (queue.markProcessed(memberId, id)) processed += 1;
    }

    response.status(200).json({ memberId, processed });
  });
}

/** Coerce the request `ids` into a clean, de-duplicated array of non-empty strings. */
function readIds(request: Request): string[] {
  const raw = (request.body as { ids?: unknown } | undefined)?.ids;
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  for (const value of raw) {
    if (typeof value === 'string' && value.trim().length > 0) seen.add(value);
  }
  return [...seen];
}

/** Read the member id from the VERIFIED token claims (`sub`). */
function memberIdFromClaims(locals: Record<string, unknown>): string | undefined {
  const claims = locals.sota as Partial<InvocationClaims> | undefined;
  const sub = claims?.sub;
  return typeof sub === 'string' && sub.trim().length > 0 ? sub.trim() : undefined;
}
