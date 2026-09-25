import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleEnrichContextTool } from './tool.enrich-context.js';
import { EnrichmentRegistry } from './context-enricher.js';
import type { InvocationClaims } from './sota-auth.js';

const claims = (): InvocationClaims => ({
  iid: 'inv-1',
  oid: 'org-1',
  wid: 'ws-1',
  sub: 'member-1',
  scp: ['tool:enrich-context'],
});

test('handler returns enriched result with verified tenant context', async () => {
  const registry = new EnrichmentRegistry();
  registry.register('order', (request) => ({
    found: true,
    type: request.type,
    reference: request.reference,
    summary: 'ok',
    data: { status: 'shipped' },
  }));
  const response = await handleEnrichContextTool({ type: 'order', reference: 'o-1' }, claims(), registry);
  assert.equal(response.ok, true);
  assert.deepEqual(response.result, {
    found: true,
    type: 'order',
    reference: 'o-1',
    summary: 'ok',
    data: { status: 'shipped' },
  });
  // Context comes from the VERIFIED claims, not the input body.
  assert.deepEqual(response.context, {
    organizationId: 'org-1',
    workspaceId: 'ws-1',
    userId: 'member-1',
  });
});

test('handler returns ok:false with a structured error on bad input', async () => {
  const response = await handleEnrichContextTool({ reference: 'o-1' }, claims(), new EnrichmentRegistry());
  assert.equal(response.ok, false);
  assert.equal(response.error?.reason, 'MISSING_TYPE');
  assert.equal(response.result, undefined);
  assert.deepEqual(response.context, {
    organizationId: 'org-1',
    workspaceId: 'ws-1',
    userId: 'member-1',
  });
});

test('handler falls back to the default resolver for an unmapped type', async () => {
  const response = await handleEnrichContextTool({ type: 'unmapped', reference: 'x-1' }, claims());
  assert.equal(response.ok, true);
  assert.equal((response.result as { found: boolean }).found, false);
});
