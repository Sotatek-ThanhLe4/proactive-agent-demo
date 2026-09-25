import type { Express, Request } from 'express';
import { InvalidEventError, routeInboundEvent, type RoutedEvent } from './event-subject.js';
import {
  verifyWebhookSignature,
  WEBHOOK_SIGNATURE_HEADER,
  WebhookVerificationError,
} from './webhook-verify.js';

/**
 * Requirement 2 — App_Backend endpoint that receives Events gắn Subject.
 *
 * Flow for one inbound Event:
 *   1. verify the SOURCE via the webhook signature (Req 2.1 auth, OQ3);
 *   2. read the Subject (member identity) and event type (Req 2.2);
 *   3. reject with 422 if there is no valid Subject (Req 2.3);
 *   4. hand the routed Event to `onEvent` for downstream routing — this module
 *      does NOT interpret business semantics beyond Subject + type (Req 2.4).
 *
 * Downstream routing (online → Surface, offline → Event_Queue) is the job of
 * later tasks; `onEvent` is the injectable seam. It defaults to a no-op ack so
 * this endpoint is usable and testable on its own.
 */
export interface EventIngressOptions {
  /** Shared secret used to verify the external source's webhook signature. */
  webhookSecret: string;
  /** Called once an Event is verified and its Subject read. */
  onEvent?: (event: RoutedEvent) => void | Promise<void>;
}

export function registerEventIngressRoutes(app: Express, options: EventIngressOptions) {
  const { webhookSecret, onEvent } = options;

  app.post('/events/proactive', async (request, response) => {
    const requestId = response.getHeader('x-request-id');

    // 1. Verify the source (Req 2.1 auth / OQ3) over the RAW received bytes.
    try {
      verifyWebhookSignature(
        rawBodyOf(request),
        request.header(WEBHOOK_SIGNATURE_HEADER),
        webhookSecret,
      );
    } catch (error) {
      if (error instanceof WebhookVerificationError) {
        console.error(
          JSON.stringify({ event: 'proactive_event_unverified', requestId, reason: error.message }),
        );
        response.status(401).json({ code: 'UNVERIFIED_SOURCE', message: error.message });
        return;
      }
      throw error;
    }

    // 2 + 3. Read the Subject and type; reject if the Event has no valid Subject.
    let routed: RoutedEvent;
    try {
      routed = routeInboundEvent(request.body);
    } catch (error) {
      if (error instanceof InvalidEventError) {
        // A verified source that sends a Subject-less Event is a rejected, NOT
        // a retryable, failure: 422 Unprocessable Entity, and we do not process.
        const status = error.reason === 'MALFORMED_BODY' ? 400 : 422;
        console.error(
          JSON.stringify({
            event: 'proactive_event_rejected',
            requestId,
            reason: error.reason,
            message: error.message,
          }),
        );
        response.status(status).json({ code: error.reason, message: error.message });
        return;
      }
      throw error;
    }

    // 4. Accept and route by Subject + type only (Req 2.4).
    try {
      await onEvent?.(routed);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: 'proactive_event_route_failed',
          requestId,
          type: routed.type,
          memberId: routed.subject.memberId,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      response.status(500).json({ code: 'APP_ERROR', message: 'Failed to route event' });
      return;
    }

    console.log(
      JSON.stringify({
        event: 'proactive_event_accepted',
        requestId,
        type: routed.type,
        // memberId is a tenant-scoped opaque id, safe to log.
        memberId: routed.subject.memberId,
      }),
    );
    response.status(202).json({
      accepted: true,
      type: routed.type,
      memberId: routed.subject.memberId,
    });
  });
}

/** The raw request bytes captured by the body parser (see server.ts verify). */
type RawBodyRequest = Request & { rawBody?: Buffer };

function rawBodyOf(request: Request): Buffer {
  const raw = (request as RawBodyRequest).rawBody;
  // Fall back to an empty buffer so verification fails closed rather than
  // throwing an unexpected TypeError when the body parser captured nothing.
  return raw ?? Buffer.alloc(0);
}
