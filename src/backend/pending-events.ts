/**
 * Pending-Events retrieval — pure logic for "process pending Events on open"
 * (Task 7, Req 6.1, 6.2).
 *
 * When the member opens the App_Surface, the Surface asks the App_Backend for
 * the member's pending Events (Req 6.1). The Backend returns only the Events
 * that belong to the AUTHENTICATED member — the member id comes from the
 * verified invocation claims (`sub`), never from the request body — so a member
 * can only ever drain their OWN queue. The Surface then loads Context from each
 * Event and drives a workspace-chat turn using the member's own session
 * (Req 6.2, Property 2).
 *
 * This module holds the deterministic, side-effect-free pieces so they are
 * trivially unit-testable:
 *   - shaping a `QueuedEvent` into the Surface-facing DTO the poll endpoint
 *     returns (the App-owned `payload` is forwarded untouched — Req 2.4);
 *   - turning a pending Event into the `InboundEvent` shape the Context loader
 *     consumes, so the Surface reuses the SAME context seam as the online path.
 *
 * Marking Events processed / dedupe (Task 8) and merge / rate-limit (Task 10)
 * are deliberately NOT done here — this module only *retrieves* and *shapes*.
 * Those tasks own the seam that decides which of these Events actually run and
 * flips them to `processed`; keeping retrieval pure lets them compose cleanly.
 */

import type { QueuedEvent } from './event-queue.js';
import type { InboundEvent } from './proactive-types.js';

/**
 * A pending Event as returned to the App_Surface. Mirrors the queue record but
 * only exposes what the Surface needs to load Context and render — the internal
 * `status` is omitted because everything returned here is pending by
 * definition. `payload` is the App-owned business data, forwarded untouched.
 */
export interface PendingEventDto {
  /** Stable per-member id — the Surface echoes this back when marking done. */
  id: string;
  /** Business event type. */
  type: string;
  /** App-owned business payload, forwarded untouched (Req 2.4). */
  payload: unknown;
  /** Dedupe key carried from the inbound Event when present. */
  idempotencyKey?: string;
  /** Epoch millis the Event was accepted into the queue. */
  receivedAt: number;
}

/** The response body of the pending-events endpoint. */
export interface PendingEventsResponse {
  /** The authenticated member the Events belong to (echoed for clarity). */
  memberId: string;
  /** Pending Events, oldest first (queue order preserved). */
  events: PendingEventDto[];
}

/** Shape a single queued Event into the Surface-facing DTO. */
export function toPendingEventDto(event: QueuedEvent): PendingEventDto {
  return {
    id: event.id,
    type: event.type,
    payload: event.payload,
    ...(event.idempotencyKey ? { idempotencyKey: event.idempotencyKey } : {}),
    receivedAt: event.receivedAt,
  };
}

/**
 * Build the pending-events response for a member from their pending queue.
 * Pure over its input list so the same queue always yields the same response.
 */
export function buildPendingEventsResponse(
  memberId: string,
  pending: ReadonlyArray<QueuedEvent>,
): PendingEventsResponse {
  return {
    memberId,
    events: pending.map(toPendingEventDto),
  };
}

/**
 * Turn a pending Event (as seen by the Surface) into the `InboundEvent` shape
 * the Context loader consumes. This lets the Surface reuse the SAME context
 * seam (`loadProactiveContext`) as the online delivery path, so a queued Event
 * and a live Event produce Context identically (Req 6.2 mirrors Req 4.2).
 */
export function pendingEventToInbound(
  event: PendingEventDto,
  subjectKey: string,
): InboundEvent {
  return {
    type: event.type,
    subjectKey,
    ...(event.idempotencyKey ? { idempotencyKey: event.idempotencyKey } : {}),
    timestamp: new Date(event.receivedAt).toISOString(),
    mode: 'active',
    surface: 'workspace',
    ...(event.payload !== undefined ? { data: event.payload } : {}),
  };
}
