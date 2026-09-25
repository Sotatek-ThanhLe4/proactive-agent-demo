/**
 * Task 14 — `enrich-context` tool handler.
 *
 * The agent may call this tool during a workspace-chat turn to fetch/enrich
 * business data related to the proactive Event (Req 11.3). The App interprets
 * the reference per its own business via the pluggable `EnrichmentRegistry`;
 * Core forwards the returned `data` untouched.
 *
 * Follows the `tool.example.ts` shape: it receives the parsed tool `input` and
 * the VERIFIED invocation `claims`, and returns a plain JSON result matching
 * `src/schemas/tool-enrich-context-output.schema.json`.
 */

import type { InvocationClaims } from './sota-auth.js';
import {
  EnrichmentRegistry,
  InvalidEnrichmentRequestError,
  defaultEnrichmentRegistry,
} from './context-enricher.js';

/** Result envelope returned to Core/the agent. `ok:false` on bad input. */
export interface EnrichContextResponse {
  ok: boolean;
  result?: unknown;
  error?: { reason: string; message: string };
  context: {
    organizationId: string;
    workspaceId: string;
    userId?: string;
  };
}

export async function handleEnrichContextTool(
  input: unknown,
  claims: InvocationClaims,
  registry: EnrichmentRegistry = defaultEnrichmentRegistry,
): Promise<EnrichContextResponse> {
  const context = {
    organizationId: claims.oid,
    workspaceId: claims.wid,
    ...(typeof claims.sub === 'string' ? { userId: claims.sub } : {}),
  };
  try {
    const result = await registry.enrich(input);
    return { ok: true, result, context };
  } catch (error) {
    if (error instanceof InvalidEnrichmentRequestError) {
      return { ok: false, error: { reason: error.reason, message: error.message }, context };
    }
    throw error;
  }
}
