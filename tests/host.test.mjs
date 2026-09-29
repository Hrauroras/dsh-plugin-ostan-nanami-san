/**
 * Behavior tests for the OStan Nanami-San host projection.
 *
 * The pet reads exactly one number from the Host — the state snapshot — so these
 * tests pin the boundary contract: which live events move the pet and how they
 * outrank each other.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { PetBoundaryTracker, projectState, SPRITE_STATES } from '../lib/index.js'

/** Tracker with a frozen clock so time windows are deterministic. */
function trackerAt(start = 1_000_000) {
  let now = start
  const tracker = new PetBoundaryTracker({ now: () => now })
  return {
    tracker,
    advance(ms) {
      now += ms
      return now
    },
    at() {
      return now
    },
  }
}

test('a fresh tracker is idle with nothing running', () => {
  const { tracker } = trackerAt()
  const snapshot = tracker.snapshot()
  assert.equal(snapshot.state, 'idle')
  assert.equal(snapshot.status, 'idle')
  assert.equal(snapshot.busy, 0)
  assert.equal(snapshot.turns, 0)
  assert.equal(snapshot.sessions, 0)
})

test('turn/start moves the pet to work and counts the turn once', () => {
  const { tracker } = trackerAt()
  tracker.accept('s1', { type: 'turn/start', seq: 4 })
  assert.equal(tracker.snapshot().state, 'work')
  assert.equal(tracker.snapshot().status, 'working')
  assert.equal(tracker.snapshot().busy, 1)
  assert.equal(tracker.snapshot().turns, 1)
  // A duplicate delivery of the same durable boundary must not double count.
  tracker.accept('s1', { type: 'turn/start', seq: 4 })
  assert.equal(tracker.snapshot().turns, 1)
})

test('a normal turn end celebrates, then decays back to idle', () => {
  const clock = trackerAt()
  clock.tracker.accept('s1', { type: 'turn/start', seq: 1 })
  clock.tracker.accept('s1', { type: 'turn/end', seq: 2, data: { reason: { kind: 'completed' } } })
  assert.equal(clock.tracker.snapshot().state, 'cheer')
  assert.equal(clock.tracker.snapshot().status, 'done')
  assert.equal(clock.tracker.snapshot().busy, 0)
  clock.advance(7000)
  assert.equal(clock.tracker.snapshot().state, 'idle')
  assert.equal(clock.tracker.snapshot().status, 'idle')
})

test('a failed turn shows the worried face, and work outranks it', () => {
  const clock = trackerAt()
  clock.tracker.accept('s1', { type: 'turn/start', seq: 1 })
  clock.tracker.accept('s1', { type: 'turn/end', seq: 2, data: { reason: { kind: 'error' } } })
  assert.equal(clock.tracker.snapshot().status, 'error')
  assert.equal(clock.tracker.snapshot().state, 'wait')
  // A new turn immediately takes over from the stale failure.
  clock.tracker.accept('s1', { type: 'turn/start', seq: 3 })
  assert.equal(clock.tracker.snapshot().status, 'working')
  clock.advance(30_000)
  clock.tracker.accept('s1', { type: 'turn/end', seq: 4, data: { reason: { kind: 'error' } } })
  clock.advance(21_000)
  assert.equal(clock.tracker.snapshot().state, 'idle')
})

test('a cancellation is neither a success nor a failure', () => {
  const clock = trackerAt()
  clock.tracker.accept('s1', { type: 'turn/start', seq: 1 })
  clock.tracker.accept('s1', { type: 'turn/end', seq: 2, data: { reason: { kind: 'cancelled' } } })
  const snapshot = clock.tracker.snapshot()
  assert.equal(snapshot.state, 'idle')
  assert.equal(snapshot.status, 'cancelled')
  assert.equal(snapshot.cancelled, 1)
})

test('an open ask_user_question is the waiting signal', () => {
  const { tracker } = trackerAt()
  tracker.accept('s1', { type: 'turn/start', seq: 8 })
  tracker.accept('s1', {
    type: 'tool/call',
    seq: 9,
    data: { callId: 'q1', name: 'ask_user_question', arguments: '{"questions":[]}' },
  })
  const waiting = tracker.snapshot()
  assert.equal(waiting.state, 'wait', 'a turn blocked on the human has nothing to show')
  assert.equal(waiting.status, 'waiting')
  assert.equal(waiting.awaiting, 1)
  assert.equal(waiting.busy, 1, 'the turn itself is still running')
  // The answer is the matching result — and it must also retire the step.
  tracker.accept('s1', { type: 'tool/result', seq: 10, data: { message: { toolCallId: 'q1' } } })
  const answered = tracker.snapshot()
  assert.equal(answered.awaiting, 0)
  assert.equal(answered.status, 'working', 'back to work: the turn continues')
  assert.equal(answered.work.kind, 'last-tool')
})

test('an invented event type must not move the pet', () => {
  // The regression this guards: `question/request` is NOT in SessionEventMap.
  // An earlier version listened for it, so the waiting face never appeared.
  const { tracker } = trackerAt()
  tracker.accept('s1', { type: 'question/request', seq: 9 })
  tracker.accept('s1', { type: 'question/reply', seq: 10 })
  const snapshot = tracker.snapshot()
  assert.equal(snapshot.awaiting, 0)
  assert.equal(snapshot.state, 'idle')
})

test('a turn that ends with a question still open clears it', () => {
  const { tracker } = trackerAt()
  tracker.accept('s1', { type: 'turn/start', seq: 8 })
  tracker.accept('s1', { type: 'tool/call', seq: 9, data: { callId: 'q1', name: 'ask_user_question' } })
  assert.equal(tracker.snapshot().awaiting, 1)
  // An abort or a hang-up must not leave her waiting forever.
  tracker.accept('s1', { type: 'turn/end', seq: 10, data: { reason: { kind: 'aborted' } } })
  assert.equal(tracker.snapshot().awaiting, 0)
})

test('a closed ask_user_question does not linger as the current step', () => {
  const { tracker } = trackerAt()
  tracker.accept('s1', { type: 'tool/call', seq: 9, data: { callId: 'q1', name: 'ask_user_question' } })
  assert.equal(tracker.snapshot().awaiting, 1)
  tracker.accept('s1', { type: 'tool/result', seq: 10, data: { message: { toolCallId: 'q1' } } })
  const snapshot = tracker.snapshot()
  assert.equal(snapshot.awaiting, 0)
  assert.equal(snapshot.work.kind, 'last-tool', 'the question is now history, not a live step')
  assert.equal(snapshot.work.stale, false)
})

test('live status changes and session removal are folded in', () => {
  const { tracker } = trackerAt()
  tracker.acceptStatus('s1', true)
  assert.equal(tracker.snapshot().status, 'working')
  tracker.acceptStatus('s2', true)
  assert.equal(tracker.snapshot().busy, 2)
  tracker.acceptStatus('s1', false)
  assert.equal(tracker.snapshot().busy, 1)
  tracker.forget('s2')
  assert.equal(tracker.snapshot().sessions, 1)
  assert.equal(tracker.snapshot().busy, 0)
})

test('reconcile adopts agents that started before the plugin mounted', () => {
  const { tracker } = trackerAt()
  // The ledger knows nothing yet: this is the drift a pure event listener has.
  assert.equal(tracker.snapshot().busy, 0)
  const running = { id: 's1', status: 'running' }
  const idle = { id: 's2', status: 'idle' }
  const agents = { list: () => [running, idle], roots: () => [running, idle] }
  assert.equal(tracker.reconcile(agents), 2)
  const snapshot = tracker.snapshot()
  assert.equal(snapshot.busy, 1)
  assert.equal(snapshot.status, 'working')
  assert.equal(snapshot.sessions, 2)
})

test('reconcile drops a session the Host no longer lists', () => {
  const clock = trackerAt()
  const agents = { list: () => [{ id: 's1', status: 'running' }], roots: () => [] }
  clock.tracker.reconcile(agents)
  assert.equal(clock.tracker.snapshot().busy, 1)
  // A missed turn/end would have pinned this at running forever.
  const empty = { list: () => [], roots: () => [] }
  clock.tracker.reconcile(empty)
  assert.equal(clock.tracker.snapshot().busy, 0)
  assert.equal(clock.tracker.snapshot().sessions, 0)
})

test('a subagent turn is tracked but never counted as the user\'s work', () => {
  const { tracker } = trackerAt()
  const root = { id: 'main', status: 'idle' }
  const child = { id: 'child', status: 'running' }
  tracker.reconcile({ list: () => [root, child], roots: () => [root] })
  const snapshot = tracker.snapshot()
  assert.equal(snapshot.busy, 0, 'a published child must not drive the pet')
  assert.equal(snapshot.subagents, 1, 'but it is still visible for diagnosis')
  assert.equal(snapshot.state, 'idle')
  assert.equal(snapshot.sessions, 2)
})

test('an open question is reported as a question, not as a tool', () => {
  const { tracker } = trackerAt()
  tracker.accept('s1', { type: 'tool/call', seq: 9, data: { callId: 'q1', name: 'ask_user_question' } })
  const work = tracker.snapshot().work
  assert.equal(work.kind, 'question', 'the step a human sees is "she needs you"')
  assert.equal(work.label.zh, '正在等你回答')
  assert.equal(work.stale, false)
  // Once answered it becomes ordinary history under its own name.
  tracker.accept('s1', { type: 'tool/result', seq: 10, data: { message: { toolCallId: 'q1' } } })
  const after = tracker.snapshot().work
  assert.equal(after.kind, 'last-tool')
  assert.equal(after.label.key, 'ask_user_question')
})

test('a live question outranks a running turn', () => {
  const { tracker } = trackerAt()
  tracker.acceptStatus('s1', true)
  tracker.accept('s1', { type: 'tool/call', seq: 3, data: { callId: 'q1', name: 'ask_user_question' } })
  const snapshot = tracker.snapshot()
  assert.equal(snapshot.state, 'wait', 'a turn blocked on the user has nothing to show')
  assert.equal(snapshot.status, 'waiting')
  assert.equal(snapshot.busy, 1, 'the turn itself is still running')
})

test('reconcile tolerates a Host without the agent service', () => {
  const { tracker } = trackerAt()
  for (const agents of [undefined, null, {}, { list() { throw new Error('gone') } }]) {
    assert.doesNotThrow(() => tracker.reconcile(agents))
  }
  assert.equal(tracker.snapshot().state, 'idle')
})

test('a running agent with no root set still counts as work', () => {
  const { tracker } = trackerAt()
  // Without roots() we cannot prove it is a child, so the conservative answer
  // is "busy" rather than silently idle.
  tracker.reconcile({ list: () => [{ id: 's1', status: 'running' }] })
  assert.equal(tracker.snapshot().busy, 1)
})

test('hostile input never throws and never invents a state', () => {
  const { tracker } = trackerAt()
  for (const [id, event] of [
    [undefined, { type: 'turn/start', seq: 1 }],
    ['', { type: 'turn/start', seq: 1 }],
    ['s1', null],
    ['s1', 'turn/start'],
    ['s1', { type: 'assistant/message', seq: 3 }],
    ['s1', { type: 'turn/start' }],
    ['s1', { type: 'turn/end' }],
    ['s1', { type: 'turn/end', seq: 2, data: { reason: { kind: 42 } } }],
  ]) {
    assert.doesNotThrow(() => tracker.accept(id, event))
  }
  assert.equal(tracker.snapshot().state, 'idle')
})

test('a tool call becomes the current step, its result the last step', () => {
  const { tracker } = trackerAt()
  tracker.accept('s1', { type: 'tool/call', seq: 5, data: { callId: 'c1', name: 'grep', arguments: '{"pattern":"secret"}' } })
  let work = tracker.snapshot().work
  assert.equal(work.kind, 'tool')
  assert.equal(work.label.key, 'grep')
  assert.equal(work.label.zh, '正在搜代码')
  // The call's arguments are model output: they must not appear anywhere.
  assert.ok(!JSON.stringify(work).includes('secret'), 'tool arguments must never reach the snapshot')

  tracker.accept('s1', { type: 'tool/result', seq: 6, data: { message: { toolCallId: 'c1' } } })
  work = tracker.snapshot().work
  assert.equal(work.kind, 'last-tool')
  assert.equal(work.label.key, 'grep')
  assert.equal(work.stale, false)
})

test('a finished step goes stale instead of reading as live work', () => {
  const clock = trackerAt()
  clock.tracker.accept('s1', { type: 'tool/call', seq: 5, data: { callId: 'c1', name: 'bash' } })
  clock.tracker.accept('s1', { type: 'tool/result', seq: 6, data: { message: { toolCallId: 'c1' } } })
  assert.equal(clock.tracker.snapshot().work.stale, false)
  clock.advance(120_000)
  assert.equal(clock.tracker.snapshot().work.stale, true)
})

test('an ending turn retires the in-flight step instead of leaking it', () => {
  const clock = trackerAt()
  clock.tracker.accept('s1', { type: 'tool/call', seq: 5, data: { callId: 'c1', name: 'edit' } })
  assert.equal(clock.tracker.snapshot().work.kind, 'tool')
  clock.tracker.accept('s1', { type: 'turn/end', seq: 6, data: { reason: { kind: 'completed' } } })
  const work = clock.tracker.snapshot().work
  // The step is remembered as the last one — never still reported as running.
  assert.equal(work.kind, 'last-tool')
  assert.equal(work.label.key, 'edit')
  assert.equal(work.stale, false)
})

test('an unknown tool keeps its wire name rather than inventing a label', () => {
  const { tracker } = trackerAt()
  tracker.accept('s1', { type: 'tool/call', seq: 5, data: { callId: 'c9', name: 'brand_new_tool' } })
  const work = tracker.snapshot().work
  assert.equal(work.label.zh, 'brand_new_tool')
  assert.equal(work.label.known, false)
})

test('a subagent step never becomes the user-visible status', () => {
  const { tracker } = trackerAt()
  const root = { id: 'main', status: 'idle' }
  const child = { id: 'kid', status: 'running' }
  tracker.reconcile({ list: () => [root, child], roots: () => [root] })
  tracker.accept('kid', { type: 'tool/call', seq: 2, data: { callId: 'k1', name: 'read' } })
  assert.equal(tracker.snapshot().work, null, 'the user did not start that step')
  tracker.accept('main', { type: 'tool/call', seq: 3, data: { callId: 'm1', name: 'read' } })
  assert.equal(tracker.snapshot().work.kind, 'tool')
})

test('hostile tool events never throw and never invent a step', () => {
  const { tracker } = trackerAt()
  for (const event of [
    { type: 'tool/call', seq: 1 },
    { type: 'tool/call', seq: 2, data: {} },
    { type: 'tool/call', seq: 3, data: { name: '' } },
    { type: 'tool/call', seq: 4, data: { name: 42 } },
    { type: 'tool/result', seq: 5 },
    { type: 'tool/result', seq: 6, data: {} },
  ]) {
    assert.doesNotThrow(() => tracker.accept('s1', event))
  }
  assert.equal(tracker.snapshot().work, null)
})

test('the snapshot states which scope it is actually in', () => {
  const { tracker } = trackerAt()
  tracker.acceptStatus('mine', true)
  tracker.acceptStatus('other', true)

  // No session reported: the Host-wide read.
  const host = tracker.snapshot()
  assert.equal(host.following, 'host')
  assert.equal(host.scoped, false)
  assert.equal(host.busy, 2)

  // A known session: narrowed, and it says so.
  const mine = tracker.snapshot('mine', true)
  assert.equal(mine.following, 'session')
  assert.equal(mine.scoped, true)
  assert.equal(mine.busy, 1)
  assert.equal(mine.counted, 1)

  // A session the Host has not recorded yet must NOT be reported as followed,
  // or the menu would claim a scope the numbers did not come from.
  const unknown = tracker.snapshot('never-seen', true)
  assert.equal(unknown.following, 'unknown')
  assert.equal(unknown.counted, 0)
  assert.equal(unknown.busy, 0)
  assert.equal(unknown.work, null)
})

test('a known session that went idle still counts as followed', () => {
  const { tracker } = trackerAt()
  tracker.acceptStatus('mine', true)
  tracker.acceptStatus('mine', false)
  const snapshot = tracker.snapshot('mine', true)
  assert.equal(snapshot.following, 'session', 'idle is not the same as unknown')
  assert.equal(snapshot.busy, 0)
})

test('the projection is total: an empty tracker and a mixed one both answer', () => {
  const empty = projectState(new Map(), 5)
  assert.equal(empty.state, 'idle')
  assert.equal(empty.lastTurnAt, null)
  const busy = projectState(new Map([
    ['a', { running: true, pendingQuestion: 'q1', cancelled: false, error: true, errorAt: 10, endedAt: 9 }],
    ['b', { running: false, pendingQuestion: null, cancelled: true, error: false }],
  ]), 20)
  // A question outranks the running turn it blocked; error and success stay
  // outranked by both, and the counters stay independent.
  assert.equal(busy.state, 'wait')
  assert.equal(busy.status, 'waiting')
  assert.equal(busy.busy, 1)
  assert.equal(busy.awaiting, 1)
  assert.equal(busy.cancelled, 1)
  assert.equal(busy.sessions, 2)
  assert.equal(busy.lastTurnAt, 10)
})

test('the sprite manifest matches the shipped artwork', async () => {
  assert.deepEqual(SPRITE_STATES, ['idle', 'work', 'wait', 'cheer'])
  for (const state of SPRITE_STATES) {
    const bytes = await readFile(new URL(`../assets/${state}.png`, import.meta.url))
    assert.ok(bytes.length > 1000, `${state}.png looks empty`)
    assert.equal(bytes.subarray(1, 4).toString('ascii'), 'PNG')
  }
})
