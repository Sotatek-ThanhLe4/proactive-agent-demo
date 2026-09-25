/**
 * Per-tenant configuration (Task 13, Req 11).
 *
 * The App is a shared framework/template that many customers reuse via
 * configuration alone (Req 11.1). Two things vary per customer/tenant:
 *
 *   1. The list of Event `type`s that are "worth responding to" (Req 11.2).
 *      Everything else is recorded but does not drive an agent turn. This is
 *      the config that Task 11 feeds into the rate controller's `typeFilter`
 *      seam (see {@link buildTenantTypeFilter}) — we expose it here without
 *      touching `rate-control.ts`.
 *
 *   2. How the tenant's own business `data` payload is interpreted into the
 *      App-owned Context (Req 11.3). Core never opens the payload, so each
 *      tenant maps its own Event shape into a {@link ProactiveContext} here.
 *      The seam is kept consistent with the existing `loadProactiveContext`
 *      loader (`src/backend/proactive-context.ts`): a tenant interpreter has the
 *      same signature and returns the same Context contract, so the loader can
 *      simply delegate to the resolved tenant interpreter.
 *
 * The module is intentionally pure and dependency-free: resolving a tenant's
 * config is a deterministic lookup with sensible defaults, so it is trivially
 * unit-testable and safe to call before any network/IO work. A registry can be
 * created from a plain config object (e.g. loaded from env/JSON at boot) — no
 * Core involvement, no code changes to onboard a new customer (Req 11.1).
 */

import { loadProactiveContext } from './proactive-context.js';
import type { InboundEvent, ProactiveContext } from './proactive-types.js';

/**
 * A tenant's business payload interpreter (Req 11.3). Same signature/contract as
 * the default {@link loadProactiveContext} so a tenant can either replace the
 * whole interpretation or wrap the default. Kept async so a real interpreter may
 * do lookups (cart, order, CRM) — though the scaffold default is pure.
 */
export type PayloadInterpreter = (event: InboundEvent) => Promise<ProactiveContext>;

/**
 * A tenant's proactive configuration.
 *
 * `responsiveTypes` is the allow-list of Event `type`s worth responding to
 * (Req 11.2). `undefined` means "no per-tenant restriction" — every type is
 * treated as responsive (the framework default; matches rate-control's
 * admit-all seam so behaviour is unchanged until a tenant opts in). An empty
 * array means the tenant has explicitly chosen to respond to NOTHING.
 *
 * `interpretPayload` is the tenant's payload interpreter (Req 11.3). When
 * omitted the shared default loader is used.
 */
export interface TenantConfig {
  /** Allow-list of responsive Event types, or undefined for "all types". */
  responsiveTypes?: readonly string[];
  /** Tenant payload interpreter; defaults to the shared context loader. */
  interpretPayload?: PayloadInterpreter;
}

/**
 * A fully-resolved tenant config: defaults filled in, so callers never branch
 * on optionality. `isResponsive` is derived once from `responsiveTypes`.
 */
export interface ResolvedTenantConfig {
  /** The tenant this config resolved for (or the default sentinel). */
  tenantId: string;
  /**
   * The set of responsive Event types, or null when the tenant responds to all
   * types (no per-tenant restriction). Null is distinct from an empty set
   * (respond to nothing).
   */
  responsiveTypes: ReadonlySet<string> | null;
  /** True when an Event of `type` is worth responding to for this tenant. */
  isResponsive: (type: string | undefined) => boolean;
  /** The tenant's resolved payload interpreter (never undefined). */
  interpretPayload: PayloadInterpreter;
}

/** The tenant key used when a caller does not scope to a specific tenant. */
export const DEFAULT_TENANT_ID = '__default__';

/**
 * The framework default config used when a tenant has no entry and no explicit
 * default is supplied: respond to ALL Event types (matches rate-control's
 * admit-all seam, Req 11.1) and interpret payload with the shared loader.
 */
export const FRAMEWORK_DEFAULT_TENANT_CONFIG: TenantConfig = {
  responsiveTypes: undefined,
  interpretPayload: loadProactiveContext,
};

/** A plain, serialisable map of tenantId → config (e.g. from env/JSON at boot). */
export interface TenantConfigMap {
  /** Fallback config for tenants without an explicit entry. */
  default?: TenantConfig;
  /** Per-tenant overrides, keyed by tenant id. */
  tenants?: Readonly<Record<string, TenantConfig>>;
}

/**
 * Resolve a single {@link TenantConfig} into a {@link ResolvedTenantConfig} for
 * `tenantId`, filling in framework defaults. Pure.
 */
export function resolveTenantConfig(
  tenantId: string,
  config: TenantConfig | undefined,
  fallback: TenantConfig = FRAMEWORK_DEFAULT_TENANT_CONFIG,
): ResolvedTenantConfig {
  const responsiveList = config?.responsiveTypes ?? fallback.responsiveTypes;
  const responsiveTypes =
    responsiveList === undefined ? null : new Set(normalizeTypes(responsiveList));
  const interpretPayload =
    config?.interpretPayload ?? fallback.interpretPayload ?? loadProactiveContext;

  return {
    tenantId,
    responsiveTypes,
    isResponsive: makeIsResponsive(responsiveTypes),
    interpretPayload,
  };
}

/**
 * A registry that resolves per-tenant config from a plain map. This is the
 * clean API Task 11 (responsive-type filtering) and the context loader consume:
 * `registry.resolve(tenantId)` yields a ready-to-use {@link ResolvedTenantConfig}.
 */
export interface TenantConfigRegistry {
  /** Resolve the config for a tenant (falls back to the default). */
  resolve: (tenantId?: string) => ResolvedTenantConfig;
  /** True when `type` is worth responding to for `tenantId` (Req 11.2). */
  isResponsive: (tenantId: string | undefined, type: string | undefined) => boolean;
  /** Interpret an Event's payload with the tenant's interpreter (Req 11.3). */
  interpretPayload: (tenantId: string | undefined, event: InboundEvent) => Promise<ProactiveContext>;
}

/**
 * Build a {@link TenantConfigRegistry} from a plain config map (Req 11.1). The
 * map is typically loaded once from env/JSON at boot; onboarding a new customer
 * is adding an entry, no code change. Pure aside from the closure it returns.
 */
export function createTenantConfigRegistry(
  map: TenantConfigMap = {},
): TenantConfigRegistry {
  const fallback = map.default ?? FRAMEWORK_DEFAULT_TENANT_CONFIG;
  const tenants = map.tenants ?? {};

  function resolve(tenantId?: string): ResolvedTenantConfig {
    const id = normalizeTenantId(tenantId);
    const config = id === DEFAULT_TENANT_ID ? undefined : tenants[id];
    return resolveTenantConfig(id, config, fallback);
  }

  return {
    resolve,
    isResponsive: (tenantId, type) => resolve(tenantId).isResponsive(type),
    interpretPayload: (tenantId, event) => resolve(tenantId).interpretPayload(event),
  };
}

/**
 * Adapt a resolved tenant config into the exact `typeFilter` seam shape the
 * rate controller expects (`(type: string | undefined) => boolean`), WITHOUT
 * importing or modifying `rate-control.ts` (Req 11.2). Task 11 wires this into
 * `admitTurns({ typeFilter })`.
 */
export function buildTenantTypeFilter(
  resolved: ResolvedTenantConfig,
): (type: string | undefined) => boolean {
  return resolved.isResponsive;
}

// --- internals ---------------------------------------------------------------

/** Build the responsive predicate: all types when null, else set membership. */
function makeIsResponsive(
  responsiveTypes: ReadonlySet<string> | null,
): (type: string | undefined) => boolean {
  if (responsiveTypes === null) {
    // No per-tenant restriction: every type is worth responding to.
    return () => true;
  }
  return (type) => type !== undefined && responsiveTypes.has(normalizeType(type));
}

function normalizeTypes(types: readonly string[]): string[] {
  const out: string[] = [];
  for (const t of types) {
    if (typeof t === 'string' && t.trim().length > 0) out.push(normalizeType(t));
  }
  return out;
}

/** Event types are matched case-insensitively and trimmed for config safety. */
function normalizeType(type: string): string {
  return type.trim().toLowerCase();
}

function normalizeTenantId(tenantId: string | undefined): string {
  return typeof tenantId === 'string' && tenantId.trim().length > 0
    ? tenantId.trim()
    : DEFAULT_TENANT_ID;
}
