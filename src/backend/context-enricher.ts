/**
 * Task 14 — Tool làm giàu Context (tùy chọn) / Context-enrichment tool core.
 *
 * Requirement 11.3: the App interprets an Event payload per each customer's own
 * business WITHOUT Core needing to understand it. This module is the runtime,
 * agent-callable counterpart of `proactive-context.ts`'s ingest-time loader:
 * during a workspace-chat turn the agent may call the App's `enrich-context`
 * tool to pull richer business data related to the proactive Event (e.g. look
 * up an order/ticket by id that appeared in the payload).
 *
 * Like the Context loader this is a clean, PLUGGABLE / tenant-overridable seam:
 * a customer registers an `EnrichmentResolver` for its own `type` values and
 * data sources; the default implementation is a dependency-free stub that
 * echoes back a normalized view of the reference it was given (real customer
 * data sources are out of scope here). Core never opens the returned `data`.
 *
 * The module is intentionally pure and side-effect free so it is trivially
 * unit-testable and safe to call before any network/data work.
 */

/** What the agent asks the App to enrich. `type` + `reference` are App-owned. */
export interface EnrichmentRequest {
  /**
   * The business kind of thing to look up, e.g. `order`, `ticket`, `cart`.
   * The App owns this taxonomy; Core does not interpret it (Req 11.3).
   */
  type: string;
  /** The identifier to look up, typically taken from the Event payload. */
  reference: string;
  /** Optional free-form hints the resolver may use (e.g. locale, fields). */
  hints?: Record<string, unknown>;
}

/** The enriched business data returned to the agent. Opaque to Core. */
export interface EnrichmentResult {
  /** Whether a record was found for the reference. */
  found: boolean;
  /** Echo of the requested business kind. */
  type: string;
  /** Echo of the requested reference. */
  reference: string;
  /** Short, human-readable summary the agent can read directly. */
  summary: string;
  /**
   * App-owned structured business data. Core forwards this untouched; a real
   * customer resolver fills it from its own system of record (Req 11.3).
   */
  data: Record<string, unknown>;
}

/**
 * A tenant-overridable enrichment function. Given a validated request, return
 * the enriched business data. Resolvers are pure with respect to the App core:
 * any I/O (DB, HTTP to the customer's system) lives inside a customer resolver.
 */
export type EnrichmentResolver = (
  request: EnrichmentRequest,
) => EnrichmentResult | Promise<EnrichmentResult>;

/** Thrown when the tool input cannot be read as a valid enrichment request. */
export class InvalidEnrichmentRequestError extends Error {
  constructor(
    message: string,
    readonly reason: 'MALFORMED_BODY' | 'MISSING_TYPE' | 'MISSING_REFERENCE',
  ) {
    super(message);
    this.name = 'InvalidEnrichmentRequestError';
  }
}

/**
 * Parse and validate a raw tool input into an `EnrichmentRequest` (Req 11.3).
 * Only the two routing fields the App understands are required; `hints` is
 * carried through untouched when it is an object.
 */
export function readEnrichmentRequest(raw: unknown): EnrichmentRequest {
  if (!isRecord(raw)) {
    throw new InvalidEnrichmentRequestError('enrichment input must be a JSON object', 'MALFORMED_BODY');
  }
  const type = firstNonEmptyString(raw.type);
  if (!type) {
    throw new InvalidEnrichmentRequestError('enrichment request has no type', 'MISSING_TYPE');
  }
  const reference = firstNonEmptyString(raw.reference, raw.id, raw.ref);
  if (!reference) {
    throw new InvalidEnrichmentRequestError('enrichment request has no reference', 'MISSING_REFERENCE');
  }
  return {
    type,
    reference,
    ...(isRecord(raw.hints) ? { hints: raw.hints } : {}),
  };
}

/**
 * Default, dependency-free resolver. Real customer data sources are out of
 * scope, so this returns a deterministic, neutral echo of the reference — it
 * proves the seam works end to end and is safe as a fallback. Deterministic (no
 * timestamps/randomness) so tests are stable.
 */
export const defaultEnrichmentResolver: EnrichmentResolver = (request) => ({
  found: false,
  type: request.type,
  reference: request.reference,
  summary: `No enrichment source configured for "${request.type}" ${request.reference}; returning the reference as-is.`,
  data: {
    type: request.type,
    reference: request.reference,
    ...(request.hints ? { hints: request.hints } : {}),
  },
});

/**
 * Registry of tenant-overridable resolvers keyed by business `type`. This is
 * the seam a customer plugs into: `register('order', myOrderLookup)`. Unknown
 * types fall back to the default resolver so the tool never fails just because
 * a type is unmapped.
 */
export class EnrichmentRegistry {
  private readonly resolvers = new Map<string, EnrichmentResolver>();

  constructor(private readonly fallback: EnrichmentResolver = defaultEnrichmentResolver) {}

  /** Register (or replace) the resolver for a business `type`. */
  register(type: string, resolver: EnrichmentResolver): this {
    this.resolvers.set(type, resolver);
    return this;
  }

  /** The resolver for a `type`, or the fallback when none is registered. */
  resolverFor(type: string): EnrichmentResolver {
    return this.resolvers.get(type) ?? this.fallback;
  }

  /**
   * Run enrichment for a raw tool input: validate, pick the resolver, execute.
   * Throws `InvalidEnrichmentRequestError` on bad input so the route can map it
   * to a stable 400.
   */
  async enrich(raw: unknown): Promise<EnrichmentResult> {
    const request = readEnrichmentRequest(raw);
    return this.resolverFor(request.type)(request);
  }
}

/** Process-wide default registry used by the route when none is injected. */
export const defaultEnrichmentRegistry = new EnrichmentRegistry();

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
