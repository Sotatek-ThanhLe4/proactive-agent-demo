import { randomUUID } from 'node:crypto';
import type { InvocationClaims } from './sota-auth.js';
import type {
  InboundEvent,
  ProactiveContext,
  ProactiveTurnRequest,
  ProactiveTurnResult,
} from './proactive-types.js';

export const DEFAULT_CORE_ORIGIN = 'https://api.v4.stg.sotaagents.ai';
export const PROACTIVE_TURN_PATH = '/sota/v1/proactive/turn';
/** Bound so a slow or hung Core never wedges an event handler. */
const CORE_REQUEST_TIMEOUT_MS = 15_000;

/** Everything an outbound Core call needs from the verified inbound invocation. */
export interface CoreCallContext {
  /** Verified tenant claims — never taken from the request body. */
  claims: InvocationClaims;
  /**
   * The short-lived delegated Core capability token. This is the App credential
   * Core authenticates (Req 1.5): the App presents it as a Bearer token, Core's
   * SotaAuthGuard verifies it and binds the call to the App's signed tenant.
   */
  coreToken: string | undefined;
}

export class CoreClientError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'CoreClientError';
  }
}

function coreOrigin(): string {
  return (process.env.SOTA_CORE_ORIGIN ?? DEFAULT_CORE_ORIGIN).replace(/\/+$/, '');
}

/**
 * Build the standard Proactive_Turn Envelope from an inbound Event, the loaded
 * business context, and the VERIFIED tenant claims.
 *
 * Tenant comes from the signed invocation claims (`oid`/`wid`), NOT from the
 * event body — Core also re-checks this against the token, so a spoofed body
 * cannot cross tenants (Req 10). Envelope required fields {type, subjectKey,
 * tenant, timestamp} are always populated; a missing idempotencyKey is filled
 * with a fresh UUID so Core never sees an empty key.
 */
export function buildProactiveTurnRequest(
  event: InboundEvent,
  context: ProactiveContext,
  claims: InvocationClaims,
): ProactiveTurnRequest {
  return {
    type: event.type,
    subjectKey: event.subjectKey,
    tenant: {
      organizationId: claims.oid,
      workspaceId: claims.wid,
    },
    idempotencyKey: event.idempotencyKey?.trim() || randomUUID(),
    timestamp: event.timestamp?.trim() || new Date().toISOString(),
    mode: event.mode ?? 'active',
    surface: event.surface ?? 'guest',
    context,
  };
}

/**
 * Call Core's `Proactive_Turn_API` (App → Core reverse call, Req 1.1).
 *
 * Authenticated with the App's delegated Core capability token — the SAME
 * mechanism every other App → Core `sota/v1` call uses (see office/knowledge-base
 * apps). We do not invent a proactive-only credential.
 */
export async function requestProactiveTurn(
  request: ProactiveTurnRequest,
  context: CoreCallContext,
  fetchImpl: typeof fetch = fetch,
): Promise<ProactiveTurnResult> {
  if (!context.coreToken) {
    throw new CoreClientError('Missing delegated Core token; cannot call Proactive_Turn_API');
  }
  const url = `${coreOrigin()}${PROACTIVE_TURN_PATH}`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${context.coreToken}`,
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(CORE_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new CoreClientError(`Proactive_Turn_API request failed: ${reason}`);
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    const detail =
      stringFrom(body.reason) ?? stringFrom(body.message) ?? `HTTP ${response.status}`;
    throw new CoreClientError(`Proactive_Turn_API rejected: ${detail}`, response.status);
  }
  return (await response.json()) as ProactiveTurnResult;
}

function stringFrom(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}
