import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildTenantTypeFilter,
  createTenantConfigRegistry,
  DEFAULT_TENANT_ID,
  FRAMEWORK_DEFAULT_TENANT_CONFIG,
  resolveTenantConfig,
  type PayloadInterpreter,
  type TenantConfigMap,
} from './tenant-config.js';
import { loadProactiveContext } from './proactive-context.js';
import type { InboundEvent, ProactiveContext } from './proactive-types.js';

function event(type: string, data?: unknown): InboundEvent {
  return { type, subjectKey: 'member-1', ...(data !== undefined ? { data } : {}) };
}

// --- defaults: respond to all types, shared loader (Req 11.1) ----------------

test('a tenant with no config responds to every Event type (framework default)', () => {
  const registry = createTenantConfigRegistry();
  assert.equal(registry.isResponsive('acme', 'order.shipped'), true);
  assert.equal(registry.isResponsive('acme', 'anything.else'), true);
  assert.equal(registry.isResponsive(undefined, 'x'), true);
});

test('the framework default uses the shared context loader as its interpreter', () => {
  const resolved = resolveTenantConfig(DEFAULT_TENANT_ID, undefined);
  assert.equal(resolved.interpretPayload, loadProactiveContext);
  assert.equal(resolved.responsiveTypes, null);
});

test('FRAMEWORK_DEFAULT_TENANT_CONFIG has no restriction and the shared loader', () => {
  assert.equal(FRAMEWORK_DEFAULT_TENANT_CONFIG.responsiveTypes, undefined);
  assert.equal(FRAMEWORK_DEFAULT_TENANT_CONFIG.interpretPayload, loadProactiveContext);
});

// --- per-tenant responsive types (Req 11.2) ----------------------------------

test('a tenant allow-list only marks listed types as responsive (Req 11.2)', () => {
  const map: TenantConfigMap = {
    tenants: {
      acme: { responsiveTypes: ['order.shipped', 'order.delayed'] },
    },
  };
  const registry = createTenantConfigRegistry(map);
  assert.equal(registry.isResponsive('acme', 'order.shipped'), true);
  assert.equal(registry.isResponsive('acme', 'order.delayed'), true);
  assert.equal(registry.isResponsive('acme', 'cart.viewed'), false);
  // A different tenant with no entry falls back to responding to all.
  assert.equal(registry.isResponsive('other', 'cart.viewed'), true);
});

test('responsive type matching is case-insensitive and trims whitespace', () => {
  const registry = createTenantConfigRegistry({
    tenants: { acme: { responsiveTypes: ['  Order.Shipped  '] } },
  });
  assert.equal(registry.isResponsive('acme', 'ORDER.SHIPPED'), true);
  assert.equal(registry.isResponsive('acme', 'order.shipped'), true);
});

test('an explicit empty allow-list means the tenant responds to nothing', () => {
  const registry = createTenantConfigRegistry({ tenants: { quiet: { responsiveTypes: [] } } });
  assert.equal(registry.isResponsive('quiet', 'order.shipped'), false);
  assert.equal(registry.isResponsive('quiet', undefined), false);
});

test('undefined type is never responsive under a restriction, always under default', () => {
  const registry = createTenantConfigRegistry({
    default: { responsiveTypes: ['x'] },
    tenants: { open: { responsiveTypes: undefined } },
  });
  // default has a restriction → undefined type is not responsive
  assert.equal(registry.isResponsive('unknown-tenant', undefined), false);
  // tenant explicitly opts out of restriction (undefined) → inherits default's
  // restriction because undefined means "use fallback".
  assert.equal(registry.isResponsive('open', 'x'), true);
  assert.equal(registry.isResponsive('open', 'y'), false);
});

// --- custom default fallback -------------------------------------------------

test('a custom default applies to tenants without their own entry', () => {
  const registry = createTenantConfigRegistry({
    default: { responsiveTypes: ['global.only'] },
    tenants: { acme: { responsiveTypes: ['acme.event'] } },
  });
  assert.equal(registry.isResponsive('acme', 'acme.event'), true);
  assert.equal(registry.isResponsive('acme', 'global.only'), false);
  assert.equal(registry.isResponsive('nobody', 'global.only'), true);
  assert.equal(registry.isResponsive('nobody', 'acme.event'), false);
});

// --- payload interpreter seam (Req 11.3) -------------------------------------

test('a tenant can supply its own payload interpreter (Req 11.3)', async () => {
  const acmeInterpreter: PayloadInterpreter = async (e) => ({
    text: `ACME handled ${e.type}`,
    parts: [{ kind: 'acme', raw: e.data }],
  });
  const registry = createTenantConfigRegistry({
    tenants: { acme: { interpretPayload: acmeInterpreter } },
  });
  const ctx: ProactiveContext = await registry.interpretPayload('acme', event('order.shipped', { id: 9 }));
  assert.equal(ctx.text, 'ACME handled order.shipped');
  assert.deepEqual(ctx.parts, [{ kind: 'acme', raw: { id: 9 } }]);
});

test('a tenant without an interpreter falls back to the shared loader (Req 11.3)', async () => {
  const registry = createTenantConfigRegistry({ tenants: { acme: { responsiveTypes: ['x'] } } });
  const ev = event('order.shipped', { orderId: 42 });
  const viaRegistry = await registry.interpretPayload('acme', ev);
  const viaLoader = await loadProactiveContext(ev);
  assert.deepEqual(viaRegistry, viaLoader);
});

test('the resolved interpreter can wrap the shared default loader', async () => {
  const wrapping: PayloadInterpreter = async (e) => {
    const base = await loadProactiveContext(e);
    return { ...base, text: `[acme] ${base.text}` };
  };
  const registry = createTenantConfigRegistry({ tenants: { acme: { interpretPayload: wrapping } } });
  const ctx = await registry.interpretPayload('acme', event('order.shipped'));
  // The wrapper prefixes the shared loader's text; the loader mentions the
  // event type in its standing instruction + summary.
  assert.ok(ctx.text?.startsWith('[acme] '));
  assert.match(ctx.text ?? '', /order\.shipped/);
});

// --- rate-control typeFilter adapter (Req 11.2, consumable by Task 11) -------

test('buildTenantTypeFilter yields a (type) => boolean matching isResponsive', () => {
  const resolved = resolveTenantConfig('acme', { responsiveTypes: ['order.shipped'] });
  const filter = buildTenantTypeFilter(resolved);
  assert.equal(filter('order.shipped'), true);
  assert.equal(filter('cart.viewed'), false);
  assert.equal(filter(undefined), false);
});

test('the type filter for a default tenant admits all types (matches admit-all seam)', () => {
  const registry = createTenantConfigRegistry();
  const filter = buildTenantTypeFilter(registry.resolve('acme'));
  assert.equal(filter('anything'), true);
  assert.equal(filter(undefined), true);
});

// --- determinism / purity ----------------------------------------------------

test('resolving the same tenant twice yields equal responsive predicates', () => {
  const registry = createTenantConfigRegistry({ tenants: { acme: { responsiveTypes: ['x', 'y'] } } });
  const a = registry.resolve('acme');
  const b = registry.resolve('acme');
  for (const t of ['x', 'y', 'z', undefined] as (string | undefined)[]) {
    assert.equal(a.isResponsive(t), b.isResponsive(t));
  }
});

test('a blank tenant id resolves to the default sentinel', () => {
  const registry = createTenantConfigRegistry();
  assert.equal(registry.resolve('   ').tenantId, DEFAULT_TENANT_ID);
  assert.equal(registry.resolve(undefined).tenantId, DEFAULT_TENANT_ID);
});
