/**
 * Proactive Event-Driven Agent — App-side types (Task 7).
 *
 * The App receives an Event (external webhook or internal bus), loads business
 * context on its side (Req 1.6, 12.4), then calls Core's `Proactive_Turn_API`
 * with the standard Envelope + context. Core reads only the Envelope; the
 * `context` payload is App-owned and Core does NOT interpret its business
 * meaning (Req 1.3, 12.4).
 *
 * These mirror the Core contract (see api-gateway
 * `src/modules/proactive/proactive.types.ts`) so the request payload matches
 * exactly.
 */

/** Which surface the proactive turn targets. Both reuse the same Core core. */
export type ProactiveSurface = 'guest' | 'workspace';

/**
 * Passive = record the event as context only. Active = the event may drive the
 * agent to speak (Core applies the Control_Valve).
 */
export type ProactiveMode = 'active' | 'passive';

/** Tenant scope carried on every request (Req 10 — tenant isolation). */
export interface ProactiveTenant {
  organizationId: string;
  workspaceId: string;
}

/** App-loaded context. Opaque to Core; fed to the turn as input. */
export interface ProactiveContext {
  text?: string;
  parts?: unknown[];
}

/**
 * The raw inbound Event the App receives (webhook/bus). Only the fields the App
 * needs to build the Envelope are typed; `data` is the free-form business
 * payload the App interprets per each customer's own logic (Req 12.4).
 */
export interface InboundEvent {
  /** Business event type, e.g. `cart.item_added`. App owns the taxonomy. */
  type: string;
  /** Abstract end-user identity (guest session or member userId). */
  subjectKey: string;
  /** Dedupe key; forwarded to Core which enforces idempotency. */
  idempotencyKey?: string;
  /** ISO timestamp of the event; defaults to now when absent. */
  timestamp?: string;
  /** passive (context only) or active (may trigger a proactive turn). */
  mode?: ProactiveMode;
  /** guest or workspace surface. */
  surface?: ProactiveSurface;
  /** Free-form business payload — App-owned, Core never opens it. */
  data?: unknown;
}

/**
 * The full request the App sends to `POST /sota/v1/proactive/turn`. Matches the
 * Core `ProactiveTurnBody` exactly (Req 1.2).
 */
export interface ProactiveTurnRequest {
  type: string;
  subjectKey: string;
  tenant: ProactiveTenant;
  idempotencyKey: string;
  timestamp: string;
  mode: ProactiveMode;
  surface: ProactiveSurface;
  context: ProactiveContext;
}

/** Core's acknowledgement of an accepted proactive turn request. */
export interface ProactiveTurnResult {
  accepted: boolean;
  idempotencyKey: string;
  conversationId: string;
  contextMessageId: string;
  contextRecorded: boolean;
  runId?: string;
}
