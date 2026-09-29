/**
 * Route-level integration test for the Host half.
 *
 * Boots `apply()` against a stub Cordis context that records the two webServer
 * registrations, then drives both handlers with fake Node req/res pairs. This is
 * what catches a wrong asset directory, a malformed JSON contract, or a route
 * that leaks a caller-controlled path — before the GUI ever loads the plugin.
 */
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'

import { apply } from '../lib/index.js'

/** Boot apply() and capture the registered prefix routes. */
function boot({ agents } = {}) {
  const routes = []
  const effects = []
  const provided = new Map()
  const handlers = new Map()
  const webServer = {
    register(route) {
      routes.push(route)
      return () => {}
    },
  }
  // A live agent registry, so the mount-time reconcile has something real to
  // read. Defaults to an idle main session.
  const agentService = agents ?? {
    list: () => [{ id: 'main', status: 'idle' }],
    roots: () => [],
  }
  const ctx = {
    inject(keys, callback) {
      assert.deepEqual(keys, ['webServer'])
      callback({
        get: (key) => (key === 'webServer' ? webServer : undefined),
        effect(fn) {
          effects.push(fn)
          // Cordis runs an effect body on registration; mirror that so routes
          // land in `routes` before the test drives them.
          const dispose = fn()
          return typeof dispose === 'function' ? dispose : () => {}
        },
      })
    },
    get(key) {
      return key === 'agents' ? agentService : undefined
    },
    on(name, listener) {
      handlers.set(name, listener)
    },
    provide(key, value) {
      provided.set(key, value)
    },
    effect() {
      return () => {}
    },
  }
  apply(ctx)
  return { routes, effects, provided, handlers }
}

/** One fake request: a real readable stream, exactly like Node hands a handler. */
function fakeReq(method, url, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(body)])
  req.method = method
  req.url = url
  req.headers = {}
  return req
}

/** One fake response that records status, headers and payload. */
function fakeRes() {
  const res = {
    status: 0,
    headers: {},
    payload: undefined,
    writeHead(status, headers) {
      res.status = status
      res.headers = headers ?? {}
      return res
    },
    end(payload) {
      res.payload = payload
      return res
    },
  }
  return res
}

/** Call one route handler and resolve with its recorded response. */
async function call(route, method, url, body) {
  const res = fakeRes()
  await route.handler(fakeReq(method, url, body), res)
  return res
}

test('apply registers exactly the pet API and the sprite asset prefix', () => {
  const { routes, effects, provided } = boot()
  assert.deepEqual(routes.map(route => route.path).sort(), ['/api/ostan-nanami-san', '/ostan-nanami-san-assets'])
  for (const route of routes) assert.equal(route.kind, 'prefix')
  assert.equal(effects.length, 2, 'each route must be tied to the fiber lifecycle')
  assert.ok(provided.has('ostanNanamiSan'), 'the public service must be provided')
})

test('the state route answers the client snapshot contract', async () => {
  const { routes, handlers } = boot()
  // Feed one live boundary through the registered listener first.
  handlers.get('session/event')({ id: 's1' }, { type: 'turn/start', seq: 3 })
  const route = routes.find(entry => entry.path === '/api/ostan-nanami-san')
  const res = await call(route, 'GET', '/api/ostan-nanami-san/state')
  assert.equal(res.status, 200)
  assert.match(res.headers['content-type'], /application\/json/)
  const body = JSON.parse(res.payload)
  assert.equal(body.ok, true)
  assert.equal(body.name, 'OStan Nanami-San')
  assert.equal(body.state, 'work')
  assert.equal(body.status, 'working')
  assert.equal(body.busy, 1)
  assert.equal(body.turns, 1)
  assert.equal(body.work, null, 'no tool has run yet')
  assert.deepEqual(body.sprites.map(sprite => sprite.state), ['idle', 'work', 'wait', 'cheer'])
})

test('the state route narrows to the reported session, and says so', async () => {
  const { routes, handlers } = boot({ agents: { list: () => [], roots: () => [] } })
  const feed = handlers.get('session/event')
  // Two sessions: one the user is looking at, one running elsewhere.
  feed({ id: 'mine' }, { type: 'turn/start', seq: 2 })
  feed({ id: 'mine' }, { type: 'turn/end', seq: 3, data: { reason: { kind: 'completed' } } })
  feed({ id: 'other' }, { type: 'turn/start', seq: 2 })
  const route = routes.find(entry => entry.path === '/api/ostan-nanami-san')
  const read = async (query) => JSON.parse((await call(route, 'GET', `/api/ostan-nanami-san/state${query}`)).payload)

  const global = await read('')
  assert.equal(global.following, 'host')
  assert.equal(global.counted, 2)
  assert.equal(global.busy, 1, 'the other session is working')

  const mine = await read('?current=mine')
  assert.equal(mine.following, 'session')
  assert.equal(mine.counted, 1)
  assert.equal(mine.busy, 0, 'my session is idle even though another one works')
  assert.equal(mine.state, 'cheer', 'my own finished turn is what she reacts to')

  // An id the Host has never recorded must not be reported as followed.
  const unknown = await read('?current=ghost')
  assert.equal(unknown.following, 'unknown')
  assert.equal(unknown.counted, 0)
  assert.equal(unknown.busy, 0)
  assert.equal(unknown.work, null)
})

test('an empty current value is "no session", not an unknown one', async () => {
  const { routes, handlers } = boot({ agents: { list: () => [], roots: () => [] } })
  handlers.get('session/event')({ id: 'mine' }, { type: 'turn/start', seq: 2 })
  const route = routes.find(entry => entry.path === '/api/ostan-nanami-san')
  const read = async (query) => JSON.parse((await call(route, 'GET', `/api/ostan-nanami-san/state${query}`)).payload)
  for (const query of ['?current=', '?current=%20', '?current=%20%20']) {
    const body = await read(query)
    assert.equal(body.following, 'host', `${query} must read as "no session reported"`)
    assert.equal(body.counted, 1, 'and must therefore return the Host-wide reading')
  }
})

test('the debug id list is opt-in and carries identity only', async () => {
  const { routes, handlers } = boot({ agents: { list: () => [], roots: () => [] } })
  handlers.get('session/event')({ id: 's1' }, { type: 'turn/start', seq: 2 })
  const route = routes.find(entry => entry.path === '/api/ostan-nanami-san')
  const plain = JSON.parse((await call(route, 'GET', '/api/ostan-nanami-san/state')).payload)
  assert.equal(plain.ids, undefined, 'the ordinary poll stays small')
  const debug = JSON.parse((await call(route, 'GET', '/api/ostan-nanami-san/state?ids=1')).payload)
  assert.deepEqual(debug.ids, ['s1'])
})

test('the state route carries the current step, not the conversation', async () => {
  const { routes, handlers } = boot()
  const feed = handlers.get('session/event')
  feed({ id: 's1' }, { type: 'turn/start', seq: 3 })
  feed({ id: 's1' }, {
    type: 'tool/call',
    seq: 4,
    data: { callId: 'c1', name: 'grep', arguments: '{"pattern":"a secret the user typed"}' },
  })
  const route = routes.find(entry => entry.path === '/api/ostan-nanami-san')
  const payload = (await call(route, 'GET', '/api/ostan-nanami-san/state')).payload
  const body = JSON.parse(payload)
  assert.equal(body.work.kind, 'tool')
  assert.equal(body.work.label.key, 'grep')
  assert.equal(body.work.label.zh, '正在搜代码')
  assert.equal(body.work.stale, false)
  // The whole response must be free of the tool's arguments.
  assert.ok(!payload.includes('secret'), 'tool arguments must never leave the Host')
})

test('every advertised sprite is really on disk and served as revalidating PNG', async () => {
  const { routes } = boot()
  const route = routes.find(entry => entry.path === '/ostan-nanami-san-assets')
  for (const state of ['idle', 'work', 'wait', 'cheer']) {
    const res = await call(route, 'GET', `/ostan-nanami-san-assets/${state}.png`)
    assert.equal(res.status, 200, `${state}.png must be served`)
    assert.equal(res.headers['content-type'], 'image/png')
    // A corrected sprite must reach a browser that already cached the old one,
    // so the artwork is never marked immutable.
    assert.match(res.headers['cache-control'], /no-cache/)
    assert.ok(!/immutable/.test(res.headers['cache-control']))
    assert.ok(res.payload.length > 1000)
    assert.equal(res.payload.subarray(1, 4).toString('ascii'), 'PNG')
  }
})

test('the ETag is a content hash, not the filename', async () => {
  const { routes } = boot()
  const route = routes.find(entry => entry.path === '/ostan-nanami-san-assets')
  const etags = new Set()
  for (const state of ['idle', 'work', 'wait', 'cheer']) {
    const res = await call(route, 'GET', `/ostan-nanami-san-assets/${state}.png`)
    const etag = res.headers.ETag
    assert.match(etag, /^"[0-9a-f]{32}"$/, `${state} ETag should be a content digest`)
    assert.ok(!etag.includes(state), 'a filename-derived validator would not notice a redraw')
    etags.add(etag)
  }
  assert.equal(etags.size, 4, 'four different images must have four different validators')
})

test('the asset route refuses traversal and unknown names', async () => {
  const { routes } = boot()
  const route = routes.find(entry => entry.path === '/ostan-nanami-san-assets')
  for (const target of [
    '/ostan-nanami-san-assets/../../package.json',
    '/ostan-nanami-san-assets/lib%2Findex.js',
    '/ostan-nanami-san-assets/secret.png',
    '/ostan-nanami-san-assets/idle.svg',
  ]) {
    const res = await call(route, 'GET', target)
    assert.equal(res.status, 404, `${target} must not be served`)
  }
  const wrongMethod = await call(route, 'POST', '/ostan-nanami-san-assets/idle.png')
  assert.equal(wrongMethod.status, 405)
})

test('a conditional request gets a 304 with the same ETag', async () => {
  const { routes } = boot()
  const route = routes.find(entry => entry.path === '/ostan-nanami-san-assets')
  const first = await call(route, 'GET', '/ostan-nanami-san-assets/work.png')
  assert.ok(first.headers.ETag)
  const res = fakeRes()
  const req = fakeReq('GET', '/ostan-nanami-san-assets/work.png')
  req.headers = { 'if-none-match': first.headers.ETag }
  await route.handler(req, res)
  assert.equal(res.status, 304)
  assert.equal(res.payload, undefined)
})

test('a session already running at mount time is visible in the first snapshot', async () => {
  // The regression this guards: a pure event ledger never hears about a turn
  // that started before the plugin mounted, so the pet sits idle while the
  // user's session is working.
  const main = { id: 'main', status: 'running' }
  const child = { id: 'child', status: 'running' }
  const { routes } = boot({ agents: { list: () => [main, child], roots: () => [main] } })
  const route = routes.find(entry => entry.path === '/api/ostan-nanami-san')
  const body = JSON.parse((await call(route, 'GET', '/api/ostan-nanami-san/state')).payload)
  assert.equal(body.busy, 1, 'the user session counts, its published child does not')
  assert.equal(body.subagents, 1)
  assert.equal(body.state, 'work')
  assert.equal(body.sessions, 2)
})

test('a stale running flag is corrected by the next reconcile', async () => {
  let live = [{ id: 'main', status: 'running' }]
  const { routes, handlers } = boot({ agents: { list: () => live, roots: () => live } })
  const route = routes.find(entry => entry.path === '/api/ostan-nanami-san')
  assert.equal(JSON.parse((await call(route, 'GET', '/api/ostan-nanami-san/state')).payload).busy, 1)
  // The Host no longer lists the session, so a missed turn/end cannot pin it.
  live = []
  handlers.get('app-boot/config-reload')()
  const body = JSON.parse((await call(route, 'GET', '/api/ostan-nanami-san/state')).payload)
  assert.equal(body.busy, 0)
  assert.equal(body.sessions, 0)
  assert.equal(body.state, 'idle')
})

test('the interaction route validates its body and never trusts the caller', async () => {
  const { routes } = boot()
  const route = routes.find(entry => entry.path === '/api/ostan-nanami-san')
  const fed = await call(route, 'POST', '/api/ostan-nanami-san/interact', JSON.stringify({ kind: 'feed' }))
  assert.equal(JSON.parse(fed.payload).action, 'feed')
  const unknown = await call(route, 'POST', '/api/ostan-nanami-san/interact', JSON.stringify({ kind: '../etc/passwd' }))
  assert.equal(JSON.parse(unknown.payload).action, 'pet')
  const empty = await call(route, 'POST', '/api/ostan-nanami-san/interact', '')
  assert.equal(JSON.parse(empty.payload).action, 'pet')
  const broken = await call(route, 'POST', '/api/ostan-nanami-san/interact', '{not json')
  assert.equal(broken.status, 400)
  assert.equal(JSON.parse(broken.payload).ok, false)
  const huge = await call(route, 'POST', '/api/ostan-nanami-san/interact', 'x'.repeat(9000))
  assert.equal(huge.status, 413)
})

test('unknown routes inside the API prefix are a clean 404', async () => {
  const { routes } = boot()
  const route = routes.find(entry => entry.path === '/api/ostan-nanami-san')
  const res = await call(route, 'GET', '/api/ostan-nanami-san/../secret')
  assert.equal(res.status, 404)
  assert.equal(JSON.parse(res.payload).ok, false)
})
