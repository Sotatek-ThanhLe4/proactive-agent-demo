import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  EnrichmentRegistry,
  InvalidEnrichmentRequestError,
  defaultEnrichmentResolver,
  readEnrichmentRequest,
  type EnrichmentResult,
} from './context-enricher.js';

// --- readEnrichmentRequest (Req 11.3) ---------------------------------------

test('readEnrichmentRequest reads type and reference', () => {
  const request = readEnrichmentRequest({ type: 'order', reference: 'o-1' });
  assert.equal(request.type, 'order');
  assert.equal(request.reference, 'o-1');
});

test('readEnrichmentRequest accepts id/ref aliases for reference', () => {
  assert.equal(readEnrichmentRequest({ type: 'order', id: 'o-2' }).reference, 'o-2');
  assert.equal(readEnrichmentRequest({ type: 'ticket', ref: 't-3' }).reference, 't-3');
});

test('readEnrichmentRequest trims surrounding whitespace', () => {
  const request = readEnrichmentRequest({ type: '  order  ', reference: '  o-4  ' });
  assert.equal(request.type, 'order');
  assert.equal(request.reference, 'o-4');
});

test('readEnrichmentRequest carries an object hints through untouched', () => {
  const hints = { locale: 'vi', fields: ['status'] };
  assert.deepEqual(readEnrichmentRequest({ type: 'order', reference: 'o', hints }).hints, hints);
});

test('readEnrichmentRequest ignores non-object hints', () => {
  assert.equal(readEnrichmentRequest({ type: 'order', reference: 'o', hints: 'nope' }).hints, undefined);
});

test('readEnrichmentRequest rejects a non-object body', () => {
  assert.throws(
    () => readEnrichmentRequest('nope'),
    (error: unknown) =>
      error instanceof InvalidEnrichmentRequestError && error.reason === 'MALFORMED_BODY',
  );
});

test('readEnrichmentRequest rejects a missing type', () => {
  assert.throws(
    () => readEnrichmentRequest({ reference: 'o-1' }),
    (error: unknown) =>
      error instanceof InvalidEnrichmentRequestError && error.reason === 'MISSING_TYPE',
  );
});

test('readEnrichmentRequest rejects a missing reference', () => {
  assert.throws(
    () => readEnrichmentRequest({ type: 'order' }),
    (error: unknown) =>
      error instanceof InvalidEnrichmentRequestError && error.reason === 'MISSING_REFERENCE',
  );
});

// --- defaultEnrichmentResolver ----------------------------------------------

test('defaultEnrichmentResolver returns a deterministic not-found echo', async () => {
  const result = await defaultEnrichmentResolver({ type: 'order', reference: 'o-9' });
  assert.equal(result.found, false);
  assert.equal(result.type, 'order');
  assert.equal(result.reference, 'o-9');
  assert.deepEqual(result.data, { type: 'order', reference: 'o-9' });
  // Deterministic across calls (no timestamps/randomness).
  const again = await defaultEnrichmentResolver({ type: 'order', reference: 'o-9' });
  assert.deepEqual(again, result);
});

test('defaultEnrichmentResolver includes hints in data when present', async () => {
  const result = await defaultEnrichmentResolver({ type: 'order', reference: 'o', hints: { locale: 'vi' } });
  assert.deepEqual(result.data, { type: 'order', reference: 'o', hints: { locale: 'vi' } });
});

// --- EnrichmentRegistry (tenant-overridable seam, Req 11.3) ------------------

test('registry uses a registered resolver for a known type', async () => {
  const registry = new EnrichmentRegistry();
  registry.register('order', (request): EnrichmentResult => ({
    found: true,
    type: request.type,
    reference: request.reference,
    summary: `Order ${request.reference} is shipped.`,
    data: { status: 'shipped' },
  }));
  const result = await registry.enrich({ type: 'order', reference: 'o-1' });
  assert.equal(result.found, true);
  assert.deepEqual(result.data, { status: 'shipped' });
});

test('registry falls back to the default resolver for an unknown type', async () => {
  const registry = new EnrichmentRegistry();
  const result = await registry.enrich({ type: 'unmapped', reference: 'x-1' });
  assert.equal(result.found, false);
  assert.equal(result.type, 'unmapped');
});

test('registry.register replaces an existing resolver', async () => {
  const registry = new EnrichmentRegistry();
  registry.register('order', () => ({ found: true, type: 'order', reference: 'a', summary: 'v1', data: {} }));
  registry.register('order', () => ({ found: true, type: 'order', reference: 'a', summary: 'v2', data: {} }));
  const result = await registry.enrich({ type: 'order', reference: 'a' });
  assert.equal(result.summary, 'v2');
});

test('registry.enrich propagates validation errors', async () => {
  const registry = new EnrichmentRegistry();
  await assert.rejects(
    () => registry.enrich({ reference: 'o-1' }),
    (error: unknown) =>
      error instanceof InvalidEnrichmentRequestError && error.reason === 'MISSING_TYPE',
  );
});

// --- property-style ----------------------------------------------------------

test('property: any input missing type or reference is rejected', () => {
  const invalid: unknown[] = [
    {},
    { type: 'order' },
    { reference: 'o-1' },
    { type: '', reference: 'o-1' },
    { type: 'order', reference: '   ' },
    { type: 42, reference: 'o-1' },
    'string',
    null,
    [],
  ];
  for (const raw of invalid) {
    assert.throws(
      () => readEnrichmentRequest(raw),
      (error: unknown) => error instanceof InvalidEnrichmentRequestError,
      `expected ${JSON.stringify(raw)} to be rejected`,
    );
  }
});

test('property: any valid type+reference resolves through the default fallback', async () => {
  const registry = new EnrichmentRegistry();
  const types = ['order', 'ticket', 'cart', 'crm.contact'];
  const refs = ['1', 'abc-123', 'ref:with:colons', 'x'.repeat(300)];
  for (const type of types) {
    for (const reference of refs) {
      const result = await registry.enrich({ type, reference });
      assert.equal(result.type, type);
      assert.equal(result.reference, reference);
      assert.equal(typeof result.summary, 'string');
    }
  }
});
