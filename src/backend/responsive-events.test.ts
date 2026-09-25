import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  admitTurns,
  emptyRateState,
  type RateCandidate,
} from './rate-control.js';
import {
  createResponsiveTypeFilter,
  DEFAULT_RESPONSIVE_EVENT_TYPES,
  isResponsiveEventType,
  responsiveTypeFilterForConfig,
} from './responsive-events.js';

// --- isResponsiveEventType (Req 10.3, 10.4) ----------------------------------

test('a type on the allow-list is worth responding to (Req 10.3)', () => {
  assert.equal(isResponsiveEventType('order.shipped', ['order.shipped']), true);
});

test('a type NOT on the allow-list is only recorded, never a turn (Req 10.4)', () => {
  assert.equal(isResponsiveEventType('noise.tick', ['order.shipped']), false);
});

test('matching is case-insensitive and tolerant of surrounding whitespace', () => {
  assert.equal(isResponsiveEventType('  ORDER.Shipped  ', ['order.shipped']), true);
  assert.equal(isResponsiveEventType('order.shipped', ['  Order.Shipped ']), true);
});

test('a missing / blank type is never worth responding to (Req 10.4)', () => {
  assert.equal(isResponsiveEventType(undefined, ['order.shipped']), false);
  assert.equal(isResponsiveEventType('', ['order.shipped']), false);
  assert.equal(isResponsiveEventType('   ', ['order.shipped']), false);
});

test('an empty allow-list responds to nothing — every Event only recorded (Req 10.4)', () => {
  assert.equal(isResponsiveEventType('order.shipped', []), false);
  assert.equal(isResponsiveEventType('anything', undefined), false);
});

// --- createResponsiveTypeFilter ----------------------------------------------

test('the filter admits configured types and rejects the rest', () => {
  const filter = createResponsiveTypeFilter(['order.shipped', 'payment.failed']);
  assert.equal(filter('order.shipped'), true);
  assert.equal(filter('payment.failed'), true);
  assert.equal(filter('cart.viewed'), false);
  assert.equal(filter(undefined), false);
});

test('the default filter uses the App default allow-list', () => {
  const filter = createResponsiveTypeFilter();
  for (const type of DEFAULT_RESPONSIVE_EVENT_TYPES) {
    assert.equal(filter(type), true, `default should admit ${type}`);
  }
  assert.equal(filter('totally.unlisted'), false);
});

test('responsiveTypeFilterForConfig consumes a tenant config allow-list (Req 11.2)', () => {
  const filter = responsiveTypeFilterForConfig({ responsiveEventTypes: ['ticket.assigned'] });
  assert.equal(filter('ticket.assigned'), true);
  assert.equal(filter('order.shipped'), false);
});

test('responsiveTypeFilterForConfig falls back to the default when config is absent', () => {
  const filter = responsiveTypeFilterForConfig(undefined);
  assert.equal(filter(DEFAULT_RESPONSIVE_EVENT_TYPES[0]), true);
});

// --- integration with the rate controller seam (Req 10.3, 10.4) --------------

function cand(eventId: string, type?: string): RateCandidate & { type?: string } {
  return type === undefined ? { eventId } : { eventId, type };
}

test('non-responsive types are recorded (suppressed) but never open a turn (Req 10.4)', () => {
  const filter = createResponsiveTypeFilter(['order.shipped']);
  const burst = [
    cand('e1', 'noise'),
    cand('e2', 'order.shipped'),
    cand('e3', 'noise'),
  ];
  const result = admitTurns(
    burst,
    {
      now: 1_000,
      typeFilter: filter,
      getType: (c) => (c as { type?: string }).type,
    },
    emptyRateState(),
  );
  // Only the responsive Event opens a turn; both noise Events are suppressed
  // (the caller acks them — recorded without a turn, Req 10.4).
  assert.deepEqual(result.admitted.map((c) => c.eventId), ['e2']);
  const suppressedIds = result.suppressed.map((s) => s.eventId).sort();
  assert.deepEqual(suppressedIds, ['e1', 'e3']);
});

test('a batch of only non-responsive types opens no turn at all (Req 10.4)', () => {
  const filter = createResponsiveTypeFilter(['order.shipped']);
  const burst = [cand('e1', 'noise'), cand('e2', 'other')];
  const result = admitTurns(
    burst,
    { now: 1_000, typeFilter: filter, getType: (c) => (c as { type?: string }).type },
    emptyRateState(),
  );
  assert.deepEqual(result.admitted, []);
  assert.equal(result.suppressed.length, 2);
  // No turn was admitted, so the member's pacing anchor stays untouched.
  assert.equal(result.state.lastAdmittedAt, null);
});

// --- Property: only-worthy-drive-turns --------------------------------------
// Property (supports design Property 7): for ANY batch of Events, the turns the
// rate controller ADMITS are all of "worth responding to" types, and no Event
// of a non-responsive type is ever admitted (Req 10.3, 10.4).
//
// This app uses node:test (no fast-check), so we exercise the property over a
// deterministic pseudo-random space of type sequences.

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('Property: the rate controller only ever admits worth-responding-to types (Req 10.3, 10.4)', () => {
  const allow = ['order.shipped', 'payment.failed', 'ticket.assigned'];
  const noise = ['cart.viewed', 'page.loaded', 'noise', '', '   ', undefined];
  const pool = [...allow, ...noise];
  const filter = createResponsiveTypeFilter(allow);
  const allowSet = new Set(allow);

  for (let seed = 1; seed <= 300; seed++) {
    const rand = mulberry32(seed);
    let state = emptyRateState();
    let now = 0;
    let id = 0;

    const batches = 1 + Math.floor(rand() * 8);
    for (let b = 0; b < batches; b++) {
      now += 20_000 + Math.floor(rand() * 60_000); // wide gaps so merge never hides type filtering
      const size = 1 + Math.floor(rand() * 5);
      const candidates = Array.from({ length: size }, () => {
        const type = pool[Math.floor(rand() * pool.length)];
        return cand(`e${id++}`, type as string | undefined);
      });

      const result = admitTurns(
        candidates,
        { now, typeFilter: filter, getType: (c) => (c as { type?: string }).type },
        state,
      );
      state = result.state;

      // Invariant: every admitted candidate is of a worth-responding-to type.
      for (const admitted of result.admitted) {
        const type = (admitted as { type?: string }).type;
        assert.ok(
          typeof type === 'string' && allowSet.has(type),
          `seed ${seed}: admitted a non-responsive type "${String(type)}"`,
        );
      }
    }
  }
});
