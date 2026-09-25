import 'dotenv/config';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { requireSotaInvocation } from './sota-auth.js';
import { registerToolRoutes } from './tool-routes.js';
import { registerEventIngressRoutes } from './event-ingress-routes.js';
import { registerEventPollRoutes } from './event-poll-routes.js';
import { PresenceStateStore } from './presence-state.js';
import { EventQueueStore } from './event-queue.js';
import { OnlineDeliveryStore } from './online-delivery.js';
import { createOfflineEventRouter } from './offline-routing.js';
import { registerPendingEventsRoutes } from './pending-events-routes.js';

const appId = 'sotaagents-app-proactive-agent';
const app = express();
app.disable('x-powered-by');
// Capture the raw request bytes so the Event webhook can be verified against
// its HMAC signature (Req 2.1 auth / OQ3) before the parsed body is used.
app.use(
  express.json({
    limit: '1mb',
    verify: (request, _response, buffer) => {
      (request as express.Request & { rawBody?: Buffer }).rawBody = Buffer.from(buffer);
    },
  }),
);
app.use((request, response, next) => {
  const startedAt = performance.now();
  const requestId = request.header('x-request-id') ?? randomUUID();
  response.setHeader('x-request-id', requestId);
  response.on('finish', () => log('info', 'http_request', {
    requestId,
    method: request.method,
    path: request.originalUrl,
    status: response.statusCode,
    durationMs: Math.round(performance.now() - startedAt),
  }));
  next();
});

// The `sota dev` tunnel probes `HEAD /` as a liveness check. Answer 200 so the
// probe does not spam the log with 404s (the route has no body for HEAD).
app.head('/', (_request, response) => {
  response.status(200).end();
});

app.get('/health', (_request, response) => {
  response.json({ status: 'ok', appId });
});

app.get('/api/hello', requireSotaInvocation(appId, 'app:http'), (_request, response) => {
  const claims = response.locals.sota;
  response.json({
    message: 'Frontend and backend are connected.',
    appId,
    context: {
      organizationId: claims.oid,
      workspaceId: claims.wid,
      userId: claims.sub,
    },
  });
});

registerToolRoutes(app, appId);

// Presence + Event_Queue + online delivery (Tasks 4 & 6, Req 4, 5, 9).
//
// Presence is derived from connected App_Surfaces. Since the Surface POLLS
// (OQ1), presence is a heartbeat: each poll marks the member Online and
// presence expires if polls stop for longer than PRESENCE_TTL_MS (default 30s),
// so a closed Surface correctly becomes Offline and its Events are queued.
//
// Routing (offline-routing seam):
//   - Online  → buffer the Event for the Surface's next poll (Task 4, Req 4.1).
//   - Offline → store into the member's Event_Queue; no agent, no credit
//     (Task 6, Req 5.1/5.2, Property 3). Nothing is lost (Property 4).
const presenceTtlMs = Number(process.env.PRESENCE_TTL_MS ?? 30_000);
const presence = new PresenceStateStore({
  ttlMs: Number.isFinite(presenceTtlMs) && presenceTtlMs > 0 ? presenceTtlMs : 30_000,
});
const eventQueue = new EventQueueStore();
const onlineDelivery = new OnlineDeliveryStore();
const routeEvent = createOfflineEventRouter({
  presence,
  queue: eventQueue,
  // Online delivery seam (Task 4): buffer the Event so the member's polling
  // Surface picks it up and drives a `/workspace-chat` turn with the member's
  // own session — the backend never runs the agent (Req 1.2, Property 2).
  onOnline: (event) => {
    onlineDelivery.buffer(event);
  },
});

// Event_Ingress (Req 2): receive Events gắn Subject, verify source, read the
// Subject (member), reject if missing. Routing (Task 4/6) then either buffers
// the Event for an Online member or stores it in the Event_Queue when Offline.
registerEventIngressRoutes(app, {
  webhookSecret: process.env.PROACTIVE_WEBHOOK_SECRET ?? '',
  // The ingress seam only cares that routing happened; the RouteOutcome is for
  // tests. Await it so a routing failure surfaces as a 500 rather than lost.
  onEvent: async (event) => {
    await routeEvent(event);
  },
});

// Event poll (Task 4, OQ1 — POLL): the App_Surface polls these with the
// member's verified invocation token to learn there is a new Event (Req 9.1)
// and to acknowledge Events it has processed (Req 9.3). The member identity is
// taken from the verified token claims, never the body.
registerEventPollRoutes(app, {
  presence,
  delivery: onlineDelivery,
  authenticate: requireSotaInvocation(appId, 'app:http'),
});

// Pending-Events retrieval (Task 7, Req 6.1): when a member opens the
// App_Surface it calls `GET /events/pending` to fetch its pending queued
// Events. Scoped to the authenticated member (claim `sub`), so a member can
// only drain its OWN queue. The Surface then loads Context and drives a
// workspace-chat turn on the member's session (Req 6.2, Property 2). This route
// only reads the queue — it runs no agent and consumes no credit.
registerPendingEventsRoutes(app, appId, { queue: eventQueue });

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  log('error', 'request_failed', {
    message: error instanceof Error ? error.message : String(error),
  });
  response.status(500).json({ code: 'APP_ERROR', message: 'Request failed' });
});

const expectedPort = 8787;
const port = Number(process.env.PORT ?? expectedPort);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  log('error', 'server_failed', { appId, message: 'PORT must be an integer from 1 to 65535' });
  process.exitCode = 1;
} else if (port !== expectedPort) {
  log('error', 'server_failed', {
    appId,
    message: 'PORT must match the manifest local service port ' + expectedPort,
  });
  process.exitCode = 1;
} else {
  const server = app.listen(port, 'localhost');
  server.once('listening', () => {
    log('info', 'server_started', { appId, url: `http://localhost:${port}` });
  });
  server.once('error', (error: NodeJS.ErrnoException) => {
    log('error', 'server_failed', {
      appId,
      code: error.code,
      message: error.message,
      url: `http://localhost:${port}`,
    });
    process.exitCode = 1;
  });
}

function log(level: 'info' | 'error', event: string, details: Record<string, unknown>) {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...details }));
}
