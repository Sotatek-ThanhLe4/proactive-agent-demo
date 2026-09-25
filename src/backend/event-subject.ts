/**
 * Requirement 2 — Nhận Event gắn Subject (App_Backend).
 *
 * The App_Backend receives an Event and must read the Subject (the member
 * identity the Event belongs to) so the Event can later be routed into the
 * right member's conversation and charged to the right member. If an Event has
 * no valid Subject it is rejected and never processed (Req 2.2, 2.3).
 *
 * This module deliberately does NOT interpret business semantics: it only pulls
 * out the two routing fields the App cares about — the member Subject and the
 * Event `type` — and forwards the rest of the payload untouched (Req 2.4). Each
 * customer/tenant interprets `data` later in its own context loader.
 */

/** A member identity extracted from an inbound Event. Opaque, tenant-scoped. */
export interface EventSubject {
  /** Stable member identifier used to route the Event to a conversation. */
  memberId: string;
}

/**
 * A validated inbound Event: the routing fields the App understands, plus the
 * untouched business payload the App does not interpret (Req 2.4).
 */
export interface RoutedEvent {
  /** Business event type, e.g. `order.shipped`. App owns the taxonomy. */
  type: string;
  /** The member this Event belongs to (Subject). */
  subject: EventSubject;
  /** Optional dedupe key forwarded downstream when present. */
  idempotencyKey?: string;
  /** ISO timestamp of the Event; defaults to now when absent. */
  timestamp: string;
  /** Free-form business payload — App-owned, not interpreted here (Req 2.4). */
  data?: unknown;
}

/** Thrown when an Event cannot be routed — a missing Subject or missing type. */
export class InvalidEventError extends Error {
  constructor(
    message: string,
    /** Machine-readable reason so the route can pick a stable response code. */
    readonly reason: 'MISSING_SUBJECT' | 'MISSING_TYPE' | 'MALFORMED_BODY',
  ) {
    super(message);
    this.name = 'InvalidEventError';
  }
}

/**
 * Read the Subject (member identity) from a raw Event body (Req 2.2).
 *
 * A valid Subject may arrive either as a top-level `memberId`/`subjectKey`, or
 * nested under `subject: { memberId }`. All forms must resolve to a non-empty
 * member id, otherwise the Event has no valid Subject (Req 2.3).
 */
export function readEventSubject(raw: unknown): EventSubject {
  if (!isRecord(raw)) {
    throw new InvalidEventError('event body must be a JSON object', 'MALFORMED_BODY');
  }
  const memberId = firstNonEmptyString(
    isRecord(raw.subject) ? raw.subject.memberId : undefined,
    isRecord(raw.subject) ? raw.subject.subjectKey : undefined,
    raw.memberId,
    raw.subjectKey,
  );
  if (!memberId) {
    throw new InvalidEventError('event has no valid Subject (member identity)', 'MISSING_SUBJECT');
  }
  return { memberId };
}

/**
 * Validate a raw Event body into a RoutedEvent: require a Subject and a `type`,
 * carry the rest through untouched (Req 2.2, 2.3, 2.4).
 */
export function routeInboundEvent(raw: unknown): RoutedEvent {
  if (!isRecord(raw)) {
    throw new InvalidEventError('event body must be a JSON object', 'MALFORMED_BODY');
  }
  const subject = readEventSubject(raw);
  const type = firstNonEmptyString(raw.type);
  if (!type) {
    throw new InvalidEventError('event has no type to route on', 'MISSING_TYPE');
  }
  return {
    type,
    subject,
    ...(isNonEmptyString(raw.idempotencyKey) ? { idempotencyKey: raw.idempotencyKey.trim() } : {}),
    timestamp: isNonEmptyString(raw.timestamp) ? raw.timestamp.trim() : new Date().toISOString(),
    ...(raw.data !== undefined ? { data: raw.data } : {}),
  };
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (isNonEmptyString(value)) return value.trim();
  }
  return undefined;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
