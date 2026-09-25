import './styles.css';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  useAppContext,
  useAppFetch,
  useLocale,
  type ToolResultSurfaceProps,
} from '@sota/platform';
import { useAuth, useChatSession, useWorkspace } from '@sota/core/hooks';
import {
  Avatar,
  AvatarFallback,
  ChatInput,
  EmptyState,
  MessagePartsRenderer,
} from '@sota/core/components';

/**
 * Resolve the member identity for the surface.
 *
 * The native-module host does not always hydrate the `useAuth` store for an
 * embedded app surface (its `user` can stay null even after auth finishes), so
 * the userId is fetched from the App backend's `/api/hello`, which derives
 * org/workspace/user from the VERIFIED invocation token claims. This is the
 * authoritative identity for the member and does not depend on the host store.
 */
interface BackendIdentity {
  organizationId?: string;
  workspaceId?: string;
  userId?: string;
}

function useBackendIdentity(): { identity: BackendIdentity | null; loading: boolean } {
  const appFetch = useAppFetch();
  const [identity, setIdentity] = useState<BackendIdentity | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    appFetch('/api/hello', { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then((body: { context?: BackendIdentity }) => {
        setIdentity(body?.context ?? null);
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        console.error('[proactive-agent] identity fetch failed', String(error));
        setIdentity(null);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [appFetch]);

  return { identity, loading };
}
import {
  deriveConversationId,
  InvalidMemberIdentityError,
  type MemberIdentity,
} from '../backend/conversation-mapping.js';
import {
  acknowledgePendingEvents,
  fetchPendingEvents,
  planPendingTurns,
} from './pending-drain.js';
import {
  acknowledgeEvents,
  acknowledgedIds,
  fetchPoll,
  planProactiveTurns,
} from './proactive-poll.js';
import {
  admitTurns,
  emptyRateState,
  type RateState,
  type TypeFilter,
} from '../backend/rate-control.js';
import { createResponsiveTypeFilter } from '../backend/responsive-events.js';

/** How often the open Surface polls the App_Backend for new Events (Req 9.2). */
const POLL_INTERVAL_MS = 5_000;

/**
 * Filter deciding which Event types are "worth responding to" (Task 11, Req
 * 10.3, 10.4). Wired into the rate controller's `typeFilter`/`getType` seam at
 * BOTH turn-driving points below, so an Event of a non-responsive type is still
 * acked (recorded) but NEVER drives an agent turn (Req 10.4).
 *
 * This uses the App's default allow-list so the surface is self-contained. When
 * Task 13's per-tenant config lands, swap this for a filter built from the
 * member's tenant `responsiveEventTypes` (Req 11.2) via
 * `responsiveTypeFilterForConfig`.
 */
const RESPONSIVE_TYPE_FILTER: TypeFilter = createResponsiveTypeFilter();

/**
 * App_Surface — Proactive Agent screen (Task 1, Req 8.1, 8.2, 3.x).
 *
 * This is the native module the App contributes as a button / entry point in
 * workspace chat (manifest `surface: page`, slot `admin.workspace.tab`). Opening
 * it shows the member's ONE Conversation with the agent.
 *
 * The Conversation is not created here; its id is DERIVED deterministically from
 * the member's identity (org + workspace + userId), so every open of the App for
 * the same member resolves to the same conversation (Req 3.1–3.3, Property 6).
 * `ConversationView` then streams turns from Core's `POST /workspace-chat` using
 * the member's own session (Task 2, Req 1.2, 7.1, 7.2, 8.3, 8.4; Property 2).
 */
export function ProactiveAgentScreen() {
  const { organizationId: contextOrganizationId, workspaceId: contextWorkspaceId } =
    useAppContext();
  const { user } = useAuth();
  const { workspace } = useWorkspace();
  const { t } = useLocale();

  // Authoritative identity comes from the App backend (verified token claims).
  // Host context / stores are only fallbacks when the fetch is not yet in.
  const { identity, loading: identityLoading } = useBackendIdentity();

  const organizationId = identity?.organizationId ?? contextOrganizationId;
  const workspaceId = identity?.workspaceId ?? workspace?.id ?? contextWorkspaceId;
  const userId = identity?.userId ?? user?.id;

  const resolution = useMemo(
    () => resolveMemberConversation({ organizationId, workspaceId, userId }),
    [organizationId, workspaceId, userId],
  );

  return (
    <main
      className="starter-root proactive-screen"
      data-sota-app="sotaagents-app-proactive-agent"
    >
      {identityLoading ? (
        <div className="proactive-screen-status">
          <p className="starter-status" role="status">
            {t('surface.loading')}
          </p>
        </div>
      ) : resolution.ok ? (
        <ConversationView conversationId={resolution.conversationId} />
      ) : (
        <div className="proactive-screen-status">
          <p className="proactive-error" role="alert">
            {t('surface.identity_error')}
          </p>
        </div>
      )}
    </main>
  );
}

/**
 * The member's single Conversation, wired to Core's chat engine (Task 2, Req
 * 1.2, 8.3, 8.4; Property 2).
 *
 * The App does NOT run its own LLM loop. We drive a turn through the host
 * `useChatSession` hook, which POSTs to Core's existing `/workspace-chat` from
 * the member's browser using the member's Better Auth session (same-origin
 * workspace cookie) and streams the reply back over SSE. Because the call
 * carries the member's own session — never a service account — Core attaches
 * the turn to this member's conversation and charges credit to this member
 * (Req 7.1, 7.2). We only render the streamed messages here (Req 8.3, 8.4);
 * later tasks trigger the turn from an Event without the member typing.
 */
function ConversationView({ conversationId }: { conversationId: string }) {
  const { t } = useLocale();
  // Route all backend calls through the platform fetch so they reach the App
  // backend via the Sota tunnel (a plain same-origin `fetch('/events/...')`
  // hits the workspace SPA and returns HTML, not the App's JSON).
  const appFetch = useAppFetch();
  // Reuse the member's ONE conversation (Req 3.2): keyed by the deterministic
  // id, this is an existing chat, not a brand-new one.
  const { messages, status, error, sendMessage, stop } = useChatSession({
    conversationId,
    isNewChat: false,
    resumeEnabled: true,
  });

  // Load the member's stored history into a SEPARATE state (Problem 1). The host
  // `useChatSession` does not backfill saved messages, and feeding them back via
  // `setMessages` gets clobbered (the host re-derives `messages` from the
  // conversation and resets our seed to empty). So we keep history as its own
  // data and MERGE it with the session `messages` at render time instead of
  // pushing it into the host hook.
  const { history } = useConversationHistory(conversationId);

  // Shared per-member pacing state (Task 10, Req 6.3, 10.1, 10.2). BOTH the
  // pending drain and the online poll route their planned turns through the
  // rate controller against this single state, so bursts merge to at most one
  // turn per window and the per-member cap counts turns from either path
  // (Property 7). It lives in a ref (not React state) so the poll interval and
  // the drain mutate it without triggering re-renders.
  const rateStateRef = useRef<RateState>(emptyRateState());

  // Text of every turn the App sent on the member's behalf FROM AN EVENT (the
  // proactive drain/poll). Used to HIDE those user bubbles — the member did not
  // type them, they are only the context fed to the agent; the member sees just
  // the agent's reply. Turns the member types in the composer are never added
  // here, so they still render as normal user messages.
  const proactiveTurnTextsRef = useRef<Set<string>>(new Set());

  // On open, drain the member's pending Events and drive a proactive turn for
  // each (Task 7, Req 6.1, 6.2). `sendMessage` posts to Core's `/workspace-chat`
  // on the member's own session — the SAME chat path Task 2 uses — so the turn
  // is charged to this member (Property 2). After each turn is driven, the Event
  // is marked processed so re-opening does not replay it (Task 8, Req 6.4,
  // Property 5). Turns pass through the rate controller first (Task 10, Req 6.3).
  usePendingEventDrain(sendMessage, rateStateRef, appFetch, proactiveTurnTextsRef);

  // While the Surface is open, poll for new online Events and drive a proactive
  // turn for each WITHOUT the member typing (Task 4, Req 4.1–4.4, 9.1, 9.2).
  // Turns pass through the rate controller first (Task 10, Req 10.1, 10.2).
  useOnlineEventPoll(sendMessage, rateStateRef, proactiveTurnTextsRef);

  const isStreaming = status === 'submitted' || status === 'streaming';

  // Merge stored history with the live session turns so the transcript shows
  // past turns AND anything that happens this session (typed or proactive),
  // deduped by message id. History is the base; a session message with a new id
  // is appended, and a session message whose id already exists in history
  // overrides it (the live/streaming copy wins). See `mergeHistoryAndMessages`.
  const mergedMessages = useMemo(
    () => mergeHistoryAndMessages(history, messages),
    [history, messages],
  );

  // Render straight from the merged list so assistant turns show rich markdown
  // (via Core's MessagePartsRenderer) exactly like workspace chat, while still
  // surfacing every message role in coherent order.
  const renderable = useMemo<RenderableMessage[]>(
    () => toRenderableMessages(mergedMessages, proactiveTurnTextsRef.current),
    [mergedMessages],
  );
  const hasMessages = renderable.length > 0;

  // Auto-scroll the transcript to the newest turn whenever the MERGED list grows
  // or a reply streams in — the same "follow the conversation" behaviour as the
  // workspace chat screen.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [renderable.length, status]);

  // The proactive drain/poll drive turns through the SAME sendMessage; a manual
  // send from the composer is just another turn on the member's session.
  const handleSend = (message: string) => {
    const text = message.trim();
    if (!text || !sendMessage) return;
    void sendMessage({ text });
  };

  const handleStop = () => {
    void stop?.();
  };

  return (
    <section
      className="proactive-conversation"
      aria-label={t('surface.conversation_label')}
      data-conversation-id={conversationId}
    >
      <div className="proactive-transcript-scroll" ref={scrollRef}>
        {hasMessages ? (
          <ol className="proactive-transcript" aria-live="polite">
            {renderable.map((entry) => (
              <li
                key={entry.id}
                className="proactive-message"
                data-role={entry.role}
              >
                {entry.role === 'assistant' && (
                  <Avatar className="proactive-avatar">
                    <AvatarFallback>{t('surface.avatar_agent')}</AvatarFallback>
                  </Avatar>
                )}
                <div className="proactive-bubble">
                  <MessagePartsRenderer
                    parts={entry.parts}
                    status={status}
                    messageRole={entry.role}
                    isLast={entry.isLast}
                  />
                </div>
                {entry.role === 'user' && (
                  <Avatar className="proactive-avatar">
                    <AvatarFallback>{t('surface.avatar_member')}</AvatarFallback>
                  </Avatar>
                )}
              </li>
            ))}
          </ol>
        ) : (
          !isStreaming && (
            <div className="proactive-empty-state">
              <EmptyState
                title={t('surface.empty_title')}
                description={t('surface.conversation_empty')}
              />
            </div>
          )
        )}

        {isStreaming && (
          <p className="proactive-streaming" role="status">
            <span className="proactive-streaming-dots" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            {t('surface.conversation_streaming')}
          </p>
        )}

        {error && (
          <p className="proactive-error" role="alert">
            {t('surface.conversation_error')}
          </p>
        )}

        <div ref={bottomRef} />
      </div>

      <div className="proactive-composer">
        <ChatInput
          conversationId={conversationId}
          placeholder={t('surface.composer_placeholder')}
          isLoading={isStreaming}
          onSend={handleSend}
          onStop={handleStop}
          showModelSelector
          allowAttachments={false}
        />
      </div>
    </section>
  );
}

/** The minimal message shape both history rows and session turns share. */
interface MergeableMessage {
  id?: string;
  role?: string;
  parts?: unknown;
}

/**
 * Merge stored history with the live session `messages`, deduped by id
 * (Problem 1). History is the base transcript; the session turns are layered on
 * top so anything that happens this open (a typed turn or a proactive event
 * turn) shows without being pushed back into the host hook.
 *
 * Rules:
 *   - Order: history first (top-down as stored), then session messages whose id
 *     is NOT already in history (the new turns of this session), in their order.
 *   - Dedupe: a message id appearing in both history and the session is rendered
 *     ONCE, using the session copy (it is the fresh/streaming version). We keep
 *     that copy in the history slot so the reading order stays stable.
 *   - Session messages without an id are always kept (nothing to dedupe against)
 *     and appended after history.
 */
function mergeHistoryAndMessages(
  history: ReadonlyArray<MergeableMessage> | undefined,
  messages: ReadonlyArray<MergeableMessage> | undefined,
): MergeableMessage[] {
  const historyList = Array.isArray(history) ? history : [];
  const sessionList = Array.isArray(messages) ? messages : [];

  // Index the session turns by id so history entries can be overridden by their
  // live counterpart, and so we know which session turns are already shown.
  const sessionById = new Map<string, MergeableMessage>();
  for (const message of sessionList) {
    if (typeof message?.id === 'string' && message.id) {
      sessionById.set(message.id, message);
    }
  }

  const merged: MergeableMessage[] = [];
  const usedSessionIds = new Set<string>();
  for (const entry of historyList) {
    const id = typeof entry?.id === 'string' ? entry.id : '';
    const live = id ? sessionById.get(id) : undefined;
    if (live) {
      merged.push(live);
      usedSessionIds.add(id);
    } else {
      merged.push(entry);
    }
  }

  // Append session turns not already shown via history (new turns this session).
  for (const message of sessionList) {
    const id = typeof message?.id === 'string' ? message.id : '';
    if (id && usedSessionIds.has(id)) continue;
    merged.push(message);
  }

  return merged;
}

/** A host chat message reduced to what the bubble transcript renders. */
interface RenderableMessage {
  id: string;
  role: 'assistant' | 'user';
  parts: unknown[];
  isLast: boolean;
}

/**
 * Reduce the host `useChatSession` messages to the render model the bubble
 * transcript needs. We keep the raw `parts` so Core's MessagePartsRenderer can
 * paint rich markdown/tool output, normalise the role to the two the chat UI
 * shows, and drop messages that carry no parts yet so the transcript never
 * renders an empty bubble. Order is preserved (a conversation reads top down).
 */
function toRenderableMessages(
  messages: ReadonlyArray<{ id?: string; role?: string; parts?: unknown }> | undefined,
  hiddenProactiveTexts: ReadonlySet<string>,
): RenderableMessage[] {
  if (!Array.isArray(messages)) return [];
  const entries: RenderableMessage[] = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    const parts = Array.isArray(message?.parts) ? (message.parts as unknown[]) : [];
    if (parts.length === 0) continue;
    const role = message?.role === 'user' ? 'user' : 'assistant';
    // Hide user turns the App sent from an Event (not typed by the member): the
    // member should see only the agent's reply, not the raw event context.
    if (role === 'user' && hiddenProactiveTexts.has(plainTextOfParts(parts).trim())) {
      continue;
    }
    entries.push({
      id:
        typeof message?.id === 'string' && message.id
          ? message.id
          : `msg-${index}`,
      role,
      parts,
      isLast: false,
    });
  }
  if (entries.length > 0) entries[entries.length - 1].isLast = true;
  return entries;
}

/** Concatenate the plain text of a message's `text` parts (for matching). */
function plainTextOfParts(parts: unknown[]): string {
  return parts
    .filter(
      (part): part is { type?: string; text?: string } =>
        typeof part === 'object' && part !== null,
    )
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('');
}

/** The turn-sender shape we consume from `useChatSession` (only `text`). */
type SendProactiveTurn = (message: { text: string }) => Promise<void>;

/**
 * Drain the member's pending Events once per open and drive one proactive turn
 * per Event (Task 7, Req 6.1, 6.2).
 *
 * Flow: fetch `/events/pending` on the member's session → load Context and build
 * turn text for each Event (reusing the online path's Context seam + Task 2 turn
 * builder) → send each turn through `useChatSession`, which POSTs to Core's
 * `/workspace-chat` on the member's own session (Property 2). Turns are sent in
 * queue order, sequentially, so the member's single conversation stays coherent.
 *
 * After each turn is driven, the Event is marked processed via
 * `/events/pending/ack` so re-opening the Surface does not replay it (Task 8,
 * Req 6.4, Property 5). The ack happens AFTER the turn, so a failed turn leaves
 * the Event pending for the next open.
 *
 * A failed drain is swallowed (logged) and left for a later open: an Event is
 * only marked processed once its turn has been driven, so nothing is lost
 * (fail-safe, Req 9.3). The guard ref ensures we drain at most once per mounted
 * surface, so re-renders never replay the pending Events.
 */
function usePendingEventDrain(
  sendMessage: SendProactiveTurn | undefined,
  rateStateRef: { current: RateState },
  appFetch: (path: string, init?: RequestInit) => Promise<Response>,
  proactiveTurnTextsRef: { current: Set<string> },
) {
  const drainedRef = useRef(false);

  useEffect(() => {
    if (!sendMessage || drainedRef.current) return;
    drainedRef.current = true;

    let cancelled = false;
    void (async () => {
      try {
        const pending = await fetchPendingEvents(appFetch);
        const turns = await planPendingTurns(pending);
        // Pace the drained turns (Task 10, Req 6.3, 10.1, 10.2): merge the burst
        // to at most one turn per window and honour the per-member cap, sharing
        // the member's rate state with the online poll. Suppressed Events are
        // still acked below — they were seen and merged, not lost (Req 6.3).
        const paced = admitTurns(
          turns.map((turn) => ({
            eventId: turn.event.id,
            type: turn.event.type,
            text: turn.text,
          })),
          {
            now: Date.now(),
            // Only "worth responding to" types drive a turn; others are acked
            // below but never run (Task 11, Req 10.3, 10.4).
            typeFilter: RESPONSIVE_TYPE_FILTER,
            getType: (c) => (c as { type?: string }).type,
          },
          rateStateRef.current,
        );
        rateStateRef.current = paced.state;
        for (const turn of paced.admitted) {
          if (cancelled) return;
          // Remember this turn's text so its user bubble is hidden from the
          // transcript — the member only sees the agent's reply, not the event
          // context the App fed in.
          proactiveTurnTextsRef.current.add(turn.text.trim());
          await sendMessage({ text: turn.text });
          // Mark this Event processed only AFTER its turn has been driven, so a
          // failure above leaves it pending for the next open (Req 9.3). Acking
          // per-turn (not in one batch at the end) means an interruption still
          // records the turns that did run, so they are never replayed.
          await acknowledgePendingEvents([turn.eventId], appFetch);
        }
        // Ack the merged/capped Events too so a reopen does not replay them:
        // they were consumed by the window's single turn (Req 6.3, Property 5).
        if (paced.suppressed.length > 0) {
          await acknowledgePendingEvents(paced.suppressed.map((s) => s.eventId), appFetch);
        }
      } catch (error) {
        // Non-fatal: leave the Events pending for the next open (Req 9.3).
        console.error(
          JSON.stringify({
            event: 'pending_drain_failed',
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [sendMessage, appFetch]);
}

/**
 * Poll the App_Backend on an interval while the Surface is open and drive a
 * proactive turn for each new online Event WITHOUT the member typing (Task 4,
 * Req 4.1–4.4, 9.1, 9.2).
 *
 * Each tick:
 *   1. `GET /events/poll` on the member's session — this is also the heartbeat
 *      that keeps the member Online so freshly arriving Events are delivered
 *      here rather than queued (Req 4.1);
 *   2. build one turn per Event from its loaded Context (Req 4.2) and send it
 *      through `useChatSession` → Core's `/workspace-chat` on the member's own
 *      session (Req 4.4, Property 2). The reply streams back and renders in the
 *      transcript (Req 4.3);
 *   3. acknowledge the delivered Event ids so they are not re-delivered (Req
 *      9.3). Turns are sent BEFORE the ack, so a failure leaves the Events
 *      buffered for the next tick (fail-safe).
 *
 * A single in-flight guard prevents overlapping ticks (a slow turn must not
 * stack). Errors are logged and swallowed: the next tick simply retries, and
 * because nothing is acked on failure, no Event is lost (Req 9.3).
 */
function useOnlineEventPoll(
  sendMessage: SendProactiveTurn | undefined,
  rateStateRef: { current: RateState },
  proactiveTurnTextsRef: { current: Set<string> },
) {
  const appFetch = useAppFetch();
  const inFlightRef = useRef(false);

  useEffect(() => {
    if (!sendMessage) return;
    let stopped = false;

    const tick = async () => {
      if (stopped || inFlightRef.current) return;
      inFlightRef.current = true;
      try {
        const events = await fetchPoll(appFetch);
        if (events.length === 0) return;
        const turns = planProactiveTurns(events);
        // Pace this tick's turns (Task 10, Req 10.1, 10.2): a burst of Events
        // delivered together merges to at most one turn, and the per-member cap
        // (shared with the pending drain) is honoured across ticks (Property 7).
        const paced = admitTurns(
          turns,
          {
            now: Date.now(),
            // Only "worth responding to" types drive a turn; others are acked
            // below but never run (Task 11, Req 10.3, 10.4).
            typeFilter: RESPONSIVE_TYPE_FILTER,
            getType: (c) => (c as { type?: string }).type,
          },
          rateStateRef.current,
        );
        rateStateRef.current = paced.state;
        for (const turn of paced.admitted) {
          if (stopped) return;
          // Hide this event turn's user bubble; show only the agent's reply.
          proactiveTurnTextsRef.current.add(turn.text.trim());
          await sendMessage({ text: turn.text });
        }
        // Ack every delivered Event — admitted, merged, or capped — so none is
        // re-delivered: suppressed Events were consumed by the window's turn or
        // rejected by the cap, not lost (Req 6.3, 9.3).
        await acknowledgeEvents(acknowledgedIds(events), appFetch);
      } catch (error) {
        // Non-fatal: leave the Events buffered for the next tick (Req 9.3).
        console.error(
          JSON.stringify({
            event: 'online_poll_failed',
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      } finally {
        inFlightRef.current = false;
      }
    };

    // Poll immediately on open, then on the configured interval (Req 9.2).
    void tick();
    const timer = setInterval(() => void tick(), POLL_INTERVAL_MS);

    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [appFetch, sendMessage]);
}

/** A stored message as returned by Core's history endpoint (MessageResDto). */
interface StoredMessage {
  messageId?: unknown;
  role?: unknown;
  parts?: unknown;
}

/** The minimal UIMessage shape the host chat hook needs to render a turn. */
interface HistoryUiMessage {
  id: string;
  role: string;
  parts: unknown[];
}

/**
 * Load the member's stored history for a conversation as its OWN data (Problem
 * 1). The host `useChatSession` does not backfill saved messages, and seeding
 * them back via `setMessages` is clobbered — the host re-derives `messages`
 * from the conversation and resets the seed to empty. So instead of pushing
 * history into the host hook, we return it and let the caller MERGE it with the
 * live session `messages` at render time.
 *
 * On mount (once per conversationId) we fetch
 * `GET /api/history/<conversationId>/messages` on the member's own session with
 * a plain same-origin `fetch` — Core's history endpoint is NOT an app-backend
 * route, so `useAppFetch` (which rewrites the path into the app's
 * `/api/app-data/<appId>/...` namespace) would 404. Each MessageResDto row is
 * mapped to `{ id, role, parts }`, keeping only rows whose `parts` is an array
 * and whose `messageId`/`role` are strings.
 *
 * Guards:
 *   - A per-conversation ref makes the fetch run at most once per mount, so
 *     re-renders never re-load history.
 *   - An AbortController cancels the in-flight fetch on unmount.
 *
 * Fail-safe: a failed/!ok fetch sets an empty history and marks it loaded (it
 * never throws), so history loading can never break the surface.
 */
function useConversationHistory(
  conversationId: string,
): { history: HistoryUiMessage[]; loaded: boolean } {
  const loadedForRef = useRef<string | null>(null);
  const [history, setHistory] = useState<HistoryUiMessage[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (loadedForRef.current === conversationId) return;
    loadedForRef.current = conversationId;

    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(
          '/api/history/' + encodeURIComponent(conversationId) + '/messages',
          {
            credentials: 'same-origin',
            headers: { accept: 'application/json' },
            signal: controller.signal,
          },
        );
        if (!response.ok) {
          if (!controller.signal.aborted) {
            setHistory([]);
            setLoaded(true);
          }
          return;
        }
        const body: unknown = await response.json();
        // Core wraps the list in `{ success, data: [...messages], timestamp }`,
        // so the array is at `body.data` (a bare array is also tolerated).
        const rows: unknown[] = Array.isArray(body)
          ? (body as unknown[])
          : body && typeof body === 'object' && Array.isArray((body as { data?: unknown }).data)
            ? ((body as { data: unknown[] }).data)
            : [];
        const mapped: HistoryUiMessage[] = [];
        for (const raw of rows as StoredMessage[]) {
          if (!Array.isArray(raw?.parts)) continue;
          const id = typeof raw.messageId === 'string' ? raw.messageId : '';
          const role = typeof raw.role === 'string' ? raw.role : '';
          if (!id || !role) continue;
          mapped.push({ id, role, parts: raw.parts as unknown[] });
        }
        if (!controller.signal.aborted) {
          setHistory(mapped);
          setLoaded(true);
        }
      } catch (error) {
        // Non-fatal: render with an empty history on any failure (Req 9.3).
        if (controller.signal.aborted) return;
        console.error(
          JSON.stringify({
            event: 'history_fetch_failed',
            message: error instanceof Error ? error.message : String(error),
          }),
        );
        setHistory([]);
        setLoaded(true);
      }
    })();

    return () => controller.abort();
  }, [conversationId]);

  return { history, loaded };
}

/**
 * Resolve the member's deterministic Conversation from the surface context.
 * Returns a discriminated result so the UI can render an identity error state
 * without throwing during render (a partial context is a transient state, not a
 * crash).
 */
type ConversationResolution =
  | { ok: true; conversationId: string }
  | { ok: false };

export function resolveMemberConversation(input: {
  organizationId: string | undefined;
  workspaceId: string | undefined;
  userId: string | undefined;
}): ConversationResolution {
  const { organizationId, workspaceId, userId } = input;
  if (!organizationId || !workspaceId || !userId) {
    return { ok: false };
  }
  try {
    const identity: MemberIdentity = { organizationId, workspaceId, userId };
    return { ok: true, conversationId: deriveConversationId(identity) };
  } catch (error) {
    if (error instanceof InvalidMemberIdentityError) return { ok: false };
    throw error;
  }
}

export function ExampleToolResult({
  toolResult,
}: ToolResultSurfaceProps<{ message?: string }, unknown>) {
  const beforeOutput =
    toolResult.state === 'input-streaming' ||
    toolResult.state === 'input-available';
  const value = beforeOutput
    ? toolResult.input
    : toolResult.result ?? toolResult.output ?? toolResult.errorText;
  return (
    <section className="starter-root starter-result" data-sota-app="sotaagents-app-proactive-agent">
      <strong>
        {toolResult.toolName}{' '}
        {toolResult.state === 'input-streaming'
          ? 'input is streaming'
          : toolResult.state === 'input-available'
            ? 'is running'
            : 'result'}
      </strong>
      <pre>{pretty(value)}</pre>
    </section>
  );
}

function pretty(value: unknown): ReactNode {
  if (value === undefined) return 'Waiting for the model…';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value, null, 2); }
  catch { return String(value); }
}

export const surfaces = { ProactiveAgentScreen, ExampleToolResult };
