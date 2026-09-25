/**
 * Rate control — merge bursty Events + cap proactive turns per member (Task 10).
 *
 * Requirement 10.1: when many Events for one member arrive close together, merge
 * them so AT MOST ONE agent turn runs within the configured merge window.
 * Requirement 10.2: apply a cap on the number of proactive agent turns per
 * member within a configured time window.
 * Requirement 6.3: rate control applies to BOTH the online path (Task 4 poll
 * turns) AND the pending/reopen drain path (Task 7 turns), so a single reopen
 * never spawns too many turns.
 *
 * This module is a pure, deterministic decision engine. It holds NO wall-clock
 * of its own — the caller passes `now` (an injectable clock) on every call — and
 * mutates only the `RateState` it is handed back and forth. The same sequence of
 * calls always produces the same decisions (testable, isomorphic: runs the same
 * in the browser surface and in Node tests).
 *
 * The seam both turn planners feed through is {@link admitTurns}: it takes the
 * ordered list of candidate turns a planner produced (online `ProactiveTurnPlan`
 * or pending `DrainedTurn`), and returns which candidates are ADMITTED to run
 * and which are SUPPRESSED (merged into the window's single turn, or over the
 * cap). The caller runs only the admitted turns; suppressed Events are still
 * acknowledged by the caller (they were seen and merged — not lost, not a bug),
 * matching the existing ack seams.
 *
 * Type filtering (Req 10.3 / 10.4 — only run turns for "worth responding to"
 * Event types) is Task 11 and is deliberately NOT done here; a `typeFilter` seam
 * is left as an explicit no-op default so Task 11 can plug in without reshaping
 * this module.
 */

/** Tunables for pacing. All durations are milliseconds; counts are integers. */
export interface RateControlConfig {
  /**
   * Merge window (Req 10.1). Events landing within this many ms of the member's
   * last admitted turn are coalesced into that turn instead of starting a new
   * one. A burst therefore yields at most one turn per window.
   */
  mergeWindowMs: number;
  /**
   * Cap window (Req 10.2): the sliding window over which {@link maxTurnsPerWindow}
   * is counted.
   */
  capWindowMs: number;
  /**
   * Max proactive turns admitted for one member within any `capWindowMs`
   * sliding window (Req 10.2). Once reached, further candidates are suppressed
   * until older turns age out of the window.
   */
  maxTurnsPerWindow: number;
}

/**
 * Default pacing (OQ4). Conservative but usable for the first cut: coalesce a
 * 10s burst into one turn, and no more than 5 proactive turns per member per
 * minute. Tenants can override per Req 11 later.
 */
export const DEFAULT_RATE_CONTROL_CONFIG: RateControlConfig = {
  mergeWindowMs: 10_000,
  capWindowMs: 60_000,
  maxTurnsPerWindow: 5,
};

/**
 * Per-member pacing state (design.md `RateState`): the debounce anchor (when
 * the member's last turn was admitted) plus the timestamps of turns admitted
 * inside the current cap window. Immutable-friendly: {@link admitTurns} returns
 * a fresh state, never mutating the input.
 */
export interface RateState {
  /** Epoch ms of the member's most recently admitted turn, or null if none. */
  lastAdmittedAt: number | null;
  /**
   * Epoch ms of turns admitted within the cap window, oldest first. Entries
   * older than `capWindowMs` are pruned on each call so this stays bounded.
   */
  admittedAtWindow: number[];
}

/** A fresh, empty pacing state for a member with no history. */
export function emptyRateState(): RateState {
  return { lastAdmittedAt: null, admittedAtWindow: [] };
}

/** The minimal shape a candidate turn must have to be paced: a stable id. */
export interface RateCandidate {
  /** Stable Event id — used to report which candidates were admitted/merged. */
  eventId: string;
}

/** Why a candidate turn was suppressed rather than admitted. */
export type SuppressReason = 'merged' | 'capped';

/** One suppressed candidate plus the reason it did not run. */
export interface SuppressedTurn {
  eventId: string;
  reason: SuppressReason;
}

/** The outcome of pacing a batch of candidate turns for one member. */
export interface AdmitResult<T extends RateCandidate> {
  /** Candidates cleared to run, in input order (at most one per merge window). */
  admitted: T[];
  /** Candidates held back: merged into the window's turn, or over the cap. */
  suppressed: SuppressedTurn[];
  /** The updated pacing state to persist for the member. */
  state: RateState;
}

/**
 * Optional Event-type filter seam (Req 10.3 / 10.4 — Task 11). Returns true when
 * an Event of `type` is "worth responding to". The default admits every type so
 * Task 10 does not change filtering behaviour; Task 11 supplies a real filter.
 */
export type TypeFilter = (type: string | undefined) => boolean;

/** Admit-all default so this module never filters by type on its own (Task 11). */
export const ADMIT_ALL_TYPES: TypeFilter = () => true;

/** Options for a single {@link admitTurns} call. */
export interface AdmitOptions {
  /** Current time (injectable clock) — pacing is measured against this. */
  now: number;
  /** Pacing tunables. Defaults to {@link DEFAULT_RATE_CONTROL_CONFIG}. */
  config?: RateControlConfig;
  /** Type filter seam (Task 11). Defaults to admit-all. */
  typeFilter?: TypeFilter;
  /** Reads an Event type from a candidate, for the type filter. Optional. */
  getType?: (candidate: RateCandidate) => string | undefined;
}

/**
 * Prune turn timestamps that have aged out of the cap window (Req 10.2). Pure.
 */
function pruneWindow(admittedAtWindow: ReadonlyArray<number>, now: number, capWindowMs: number): number[] {
  const cutoff = now - capWindowMs;
  return admittedAtWindow.filter((t) => t > cutoff);
}

/**
 * The core seam: pace an ordered batch of candidate turns for ONE member
 * (Req 6.3, 10.1, 10.2, Property 7).
 *
 * Semantics, evaluated in input order against the injected `now`:
 *   1. TYPE (Task 11 seam): a candidate whose type is not "worth responding to"
 *      is suppressed as `merged` (recorded/acked, no turn). Default admits all.
 *   2. MERGE (Req 10.1): the FIRST admissible candidate opens/continues the
 *      merge window. If `now` is still within `mergeWindowMs` of the member's
 *      last admitted turn, even the first candidate is a merge (the burst folds
 *      into the already-running turn). Every candidate after the one admitted in
 *      this call is suppressed as `merged` — a burst yields at most one turn.
 *   3. CAP (Req 10.2): a candidate that would exceed `maxTurnsPerWindow` within
 *      the sliding `capWindowMs` is suppressed as `capped`.
 *
 * At most ONE candidate is admitted per call, mirroring "at most one turn per
 * merge window" for a single burst delivered together. Returns a fresh state;
 * the input is never mutated.
 */
export function admitTurns<T extends RateCandidate>(
  candidates: ReadonlyArray<T>,
  options: AdmitOptions,
  state: RateState = emptyRateState(),
): AdmitResult<T> {
  const config = options.config ?? DEFAULT_RATE_CONTROL_CONFIG;
  const typeFilter = options.typeFilter ?? ADMIT_ALL_TYPES;
  const getType = options.getType;
  const now = options.now;

  const admitted: T[] = [];
  const suppressed: SuppressedTurn[] = [];

  // Start from a pruned copy so cap counting only sees turns inside the window.
  let admittedAtWindow = pruneWindow(state.admittedAtWindow, now, config.capWindowMs);
  let lastAdmittedAt = state.lastAdmittedAt;

  // Whether this call may still admit a turn. Once we admit one (or fold into an
  // already-open window), everything else in the batch is merged (Req 10.1).
  const withinPriorWindow =
    lastAdmittedAt !== null && now - lastAdmittedAt < config.mergeWindowMs;
  let mergeWindowClosed = withinPriorWindow;

  for (const candidate of candidates) {
    // (1) Type filter seam — Task 11. Default admits all types.
    const type = getType ? getType(candidate) : undefined;
    if (!typeFilter(type)) {
      suppressed.push({ eventId: candidate.eventId, reason: 'merged' });
      continue;
    }

    // (2) Merge: only the first admissible candidate can open a new turn, and
    // only if we are not already inside a still-open merge window.
    if (mergeWindowClosed) {
      suppressed.push({ eventId: candidate.eventId, reason: 'merged' });
      continue;
    }

    // (3) Cap: would admitting this turn exceed the per-member window cap?
    if (admittedAtWindow.length >= config.maxTurnsPerWindow) {
      suppressed.push({ eventId: candidate.eventId, reason: 'capped' });
      // The cap does not close the merge window — subsequent candidates in this
      // burst are still merged, not double-reported as capped then merged.
      mergeWindowClosed = true;
      continue;
    }

    // Admit exactly one turn for this burst.
    admitted.push(candidate);
    admittedAtWindow = [...admittedAtWindow, now];
    lastAdmittedAt = now;
    mergeWindowClosed = true;
  }

  return {
    admitted,
    suppressed,
    state: { lastAdmittedAt, admittedAtWindow },
  };
}
