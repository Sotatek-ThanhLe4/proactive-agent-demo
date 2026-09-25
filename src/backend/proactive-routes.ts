import type { Express } from 'express';
import { CoreClientError } from './core-client.js';
import {
  handleProactiveEvent,
  parseInboundEvent,
  ProactiveEventValidationError,
} from './proactive-event.js';
import type { InvocationClaims } from './sota-auth.js';
import { requireSotaInvocation } from './sota-auth.js';

/**
 * Register the Event_Ingress route (Task 7, Req 1.6).
 *
 * The App receives an Event (external webhook or internal bus), loads business
 * context, and calls Core's `Proactive_Turn_API`. The route is authenticated
 * with the standard Sota invocation guard (scope `event:proactive`), which also
 * captures the delegated Core token used for the reverse call to Core.
 *
 * The event body is `{ input, context }` when delivered by the platform bus, or
 * a bare event object for an external webhook — both are accepted.
 */
export function registerProactiveRoutes(app: Express, appId: string) {
  app.post(
    '/events/proactive',
    requireSotaInvocation(appId, 'event:proactive'),
    async (request, response) => {
      const claims = response.locals.sota as InvocationClaims;
      const coreToken = response.locals.coreToken as string | undefined;
      const requestId = response.getHeader('x-request-id');
      try {
        const event = parseInboundEvent(extractEventBody(request.body));
        const result = await handleProactiveEvent(event, { claims, coreToken });
        console.log(
          JSON.stringify({
            event: 'proactive_event_forwarded',
            requestId,
            type: event.type,
            // subjectKey is a tenant-scoped opaque id, safe to log; the token is not.
            subjectKey: event.subjectKey,
            organizationId: claims.oid,
            workspaceId: claims.wid,
            accepted: result.accepted,
            conversationId: result.conversationId,
            hasRun: Boolean(result.runId),
          }),
        );
        response.status(202).json(result);
      } catch (error) {
        if (error instanceof ProactiveEventValidationError) {
          response.status(400).json({ code: 'VALIDATION_ERROR', message: error.message });
          return;
        }
        if (error instanceof CoreClientError) {
          // A 4xx from Core (e.g. bad envelope, tenant mismatch) is the caller's
          // fault; a 5xx / network failure is ours to retry. Surface Core's own
          // status when it named one, otherwise report an upstream failure.
          const status = error.status && error.status >= 400 && error.status < 500 ? 400 : 502;
          console.error(
            JSON.stringify({
              event: 'proactive_event_failed',
              requestId,
              status,
              message: error.message,
            }),
          );
          response.status(status).json({ code: 'CORE_ERROR', message: error.message });
          return;
        }
        console.error(
          JSON.stringify({
            event: 'proactive_event_error',
            requestId,
            message: error instanceof Error ? error.message : String(error),
          }),
        );
        response.status(500).json({ code: 'APP_ERROR', message: 'Failed to process event' });
      }
    },
  );
}

/**
 * Unwrap the platform bus envelope `{ input, context }` down to the event
 * payload, while still accepting a bare event object from an external webhook.
 */
function extractEventBody(body: unknown): unknown {
  if (isRecord(body) && isRecord(body.input)) return body.input;
  if (isRecord(body) && isRecord(body.body)) return body.body;
  return body;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
