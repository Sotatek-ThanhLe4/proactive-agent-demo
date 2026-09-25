import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PresenceStateStore } from './presence-state.js';

test('a member never seen defaults to offline (conservative — Req 5.1)', () => {
  const presence = new PresenceStateStore();
  assert.equal(presence.isOnline('member-1'), false);
  assert.equal(presence.presenceOf('member-1'), 'offline');
});

test('markOnline / markOffline toggle presence', () => {
  const presence = new PresenceStateStore();
  presence.markOnline('member-1');
  assert.equal(presence.isOnline('member-1'), true);
  assert.equal(presence.presenceOf('member-1'), 'online');

  presence.markOffline('member-1');
  assert.equal(presence.isOnline('member-1'), false);
  assert.equal(presence.presenceOf('member-1'), 'offline');
});

test('presence is per member', () => {
  const presence = new PresenceStateStore();
  presence.markOnline('member-1');
  assert.equal(presence.isOnline('member-1'), true);
  assert.equal(presence.isOnline('member-2'), false);
});

test('markOnline is idempotent', () => {
  const presence = new PresenceStateStore();
  presence.markOnline('member-1');
  presence.markOnline('member-1');
  assert.equal(presence.isOnline('member-1'), true);
  presence.markOffline('member-1');
  assert.equal(presence.isOnline('member-1'), false);
});

test('rejects an empty member id', () => {
  const presence = new PresenceStateStore();
  assert.throws(() => presence.markOnline('  '), TypeError);
  assert.throws(() => presence.isOnline(''), TypeError);
});

// --- Heartbeat TTL presence (Task 4, poll — OQ1) -----------------------------

test('with a TTL, a member stays Online only while polls keep the heartbeat fresh (Req 4.1)', () => {
  let now = 1000;
  const presence = new PresenceStateStore({ ttlMs: 30_000, now: () => now });

  presence.markOnline('member-1'); // a poll at t=1000
  assert.equal(presence.isOnline('member-1'), true);

  now = 1000 + 30_000; // exactly at the TTL edge → still online
  assert.equal(presence.isOnline('member-1'), true);

  now = 1000 + 30_001; // past the TTL, no further poll → Offline
  assert.equal(presence.isOnline('member-1'), false);
});

test('with a TTL, a fresh poll refreshes the online window', () => {
  let now = 1000;
  const presence = new PresenceStateStore({ ttlMs: 30_000, now: () => now });
  presence.markOnline('member-1');

  now = 1000 + 20_000;
  presence.markOnline('member-1'); // another poll refreshes the heartbeat
  now = 1000 + 45_000; // 25s after the refresh → still within TTL
  assert.equal(presence.isOnline('member-1'), true);
});

test('without a TTL, presence stays sticky until markOffline (backward compatible)', () => {
  let now = 1000;
  const presence = new PresenceStateStore({ now: () => now });
  presence.markOnline('member-1');
  now = 1000 + 10 * 60_000; // long after
  assert.equal(presence.isOnline('member-1'), true, 'no TTL → sticky online');
  presence.markOffline('member-1');
  assert.equal(presence.isOnline('member-1'), false);
});

test('rejects a non-positive ttlMs', () => {
  assert.throws(() => new PresenceStateStore({ ttlMs: 0 }), RangeError);
  assert.throws(() => new PresenceStateStore({ ttlMs: -1 }), RangeError);
});
