/**
 * Online delivery buffer (Task 4, Req 4.1, 9.1, 9.2, 9.3).
 *
 * OQ1 resolved to POLL: the App does not push. Instead, while a member is
 * Online, an inbound Event for that member is buffered here, and the member's
 * App_Surface periodically polls "is there anything new?" and drains it (Req
 * 9.1). Because polling happens on a configured interval, an Event reaches the
 * Surface within a bounded, configured time (Req 9.2).
 *
 * Reliability (Req 9.3): an Event is NOT dropped the instant it is handed to a
 * poll response. If the Surface fails to process it (network drop mid-response,
 * a failed `/workspace-chat` call), the Event must remain undelivered so a later
 * poll / next open retries it. We model this with an explicit two-step lifecycle:
 *
 *   1. `poll(memberId)` returns the pending Events but LEAVES them pending
 *      (a peek, not a pop) — so a lost response loses nothing;
 *   2. `acknowledge(memberId, ids)` removes only the Events the Surface has
 *      confirmed it processed (its `/workspace-chat` turn started).
 *
 * A pending Event that is polled but never acknowledged is simply returned
 * again on the next poll — at-least-once delivery, which is safe because the
 * Event carries a stable id the Surface can dedupe on and because Core enforces
 * idempotency on the turn. This keeps the buffer honest about Property 4 (no
 * Event lost) on the online path too.
 *
 * The store is in-memory and dependency-free (no DB, no `node:crypto`) so it is
 * trivially unit-testable; a durable adapter can implement the same shape later
 * without changing callers.
 */

import type { RoutedEvent } from './event-subject.js';

/** A single Event buffered for online delivery to a member's Surface. */
export interface DeliverableEvent {
  /** Stable per-member id used to acknowledge / dedupe this Event. */
  id: string;
  /** Business event type. */
  type: string;
  /** App-owned business payload, forwarded untouched (Req 2.4). */
  data: unknown;
  /** The member this Event belongs to (Subject). */
  memberId: string;
  /** ISO timestamp carried from the inbound Event. */
  timestamp: string;
  /** Dedupe key carried from the inbound Event when present. */
  idempotencyKey?: string;
  /** Epoch millis the Event was buffered (for age / bounded retention). */
  bufferedAt: number;
}

export interface OnlineDeliveryOptions {
  /** Injectable clock for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
}

export class OnlineDeliveryStore {
  /** member id → ordered list of undelivered Events (oldest first). */
  private readonly byMember = new Map<string, DeliverableEvent[]>();
  private readonly now: () => number;
  private sequence = 0;

  constructor(options: OnlineDeliveryOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  /**
   * Buffer an inbound Event for online delivery (Req 4.1). Returns the buffered
   * Event. No agent runs here — the Surface will drive the turn on its next poll
   * using the member's own session (Property 2).
   */
  buffer(event: RoutedEvent): DeliverableEvent {
    const memberId = requireMemberId(event.subject.memberId);
    const deliverable: DeliverableEvent = {
      id: `d_${(this.sequence += 1)}`,
      type: event.type,
      data: event.data ?? null,
      memberId,
      timestamp: event.timestamp,
      ...(event.idempotencyKey ? { idempotencyKey: event.idempotencyKey } : {}),
      bufferedAt: this.now(),
    };
    const list = this.ensureList(memberId);
    list.push(deliverable);
    return deliverable;
  }

  /**
   * Peek at the Events waiting for a member (Req 9.1). Returns copies and leaves
   * them buffered so a failed delivery keeps them for retry (Req 9.3). Callers
   * MUST `acknowledge` the ids they have successfully handed to a turn.
   */
  poll(memberId: string): DeliverableEvent[] {
    const list = this.byMember.get(requireMemberId(memberId)) ?? [];
    return list.map((event) => ({ ...event }));
  }

  /** How many Events are still waiting for a member. */
  pendingCount(memberId: string): number {
    return (this.byMember.get(requireMemberId(memberId)) ?? []).length;
  }

  /**
   * Remove the Events a Surface has confirmed processed (Req 9.3). Unknown ids
   * are ignored so a duplicate ack is harmless. Returns the count removed.
   */
  acknowledge(memberId: string, ids: ReadonlyArray<string>): number {
    const key = requireMemberId(memberId);
    const list = this.byMember.get(key);
    if (!list || list.length === 0) return 0;
    const toRemove = new Set(ids);
    const before = list.length;
    const remaining = list.filter((event) => !toRemove.has(event.id));
    if (remaining.length === 0) {
      this.byMember.delete(key);
    } else {
      this.byMember.set(key, remaining);
    }
    return before - remaining.length;
  }

  private ensureList(memberId: string): DeliverableEvent[] {
    let list = this.byMember.get(memberId);
    if (!list) {
      list = [];
      this.byMember.set(memberId, list);
    }
    return list;
  }
}

function requireMemberId(memberId: string): string {
  if (typeof memberId !== 'string' || memberId.trim().length === 0) {
    throw new TypeError('memberId must be a non-empty string');
  }
  return memberId;
}
