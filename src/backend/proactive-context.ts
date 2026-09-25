import type { InboundEvent, ProactiveContext } from './proactive-types.js';

/**
 * Load business context for an inbound Event (Req 1.6, 12.4).
 *
 * This is the App-owned seam: each customer interprets its own Event `type` and
 * `data` here without Core needing to understand the business content. Core
 * treats the returned `context` as an opaque payload and simply feeds it to the
 * proactive turn.
 *
 * The scaffold implementation renders a neutral, human-readable summary of the
 * event and forwards the raw payload as a structured part. Real customers
 * replace the body (e.g. look up the cart, the order, the CRM record) — the
 * shape of the return value is the stable contract with Core.
 *
 * It is intentionally pure and dependency-free so it is trivially unit-testable
 * and safe to call before any network work.
 */
export async function loadProactiveContext(event: InboundEvent): Promise<ProactiveContext> {
  const summary = summarizeEvent(event);
  // Prepend a standing instruction so an event that carries ONLY data (no
  // embedded question) still tells the agent what to do: summarize and propose
  // the next action, consulting the knowledge base when useful. This is the
  // App-owned "what to do with an event" seam (tenant-configurable later).
  const instruction =
    `A "${event.type}" event just occurred with the data below. ` +
    `Summarize what happened in one or two sentences and propose the next action for the member. ` +
    `Consult the workspace knowledge base if it helps enrich or verify the details.`;
  const text = `${instruction}\n\n${summary}`;
  const parts: unknown[] = [
    {
      kind: 'event',
      type: event.type,
      subjectKey: event.subjectKey,
      // App-owned business payload. Core does not open this.
      data: event.data ?? null,
    },
  ];
  return { text, parts };
}

/**
 * Build a short, neutral description of the event for the agent to read as
 * context. Kept deterministic (no timestamps/randomness) so tests are stable.
 *
 * IMPORTANT: the summary must carry the actual payload VALUES, not just the
 * field names. Emitting only `Object.keys(data)` (e.g. "(customerName,
 * question)") strips the business content, so the agent receives field labels
 * with no values and cannot act — it ends up asking the member to paste the
 * payload. We serialize the full `data` so the values reach the turn text.
 */
function summarizeEvent(event: InboundEvent): string {
  const subject = event.subjectKey || 'unknown subject';
  if (event.data && typeof event.data === 'object') {
    let detail: string;
    try {
      detail = JSON.stringify(event.data);
    } catch {
      detail = String(event.data);
    }
    return `Event "${event.type}" for ${subject}. Payload: ${detail}`;
  }
  if (event.data !== undefined && event.data !== null) {
    return `Event "${event.type}" for ${subject}: ${String(event.data)}.`;
  }
  return `Event "${event.type}" for ${subject}.`;
}
