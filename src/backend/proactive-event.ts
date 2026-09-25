import {
  buildProactiveTurnRequest,
  requestProactiveTurn,
  type CoreCallContext,
} from './core-client.js';
import { loadProactiveContext } from './proactive-context.js';
import type {
  InboundEvent,
  ProactiveMode,
  ProactiveSurface,
  ProactiveTurnResult,
} from './proactive-types.js';

/**
 * Handle one inbound Event end to end (Task 7):
 *   1. load business context on the App side (Req 1.6, 12.4);
 *   2. build the standard Envelope from the event + VERIFIED tenant claims;
 *   3. call Core's `Proactive_Turn_API`, authenticated with the App's
 *      delegated Core credential (Req 1.5).
 *
 * `deps.callCore` is injectable so tests can drive the flow without a network.
 */
export async function handleProactiveEvent(
  event: InboundEvent,
  context: CoreCallContext,
  deps: { callCore?: typeof requestProactiveTurn } = {},
): Promise<ProactiveTurnResult> {
  const callCore = deps.callCore ?? requestProactiveTurn;
  const loaded = await loadProactiveContext(event);
  const request = buildProactiveTurnRequest(event, loaded, context.claims);
  return callCore(request, context);
}

/**
 * Parse and validate the raw request body into a typed InboundEvent. Throws a
 * ProactiveEventValidationError naming the offending field so the route maps it
 * to a 4xx (the App validates shape before doing domain work).
 */
export function parseInboundEvent(raw: unknown): InboundEvent {
  if (!isRecord(raw)) {
    throw new ProactiveEventValidationError('event body must be a JSON object');
  }
  const type = requireNonEmptyString(raw.type, 'type');
  const subjectKey = requireNonEmptyString(raw.subjectKey, 'subjectKey');
  const mode = optionalEnum<ProactiveMode>(raw.mode, ['active', 'passive'], 'mode');
  const surface = optionalEnum<ProactiveSurface>(raw.surface, ['guest', 'workspace'], 'surface');
  return {
    type,
    subjectKey,
    ...(isNonEmptyString(raw.idempotencyKey) ? { idempotencyKey: raw.idempotencyKey } : {}),
    ...(isNonEmptyString(raw.timestamp) ? { timestamp: raw.timestamp } : {}),
    ...(mode ? { mode } : {}),
    ...(surface ? { surface } : {}),
    ...(raw.data !== undefined ? { data: raw.data } : {}),
  };
}

export class ProactiveEventValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProactiveEventValidationError';
  }
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (!isNonEmptyString(value)) {
    throw new ProactiveEventValidationError(`${field} is required`);
  }
  return value;
}

function optionalEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new ProactiveEventValidationError(`${field} must be one of ${allowed.join(', ')}`);
  }
  return value as T;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
