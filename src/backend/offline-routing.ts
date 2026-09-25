/**
 * Offline routing seam (Task 6, Req 5, Property 3 & 4).
 *
 * Task 3 built the ingress route with an injectable `onEvent` seam. This module
 * fills that seam for the OFFLINE path: given a member's PresenceState and their
 * Event_Queue, when a verified Event arrives for an Offline member it is stored
 * into that member's queue and NOTHING else happens — no agent turn, no credit
 * (Req 5.1, 5.2 / Property 3). The Event then stays queued until processed or
 * expired (Req 5.3 / Property 4), which the queue store enforces.
 *
 * When the member is Online, offline routing does not own the Event: it defers
 * to the online delivery seam (Task 4) via the optional `onOnline` callback. If
 * no online handler is wired yet, the Event is left for a later task and this
 * module reports that it did not queue it (so no Event is silently dropped).
 */

import type { RoutedEvent } from './event-subject.js';
import type { EventQueueStore, QueuedEvent } from './event-queue.js';
import type { PresenceStateStore } from './presence-state.js';

/** What offline routing did with an Event, for logging/tests. */
export type RouteOutcome =
  | { disposition: 'queued'; queued: QueuedEvent }
  | { disposition: 'online' };

export interface OfflineRoutingDeps {
  presence: PresenceStateStore;
  queue: EventQueueStore;
  /**
   * Online delivery seam (Task 4). Called instead of queueing when the member
   * is Online. Absent until Task 4 wires it; when absent, an Online member's
   * Event is still queued so it is never lost (fail-safe for Property 4).
   */
  onOnline?: (event: RoutedEvent) => void | Promise<void>;
}

/**
 * Build the `onEvent` handler to hand to `registerEventIngressRoutes`.
 *
 * Offline member → enqueue (no agent, no credit). Online member → hand to the
 * online seam if present, else enqueue as a fail-safe.
 */
export function createOfflineEventRouter(
  deps: OfflineRoutingDeps,
): (event: RoutedEvent) => Promise<RouteOutcome> {
  const { presence, queue, onOnline } = deps;

  return async function routeEvent(event: RoutedEvent): Promise<RouteOutcome> {
    const memberId = event.subject.memberId;

    if (presence.isOnline(memberId) && onOnline) {
      // Online: the online delivery seam owns this Event. We must NOT queue it
      // here as well, or the member could be handled twice.
      await onOnline(event);
      return { disposition: 'online' };
    }

    // Offline (or Online with no online seam wired yet): store the Event only.
    // No agent runs and no credit is consumed on this path (Property 3).
    const queued = queue.enqueue(event);
    return { disposition: 'queued', queued };
  };
}
