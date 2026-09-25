/**
 * Responsive-event filtering — decide whether an Event type is "worth
 * responding to" (Task 11, Req 10.3, 10.4).
 *
 * Requirement 10.3: the App SHALL only run an agent turn for Event types
 * configured as "worth responding to".
 * Requirement 10.4: IF an Event is NOT of a "worth responding to" type, THEN
 * the App SHALL record the Event WITHOUT running an agent turn.
 *
 * This module is a pure, deterministic predicate factory. It holds no state and
 * no clock; given the same allow-list and the same type it always returns the
 * same answer (testable, isomorphic — runs identically in the browser surface
 * and in Node tests).
 *
 * It deliberately does NOT reimplement merge/cap (Task 10 owns the rate-control
 * internals). Instead it produces a {@link TypeFilter} that plugs straight into
 * the existing `admitTurns` `typeFilter`/`getType` seam: a candidate whose type
 * is not on the allow-list is suppressed (recorded/acked by the caller) and
 * never opens an agent turn (Req 10.4).
 *
 * Configuration source (Req 11.2): the allow-list is injected. When Task 13's
 * per-tenant config module exists, the caller passes that tenant's
 * responsive-types list here. Until then this module is self-contained: it
 * accepts any allow-list and ships a sensible default so the surface can wire it
 * without waiting on tenant config.
 */

import type { TypeFilter } from './rate-control.js';

/**
 * The App-owned taxonomy default (OQ4). A conservative starter set of event
 * types most tenants will treat as "worth responding to". Tenants override this
 * via their own config (Req 11.2); this exists only so Task 11 is usable before
 * Task 13's tenant config lands. Kept lowercase — matching is case-insensitive.
 */
export const DEFAULT_RESPONSIVE_EVENT_TYPES: readonly string[] = [
  'order.shipped',
  'order.delivered',
  'payment.failed',
  'ticket.assigned',
  'mention.created',
];

/**
 * A tenant's responsive-events configuration (Req 11.2). Task 13's tenant-config
 * module can produce this shape (or a superset of it); this task consumes only
 * the `responsiveEventTypes` allow-list.
 */
export interface ResponsiveEventConfig {
  /** Event types this tenant treats as "worth responding to" (Req 10.3). */
  responsiveEventTypes: readonly string[];
}

/** Normalize a type string for tolerant, case-insensitive matching. */
function normalizeType(type: string | undefined): string | undefined {
  if (typeof type !== 'string') return undefined;
  const trimmed = type.trim().toLowerCase();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Normalize an allow-list into a lookup Set of clean, lowercased type names.
 * Blank/non-string entries are dropped so a malformed config never admits an
 * empty-typed Event.
 */
function toAllowSet(types: readonly string[] | undefined): Set<string> {
  const set = new Set<string>();
  if (!Array.isArray(types)) return set;
  for (const type of types) {
    const normalized = normalizeType(type);
    if (normalized !== undefined) set.add(normalized);
  }
  return set;
}

/**
 * Decide whether a single Event `type` is "worth responding to" against an
 * allow-list (Req 10.3). Pure and case-insensitive.
 *
 * An Event with a missing/blank type is NOT worth responding to (there is no
 * configured type to match), so it is recorded without a turn (Req 10.4). An
 * empty allow-list means the tenant responds to nothing — every Event is
 * recorded only.
 */
export function isResponsiveEventType(
  type: string | undefined,
  allowList: readonly string[] | undefined,
): boolean {
  const normalized = normalizeType(type);
  if (normalized === undefined) return false;
  return toAllowSet(allowList).has(normalized);
}

/**
 * Build a {@link TypeFilter} for the `admitTurns` seam from an allow-list
 * (Req 10.3, 10.4).
 *
 * The returned predicate closes over a pre-computed lookup Set, so filtering a
 * batch of candidates is O(1) per candidate. Wire it into `admitTurns` via the
 * `typeFilter` option together with a `getType` that reads the candidate's
 * Event type; non-responsive types are then suppressed (recorded, no turn).
 *
 * Pass an explicit allow-list (e.g. a tenant's `responsiveEventTypes` from
 * Task 13), or omit it to use {@link DEFAULT_RESPONSIVE_EVENT_TYPES}.
 */
export function createResponsiveTypeFilter(
  allowList: readonly string[] = DEFAULT_RESPONSIVE_EVENT_TYPES,
): TypeFilter {
  const allow = toAllowSet(allowList);
  return (type: string | undefined): boolean => {
    const normalized = normalizeType(type);
    if (normalized === undefined) return false;
    return allow.has(normalized);
  };
}

/**
 * Convenience: build a {@link TypeFilter} from a {@link ResponsiveEventConfig}
 * (e.g. a tenant config from Task 13). Falls back to the default allow-list when
 * the config is absent so callers stay self-contained (Req 11.2).
 */
export function responsiveTypeFilterForConfig(
  config: ResponsiveEventConfig | undefined,
): TypeFilter {
  return createResponsiveTypeFilter(
    config?.responsiveEventTypes ?? DEFAULT_RESPONSIVE_EVENT_TYPES,
  );
}
