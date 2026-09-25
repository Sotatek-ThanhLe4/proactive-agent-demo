import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  signWebhookBody,
  verifyWebhookSignature,
  WebhookVerificationError,
} from './webhook-verify.js';

const secret = 'shared-secret';
const body = JSON.stringify({ type: 'order.shipped', memberId: 'm-1' });

test('verifyWebhookSignature accepts a signature it produced', () => {
  const signature = signWebhookBody(body, secret);
  assert.doesNotThrow(() => verifyWebhookSignature(body, signature, secret));
});

test('verifyWebhookSignature accepts a Buffer body signed as the same bytes', () => {
  const buffer = Buffer.from(body);
  const signature = signWebhookBody(buffer, secret);
  assert.doesNotThrow(() => verifyWebhookSignature(buffer, signature, secret));
});

test('verifyWebhookSignature rejects a missing signature header', () => {
  assert.throws(
    () => verifyWebhookSignature(body, undefined, secret),
    (error: unknown) =>
      error instanceof WebhookVerificationError && /missing/.test(error.message),
  );
});

test('verifyWebhookSignature rejects a tampered body', () => {
  const signature = signWebhookBody(body, secret);
  const tampered = body.replace('m-1', 'm-2');
  assert.throws(
    () => verifyWebhookSignature(tampered, signature, secret),
    (error: unknown) =>
      error instanceof WebhookVerificationError && /mismatch/.test(error.message),
  );
});

test('verifyWebhookSignature rejects a signature made with a different secret', () => {
  const signature = signWebhookBody(body, 'other-secret');
  assert.throws(
    () => verifyWebhookSignature(body, signature, secret),
    (error: unknown) => error instanceof WebhookVerificationError,
  );
});

test('verifyWebhookSignature fails closed when no secret is configured', () => {
  const signature = signWebhookBody(body, secret);
  assert.throws(
    () => verifyWebhookSignature(body, signature, ''),
    (error: unknown) =>
      error instanceof WebhookVerificationError && /not configured/.test(error.message),
  );
});

test('verifyWebhookSignature rejects a wrong-length signature without leaking position', () => {
  assert.throws(
    () => verifyWebhookSignature(body, 'sha256=short', secret),
    (error: unknown) => error instanceof WebhookVerificationError,
  );
});
