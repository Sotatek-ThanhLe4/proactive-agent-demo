/**
 * Event_Queue — per-member queue of Events stored while a member is Offline
 * (Task 6, Req 5, design "Data Models").
 *
 * While a member is Offline, an inbound Event is NOT handed to an agent and no
 * credit is consumed; instead the Event is stored here (Req 5.1, 5.2). The
 * Event stays queued until it is processed OR it expires per the configured
 * retention policy (Req 5.3). Later tasks drain the queue when the member
 * returns (Task 7) and mark Events processed so they are not handled twice
 * (Task 8, Property 5).
 *
 * The store is per member: each member has an independent list of queued
 * Events. It is in-memory and dependency-free (no `node:crypto`, no DB) so it
 * is trivially unit-testable; a durable adapter can implement the same shape
 * later without changing callers.
 *
 * Retention (Req 5.3): each queued Event carries `receivedAt`. An Event is
 * considered expired once `now - receivedAt > retentionMs`. Expiry is applied
 * lazily on read/enqueue (no timers) so behaviour is deterministic and testable
 * by injecting `now`.
 */

import type { RoutedEvent } from './event-subject.js';

/** Lifecycle of a queued Event. */
export type QueuedEventStatus = 'pending' | 'processed';

/**
 * A single Event stored in a member's queue. Mirrors the design data model:
 * {type, payload, subject, receivedAt, status}. `payload` is the App-owned
 * business data carried untouched from the RoutedEvent (Req 2.4).
 */
export interface QueuedEvent {
  /** Stable per-member id for this queued Event (for mark-processed, dedupe). */
  id: string;
  /** Business event type. */
  type: string;
  /** App-owned business payload, forwarded untouched. */
  payload: unknown;
  /** The member this Event belongs to (Subject). */
  subject: RoutedEvent['subject'];
  /** Dedupe key carried from the inbound Event when present. */
  idempotencyKey?: string;
  /** Epoch millis the Event was accepted into the queue (for retention). */
  receivedAt: number;
  /** pending until drained/processed by a later task. */
  status: QueuedEventStatus;
}

export interface EventQueueOptions {
  /**
   * Retention window in millis (Req 5.3). An Event older than this is expired
   * and dropped rather than kept forever. Defaults to 7 days. Must be > 0.
   */
  retentionMs?: number;
  /** Injectable clock for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
}

const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export class EventQueueStore {
  /** member id → ordered list of queued Events (oldest first). */
  private readonly byMember = new Map<string, QueuedEvent[]>();
  private readonly retentionMs: number;
  private readonly now: () => number;
  private sequence = 0;

  constructor(options: EventQueueOptions = {}) {
    const retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
    if (!Number.isFinite(retentionMs) || retentionMs <= 0) {
      throw new RangeError('retentionMs must be a positive, finite number of milliseconds');
    }
    this.retentionMs = retentionMs;
    this.now = options.now ?? Date.now;
  }

  /**
   * Store an inbound Event into its member's queue (Req 5.1). Returns the queued
   * Event. Does NOT run any agent and does NOT consume credit — persistence is
   * the only side effect (Req 5.2, Property 3).
   */
  enqueue(event: RoutedEvent): QueuedEvent {
    const memberId = event.subject.memberId;
    const receivedAt = this.parseReceivedAt(event.timestamp);
    const queued: QueuedEvent = {
      id: `q_${(this.sequence += 1)}`,
      type: event.type,
      payload: event.data,
      subject: event.subject,
      ...(event.idempotencyKey ? { idempotencyKey: event.idempotencyKey } : {}),
      receivedAt,
      status: 'pending',
    };
    const list = this.prune(memberId);
    list.push(queued);
    return queued;
  }

  /** All non-expired Events currently in a member's queue (any status). */
  list(memberId: string): QueuedEvent[] {
    // Return a copy so callers cannot mutate internal state.
    return this.prune(memberId).map((event) => ({ ...event }));
  }

  /** Only the pending (not-yet-processed, not-expired) Events for a member. */
  listPending(memberId: string): QueuedEvent[] {
    return this.list(memberId).filter((event) => event.status === 'pending');
  }

  /** Count of pending Events for a member. */
  pendingCount(memberId: string): number {
    return this.prune(memberId).reduce(
      (count, event) => (event.status === 'pending' ? count + 1 : count),
      0,
    );
  }

  /**
   * Mark a queued Event processed so it is not handled again (Req 6.4 / Task 8).
   * Returns true when an Event with that id existed and is now processed.
   */
  markProcessed(memberId: string, eventId: string): boolean {
    const list = this.prune(memberId);
    const event = list.find((candidate) => candidate.id === eventId);
    if (!event) return false;
    event.status = 'processed';
    return true;
  }

  /**
   * Drop expired Events for a member and return the live list. Expiry is the
   * configured retention policy (Req 5.3): an Event is expired once it is older
   * than `retentionMs`.
   */
  private prune(memberId: string): QueuedEvent[] {
    requireMemberId(memberId);
    const cutoff = this.now() - this.retentionMs;
    const existing = this.byMember.get(memberId) ?? [];
    const live = existing.filter((event) => event.receivedAt > cutoff);
    if (live.length > 0) {
      this.byMember.set(memberId, live);
    } else {
      this.byMember.delete(memberId);
      return this.ensureList(memberId);
    }
    return live;
  }

  private ensureList(memberId: string): QueuedEvent[] {
    let list = this.byMember.get(memberId);
    if (!list) {
      list = [];
      this.byMember.set(memberId, list);
    }
    return list;
  }

  /** Parse the Event timestamp to epoch millis; fall back to now if unusable. */
  private parseReceivedAt(timestamp: string): number {
    const parsed = Date.parse(timestamp);
    return Number.isNaN(parsed) ? this.now() : parsed;
  }
}

function requireMemberId(memberId: string): string {
  if (typeof memberId !== 'string' || memberId.trim().length === 0) {
    throw new TypeError('memberId must be a non-empty string');
  }
  return memberId;
}
