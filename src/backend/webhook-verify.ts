import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Requirement 2.1 (endpoint auth) + Open Question OQ3 — verify the SOURCE of an
 * inbound Event.
 *
 * The Event endpoint is a webhook fed by an EXTERNAL source (the customer's
 * system), so authentication is a shared-secret webhook signature that belongs
 * to the App — NOT a Core invocation token. The source signs the exact raw
 * request body with HMAC-SHA256 using a secret shared with the App and sends
 * the hex digest in a header. The App recomputes the digest over the bytes it
 * received and compares in constant time.
 *
 * Verifying over the RAW body (before JSON parsing) is essential: re-serialising
 * a parsed object would change bytes (key order, spacing) and break the check.
 */

/** Header the external source uses to carry the HMAC-SHA256 hex signature. */
export const WEBHOOK_SIGNATURE_HEADER = 'x-proactive-signature';

export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookVerificationError';
  }
}

/**
 * Compute the expected `sha256=<hex>` signature for a raw body. Exposed so the
 * signing side (and tests) can produce a matching value.
 */
export function signWebhookBody(rawBody: string | Buffer, secret: string): string {
  const digest = createHmac('sha256', secret).update(rawBody).digest('hex');
  return `sha256=${digest}`;
}

/**
 * Verify a webhook signature against the raw body using the shared secret.
 *
 * Returns silently on success; throws WebhookVerificationError on any failure
 * (missing header, wrong length, mismatch) so the caller maps it to a 401.
 * The comparison is constant time to avoid leaking the secret via timing.
 */
export function verifyWebhookSignature(
  rawBody: string | Buffer,
  signatureHeader: string | undefined,
  secret: string,
): void {
  if (!secret) {
    throw new WebhookVerificationError('webhook secret is not configured');
  }
  const provided = signatureHeader?.trim();
  if (!provided) {
    throw new WebhookVerificationError('missing webhook signature');
  }
  const expected = signWebhookBody(rawBody, secret);
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  // timingSafeEqual requires equal lengths; a length mismatch is itself a
  // mismatch, so short-circuit without leaking where the difference is.
  if (
    providedBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(providedBuffer, expectedBuffer)
  ) {
    throw new WebhookVerificationError('webhook signature mismatch');
  }
}
