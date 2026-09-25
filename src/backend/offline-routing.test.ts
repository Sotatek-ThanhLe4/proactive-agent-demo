import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventQueueStore } from './event-queue.js';
import { PresenceStateStore } from './presence-state.js';
import { createOfflineEventRouter } from './offline-routing.js';
import type { RoutedEvent } from './event-subject.js';

function makeEvent(memberId: string, overrides: Partial<RoutedEvent> = {}): RoutedEvent {
  return {
    type: 'order.shipped',
    subject: { memberId },
    timestamp: '2024-05-05T00:00:00.000Z',
    data: { orderId: 'o-1' },
    ...overrides,
  };
}

test('offline member → Event stored in queue, no online handler invoked (Req 5.1)', async () => {
  const presence = new PresenceStateStore();
  const queue = new EventQueueStore({ now: () => Date.parse('2024-05-05T01:00:00.000Z') });
  let onlineCalls = 0;
  const route = createOfflineEventRouter({
    presence,
    queue,
    onOnline: () => {
      onlineCalls += 1;
    },
  });

  const outcome = await route(makeEvent('member-1'));
  assert.equal(outcome.disposition, 'queued');
  assert.equal(onlineCalls, 0, 'offline path must not invoke the online seam');
  assert.equal(queue.pendingCount('member-1'), 1);
});

test('online member → online seam handles it, nothing queued', async () => {
  const presence = new PresenceStateStore();
  presence.markOnline('member-1');
  const queue = new EventQueueStore({ now: () => Date.parse('2024-05-05T01:00:00.000Z') });
  const delivered: RoutedEvent[] = [];
  const route = createOfflineEventRouter({
    presence,
    queue,
    onOnline: (event) => {
      delivered.push(event);
    },
  });

  const outcome = await route(makeEvent('member-1'));
  assert.equal(outcome.disposition, 'online');
  assert.equal(delivered.length, 1);
  assert.equal(queue.pendingCount('member-1'), 0, 'online Event must not be double-queued');
});

test('online member but no online seam wired → fail-safe queue so Event is not lost', async () => {
  const presence = new PresenceStateStore();
  presence.markOnline('member-1');
  const queue = new EventQueueStore({ now: () => Date.parse('2024-05-05T01:00:00.000Z') });
  const route = createOfflineEventRouter({ presence, queue });

  const outcome = await route(makeEvent('member-1'));
  assert.equal(outcome.disposition, 'queued');
  assert.equal(queue.pendingCount('member-1'), 1);
});

// --- Property 3: Offline không tiêu credit -----------------------------------
// When offline, an Event is only written to the Event_Queue; no agent turn runs
// and no credit is charged. We model "running the agent / charging credit" as a
// forbidden side effect and assert it never fires on the offline path.
//
// Validates: Requirements 5.2

test('Property 3: offline events never run an agent turn or charge credit', async () => {
  const presence = new PresenceStateStore();
  const queue = new EventQueueStore({ now: () => Date.parse('2024-05-05T01:00:00.000Z') });

  // Any call to the online seam would mean an agent turn / credit could run.
  let forbiddenAgentTurns = 0;
  const route = createOfflineEventRouter({
    presence,
    queue,
    onOnline: () => {
      forbiddenAgentTurns += 1;
    },
  });

  const memberIds = ['m-1', 'member-abc', 'guest:dep:sess', 'x'.repeat(120)];
  const types = ['order.shipped', 'cart.item_added', 'ticket.opened'];
  let enqueuedTotal = 0;

  for (const memberId of memberIds) {
    // Everyone is offline (default): no member marked online.
    for (const type of types) {
      const outcome = await route(makeEvent(memberId, { type, data: { type } }));
      assert.equal(outcome.disposition, 'queued', `offline ${memberId}/${type} must be queued`);
      enqueuedTotal += 1;
    }
  }

  assert.equal(forbiddenAgentTurns, 0, 'no agent turn / credit for any offline Event');
  // Every offline Event landed in its member's queue as pending.
  const totalPending = memberIds.reduce((sum, id) => sum + queue.pendingCount(id), 0);
  assert.equal(totalPending, enqueuedTotal);
});

// --- Property 4: Event không mất ---------------------------------------------
// Every valid Event of an offline member stays in the Event_Queue until it is
// processed or expires. We check: (a) within retention, all enqueued events are
// retrievable and none vanish; (b) a processed event is retained (marked), not
// lost; (c) only expiry (retention) removes an unprocessed event.
//
// Validates: Requirements 5.1, 5.3

test('Property 4: offline Events persist until processed or expired', async () => {
  let now = Date.parse('2024-05-05T00:00:00.000Z');
  const retentionMs = 10 * 60_000; // 10 minutes
  const queue = new EventQueueStore({ retentionMs, now: () => now });
  const presence = new PresenceStateStore();
  const route = createOfflineEventRouter({ presence, queue });

  // Enqueue a batch of offline events for one member within the window.
  const memberId = 'member-1';
  const ids: string[] = [];
  for (let i = 0; i < 12; i++) {
    const outcome = await route(
      makeEvent(memberId, { type: `t-${i}`, timestamp: new Date(now).toISOString() }),
    );
    assert.equal(outcome.disposition, 'queued');
    if (outcome.disposition === 'queued') ids.push(outcome.queued.id);
  }

  // (a) All events are present and none are lost while within retention.
  assert.equal(queue.pendingCount(memberId), 12, 'no Event lost within retention');

  // (b) Marking some processed retains them (not lost), just no longer pending.
  assert.equal(queue.markProcessed(memberId, ids[0]!), true);
  assert.equal(queue.markProcessed(memberId, ids[1]!), true);
  assert.equal(queue.pendingCount(memberId), 10);
  assert.equal(queue.list(memberId).length, 12, 'processed Events retained, not dropped');

  // (c) Only crossing the retention window removes the remaining unprocessed
  // Events — nothing disappears before then.
  now += retentionMs - 1; // still within window
  assert.equal(queue.pendingCount(memberId), 10, 'still retained just before expiry');
  now += 2; // now past the window
  assert.equal(queue.pendingCount(memberId), 0, 'expired only after retention window');
  assert.equal(queue.list(memberId).length, 0);
});
