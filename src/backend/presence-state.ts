/**
 * PresenceState — member → online/offline (Task 6, design "Data Models").
 *
 * A member is Online while their App_Surface is connected (has an active
 * session open); otherwise the member is Offline. The App_Backend consults this
 * state to decide how to route an inbound Event:
 *   - Online  → hand the Event to the Surface (Task 4);
 *   - Offline → store the Event into that member's Event_Queue (Req 5.1) and do
 *     NOT run the agent / consume credit (Req 5.2).
 *
 * This is an intentionally small in-memory store: presence is derived from live
 * Surface connections, so it does not need to survive a restart (a disconnected
 * Surface is simply Offline). It is pure and dependency-free so it is trivially
 * testable and safe to reuse across the backend.
 *
 * Presence model (Task 4, poll — OQ1): the Surface has no long-lived socket, it
 * POLLS. So "connected" is expressed as a HEARTBEAT: each poll marks the member
 * online, and presence EXPIRES if polls stop for longer than a configured TTL.
 * When a `ttlMs` is configured, `markOnline` records the time of the heartbeat
 * and `isOnline` returns true only while the last heartbeat is within the TTL —
 * so a member whose Surface closed (polls stopped) correctly becomes Offline
 * and subsequent Events are queued instead of delivered.
 *
 * When NO `ttlMs` is configured the store is sticky (online until `markOffline`),
 * preserving the original behaviour for callers that manage presence explicitly.
 *
 * The default presence for a member the store has never seen is Offline: absent
 * evidence of a connected Surface, we must not run the agent, and instead queue
 * — this is the conservative choice that protects Property 3 (offline == no
 * credit) and Property 4 (no Event lost).
 */

export type Presence = 'online' | 'offline';

export interface PresenceStateOptions {
  /**
   * Heartbeat time-to-live in millis. When set, a member is Online only while
   * their last `markOnline` heartbeat is within this window; polls refresh it.
   * When omitted, presence is sticky (online until an explicit `markOffline`).
   */
  ttlMs?: number;
  /** Injectable clock for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
}

export class PresenceStateStore {
  /** Members currently known to have a connected Surface → last heartbeat ms. */
  private readonly online = new Map<string, number>();
  private readonly ttlMs?: number;
  private readonly now: () => number;

  constructor(options: PresenceStateOptions = {}) {
    if (options.ttlMs !== undefined) {
      if (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0) {
        throw new RangeError('ttlMs must be a positive, finite number of milliseconds');
      }
    }
    this.ttlMs = options.ttlMs;
    this.now = options.now ?? Date.now;
  }

  /**
   * Mark a member Online (their App_Surface connected / polled). With a TTL
   * configured this acts as a heartbeat that refreshes the online window.
   */
  markOnline(memberId: string): void {
    this.online.set(requireMemberId(memberId), this.now());
  }

  /** Mark a member Offline (their App_Surface disconnected). */
  markOffline(memberId: string): void {
    this.online.delete(requireMemberId(memberId));
  }

  /** Whether the member is currently Online (within TTL when configured). */
  isOnline(memberId: string): boolean {
    const key = requireMemberId(memberId);
    const lastSeen = this.online.get(key);
    if (lastSeen === undefined) return false;
    if (this.ttlMs === undefined) return true;
    if (this.now() - lastSeen <= this.ttlMs) return true;
    // Heartbeat expired: the Surface stopped polling → treat as Offline and
    // forget so future Events for this member are queued, not delivered.
    this.online.delete(key);
    return false;
  }

  /** The member's current presence; Offline when never seen (conservative). */
  presenceOf(memberId: string): Presence {
    return this.isOnline(memberId) ? 'online' : 'offline';
  }
}

function requireMemberId(memberId: string): string {
  if (typeof memberId !== 'string' || memberId.trim().length === 0) {
    throw new TypeError('memberId must be a non-empty string');
  }
  return memberId;
}
