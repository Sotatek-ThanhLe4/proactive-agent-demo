import type { Express } from 'express';
import { requireSotaInvocation } from './sota-auth.js';
import { handleExampleTool } from './tool.example.js';
import { handleEnrichContextTool } from './tool.enrich-context.js';

export function registerToolRoutes(app: Express, appId: string) {
  app.post('/tools/example', requireSotaInvocation(appId, 'tool:example'), async (request, response) => {
    const body = isRecord(request.body?.body) ? request.body.body : request.body;
    response.json(await handleExampleTool(body?.input ?? body, response.locals.sota));
  });

  // Task 14 — optional context-enrichment tool (Req 11.3). Guarded by the same
  // Sota invocation auth as the example tool; the agent may call it at runtime
  // to enrich business data related to the proactive Event.
  app.post('/tools/enrich-context', requireSotaInvocation(appId, 'tool:enrich-context'), async (request, response) => {
    const body = isRecord(request.body?.body) ? request.body.body : request.body;
    response.json(await handleEnrichContextTool(body?.input ?? body, response.locals.sota));
  });
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
