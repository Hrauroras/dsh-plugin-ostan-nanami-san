/**
 * Client-half tests: module contract + real component logic.
 *
 * The bundle is plain JavaScript that expects DSH's `__ModuleLoader__` and a
 * React from the loader's module table. These tests boot exactly that contract
 * against a small React double whose hooks actually work (state updates
 * re-render, effects register their cleanups), and then read the rendered
 * element tree the way React would.
 *
 * Labels are quoted from the bundle's own dictionaries rather than retyped, so
 * a copy change fails here for the right reason; the Chinese literals below are
 * the only non-ASCII text in this file.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

/** The bundle source, read once for every boot. */
const SOURCE = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')

/** Set OSTAN_TEST_TRACE=1 to print hook bookkeeping while diagnosing a loop. */
const LOOP_TRACE = process.env.OSTAN_TEST_TRACE === '1'

/** Pull one string literal out of the bundle so tests never retype copy. */
function literal(needle) {
  const index = SOURCE.indexOf(needle)
  assert.ok(index >= 0, `bundle no longer contains ${JSON.stringify(needle)}`)
  const start = SOURCE.lastIndexOf("'", index)
  const end = SOURCE.indexOf("'", index + needle.length)
  return SOURCE.slice(start + 1, end)
}

/**
 * A React double good enough to render a hook-using component by hand.
 *
 * `mount(Component)` returns a live instance: `tree` is the last rendered
 * element, `hooks` exposes the state slots, and `unmount()` runs the cleanups.
 * The runtime object is exposed as `runtime`, because the component under test
 * must see the hook API as its own `React` global, not the harness around it.
 */
function createReactDouble() {
  const runtime = {
    createElement: (type, props, ...children) => renderElement(type, props, children),
    Fragment: Symbol('Fragment'),
    Component: class {},
  }

  /**
   * Render one element the way React would.
   *
   * A class component is returned as an ELEMENT, not called: React owns that
   * instance, and the mount layer below is what renders it. Calling it here
   * would splice the boundary out of the tree and hide exactly the component
   * under test.
   */
  function renderElement(type, props, children) {
    return { type, props: props ?? {}, children }
  }

  // The hook slots live on the runtime, not inside `mount`, because a test may
  // run a wrapped component's outer function (the error boundary) BEFORE it
  // mounts: `componentFor` does exactly that, and without hooks present it
  // would blow up with "React.useState is not a function".
  const hooks = []
  let cursor = 0

  runtime.useState = (initial) => {
    const index = cursor
    cursor += 1
    if (hooks[index] === undefined) {
      hooks[index] = { value: typeof initial === 'function' ? initial() : initial }
    }
    const slot = hooks[index]
    return [slot.value, (next) => {
      const value = typeof next === 'function' ? next(slot.value) : next
      if (Object.is(value, slot.value)) return
      slot.value = value
      if (runtime.__rerender !== undefined) runtime.__rerender()
    }]
  }
  runtime.useRef = (initial) => {
    const index = cursor
    cursor += 1
    if (hooks[index] === undefined) hooks[index] = { current: initial }
    return hooks[index]
  }
  runtime.useCallback = (fn, next) => {
    const index = cursor
    cursor += 1
    if (hooks[index] !== undefined && runtime.__sameDeps(hooks[index].deps, next)) return hooks[index].value
    hooks[index] = { value: fn, deps: next }
    return fn
  }
  runtime.useEffect = (fn, next) => {
    const index = cursor
    cursor += 1
    if (runtime.__collectEffect !== undefined) runtime.__collectEffect(index, fn, next)
  }
  runtime.__sameDeps = (previous, next) => {
    if (next === undefined) return false
    if (previous === undefined || previous.length !== next.length) return false
    return previous.every((value, position) => Object.is(value, next[position]))
  }

  /** One mounted component instance: hooks, state, effects, rendered tree. */
  function mount(Component, props = {}) {
    cursor = 0
    hooks.length = 0
    const effects = []
    const cleanups = new Map()
    /** The dependency array each effect slot last ran with. */
    const effectDeps = new Map()
    /** The dependency array each memoized callback slot last used. */
    const callbackDeps = new Map()
    /** Renders scheduled by a state update, drained after the current commit. */
    let pendingRenders = 0
    /** Commits in a row that changed nothing, i.e. a genuine update loop. */
    let unchangingCommits = 0
    /** The last state update, for diagnosing a loop. */
    let lastSetter
    const instance = {
      tree: null,
      hooks,
      unmount() {
        for (const cleanup of cleanups.values()) cleanup()
        cleanups.clear()
      },
    }

    /**
     * Render one pass and settle effects, the way React does.
     *
     * Two semantics matter here and both are easy to get wrong:
     *
     *  - an effect re-runs only when its dependency array changed, and
     *  - effects flush AFTER the commit, so a `setState` inside an effect
     *    schedules the next render instead of recursing into this one.
     *
     * A double that skipped either would loop forever on any effect that sets
     * state, which is exactly what the bubble effects do.
     */
    function render() {
      pendingRenders += 1
      while (pendingRenders > 0) {
        pendingRenders -= 1
        const before = instance.tree
        commit()
        // The guard must catch a real update loop without punishing a test that
        // legitimately renders many times: every commit that changes the tree
        // resets the streak.
        if (instance.tree !== before) unchangingCommits = 0
        else unchangingCommits += 1
        if (unchangingCommits > 40) {
          console.error('[harness] commit loop; last setter trace:')
          console.error(lastSetter ?? '(none)')
          console.error('[harness] last commit tree signature:', describeTree(instance.tree))
          throw new Error('render loop: a state update keeps re-rendering')
        }
      }
      return instance.tree
    }

    /** One commit: render the component, then flush its dirty effects. */
    function commit() {
      cursor = 0
      effects.length = 0
      const used = new Set()
      instance.tree = Component(props)
      for (const { index, fn, next } of effects) {
        used.add(index)
        if (sameDeps(effectDeps, index, next)) continue
        if (cleanups.has(index)) {
          cleanups.get(index)()
          cleanups.delete(index)
        }
        // Record the dependency array BEFORE running the effect body: React
        // commits new deps with the render, so an effect that throws must not
        // be left looking dirty and re-run on the following commit.
        effectDeps.set(index, next)
        const cleanup = fn()
        if (typeof cleanup === 'function') cleanups.set(index, cleanup)
      }
      for (const [index, cleanup] of Array.from(cleanups)) {
        if (!used.has(index)) {
          cleanup()
          cleanups.delete(index)
          effectDeps.delete(index)
        }
      }
    }

    /**
     * Whether a dependency array is unchanged from the previous render.
     *
     * Real React compares element-wise with Object.is; a double that skipped
     * this would re-run every effect on every render and turn any effect that
     * sets state into an endless loop. Callback and effect memoization keep
     * separate records, because they occupy separate hook slots.
     */
    function sameDeps(table, index, next) {
      const previous = table.get(index)
      if (next === undefined) return false
      if (previous === undefined || previous.length !== next.length) return false
      return previous.every((value, position) => Object.is(value, next[position]))
    }

    runtime.useState = (initial) => {
      const index = cursor
      cursor += 1
      if (hooks[index] === undefined) {
        hooks[index] = { value: typeof initial === 'function' ? initial() : initial }
      }
      const slot = hooks[index]
      return [slot.value, (next) => {
        const value = typeof next === 'function' ? next(slot.value) : next
        if (Object.is(value, slot.value)) return
        slot.value = value
        lastSetter = `hook#${index}: ${JSON.stringify(value)?.slice(0, 90)}\n${new Error('set').stack?.split('\n').slice(2, 6).join('\n')}`
        render()
      }]
    }
    runtime.useRef = (initial) => {
      const index = cursor
      cursor += 1
      if (hooks[index] === undefined) hooks[index] = { current: initial }
      return hooks[index]
    }
    runtime.useCallback = (fn, next) => {
      const index = cursor
      cursor += 1
      const reused = hooks[index] !== undefined && sameDeps(callbackDeps, index, next)
      if (LOOP_TRACE && (index === 22 || index === 23 || index === 24)) {
        console.error(`  [useCallback#${index}] deps=${JSON.stringify(next)?.slice(0, 30)} reused=${reused}`)
      }
      if (reused) return hooks[index].value
      hooks[index] = { value: fn }
      callbackDeps.set(index, next)
      return fn
    }
    runtime.useEffect = (fn, next) => {
      const index = cursor
      cursor += 1
      if (LOOP_TRACE && index >= 19 && index <= 20) {
        console.error(`  [useEffect#${index}] deps=${JSON.stringify(next)?.slice(0, 70)}`)
      }
      effects.push({ index, fn, next })
    }

    instance.render = render
    render()
    return instance
  }

  return { runtime, mount, hooks }
}

/** The loader environment one bundle evaluation needs. */
function bootEnvironment({ language = 'zh-CN' } = {}) {
  const loaded = []
  /** Live fake intervals, so a test can drive one poll by hand. */
  const intervals = new Map()
  let nextTimer = 1
  let nextTimeout = 1
  const timeouts = new Map()
  const window = {
    innerWidth: 1280,
    innerHeight: 820,
    localStorage: {
      map: new Map(),
      getItem(key) {
        return this.map.has(key) ? this.map.get(key) : null
      },
      setItem(key, value) {
        this.map.set(key, String(value))
      },
    },
    setTimeout(fn, delay) {
      const id = nextTimeout
      nextTimeout += 1
      timeouts.set(id, { fn, delay })
      return id
    },
    clearTimeout(id) {
      timeouts.delete(id)
    },
    setInterval(fn, delay) {
      const id = nextTimer
      nextTimer += 1
      intervals.set(id, { fn, delay })
      return id
    },
    clearInterval(id) {
      intervals.delete(id)
    },
    /**
     * Every listener ever registered on this window, by event name. Effects
     * register during the mount pass, so a test must read this record rather
     * than install its own collector after the fact.
     */
    listeners: new Map(),
    addEventListener(name, fn) {
      window.listeners.set(name, fn)
    },
    removeEventListener(name) {
      window.listeners.delete(name)
    },
    /** Replaced per test; the bundle reads its transport through window. */
    fetch: () => Promise.reject(new Error('no fetch stub installed')),
    __ModuleLoader__: { load: (spec) => loaded.push(spec) },
  }
  /** Document visibility is a live property, so tests can change it. */
  let visibility = 'visible'
  const visibilityListeners = new Set()
  const document = {
    documentElement: { lang: language },
    get visibilityState() {
      return visibility
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ dataset: {}, style: {}, remove() {}, setAttribute() {} }),
    head: { appendChild() {} },
    addEventListener(name, fn) {
      if (name === 'visibilitychange') visibilityListeners.add(fn)
    },
    removeEventListener(name, fn) {
      if (name === 'visibilitychange') visibilityListeners.delete(fn)
    },
  }
  return {
    window,
    document,
    loaded,
    /** Switch the document's visibility and notify whoever is listening. */
    setVisibility(next) {
      visibility = next
      for (const fn of Array.from(visibilityListeners)) fn()
    },
    /** Fire every live interval once — one poll cycle per interval. */
    tickTimers() {
      for (const { fn } of Array.from(intervals.values())) fn()
    },
    /**
     * Fire only the state poll, not every interval.
     *
     * The companion keeps two: the 1500 ms poll and the 5000 ms watchdog. Firing
     * both in one "publish a snapshot" step sends two requests and lets the
     * second one race the first, which is how a test that only meant to deliver
     * one snapshot ended up reading an offline posture.
     */
    tickPoll() {
      const entry = Array.from(intervals.values()).find((timer) => timer.delay === 1500)
      assert.ok(entry, 'the state poll interval must be live')
      entry.fn()
    },
    /** Pending timeouts, so a test can assert a bubble timer was scheduled. */
    timeouts,
    intervals,
  }
}

/** Evaluate the bundle and return the plugin object DSH would receive. */
function loadPlugin({ language = 'zh-CN' } = {}) {
  const env = bootEnvironment({ language })
  const react = createReactDouble()
  const modules = { react: react.runtime }
  const run = new Function('window', 'document', 'navigator', 'MutationObserver', SOURCE)
  run(env.window, env.document, { language }, class { observe() {} disconnect() {} })
  assert.equal(env.loaded.length, 1, 'the bundle must load exactly one module')
  const spec = env.loaded[0]
  const plugin = spec.factory((id) => {
    if (Object.prototype.hasOwnProperty.call(modules, id)) return modules[id]
    throw new Error(`unexpected require('${id}')`)
  })
  return { spec, plugin, react, env }
}

/**
 * Boot apply() and hand back the registered component plus recorded effects.
 *
 * The environment window becomes the global `window` for the whole test and is
 * restored when the test ends, whichever way it ends.
 */
function registerPet(t) {
  const { spec, plugin, react, env } = loadPlugin()
  const originalWindow = globalThis.window
  globalThis.window = env.window
  if (t !== undefined) t.after(() => { globalThis.window = originalWindow })
  const registrations = []
  const effects = []
  /** Slots the bundle asked for, in order: overlay companion then session probe. */
  const injected = []
  const ctx = {
    slots: {
      inject(key, callback) {
        injected.push(key)
        return callback()
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
    effect(fn, label) {
      effects.push({ fn, label })
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
  }
  plugin.apply(ctx)
  assert.deepEqual(injected, ['shell.overlay', 'conversation.chat.turnTail'])
  assert.equal(registrations.length, 2)
  return { spec, registrations, effects, react, env, injected }
}

/** The companion registration (the overlay seat). */
function petRegistration(registrations) {
  const found = registrations.find((entry) => entry.options.name === 'shell.overlay')
  assert.ok(found, 'the companion must be seated in shell.overlay')
  return found
}

/** The session-probe registration (the conversation seat). */
function probeRegistration(registrations) {
  const found = registrations.find((entry) => entry.options.name === 'conversation.chat.turnTail')
  assert.ok(found, 'the session probe must be seated in the conversation')
  return found
}

/**
 * Return the component a test should mount.
 *
 * The bundle wraps the companion in an error boundary. The wrapper is a plain
 * function returning a boundary ELEMENT whose child is the companion element,
 * so the honest thing for the harness to do is render the wrapper once and then
 * mount that child — which is what React does with the same tree.
 *
 * The wrapper's own hook slots are cleared afterwards, because real React gives
 * every component its own instance and this harness does not.
 */
function componentFor(react, registration) {
  const Component = registration.component
  const boundary = Component({})
  if (boundary === null || typeof boundary !== 'object') return Component
  const children = Array.isArray(boundary.children) ? boundary.children : []
  const child = children.find(
    (entry) => entry !== null && typeof entry === 'object' && typeof entry.type === 'function',
  )
  if (child === undefined) return Component
  react.hooks.length = 0
  // Mark the peel so mountPet can restore the wrapper's hook slots afterwards.
  child.type.__ostanPeeled = true
  return child.type
}

/**
 * Mount one pet instance against the registered component.
 *
 * The fake window must stay installed as the global `window` for the whole
 * test, not just the mount: the component's effects run on every state update,
 * and a promise callback that touches `window.clearTimeout` while the global
 * was restored would throw inside the component's own catch, silently turning
 * the snapshot into its offline posture. `registerPet` installs the window and
 * schedules the restore, so tests never juggle it themselves.
 *
 * The transport is pre-stubbed with an idle snapshot because the poll opens
 * during the first effect pass; `publishSnapshot` swaps in the real one.
 */
function mountPet(react, registrations, env) {
  if (env !== undefined) {
    env.window.fetch = () => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ ok: true, state: 'idle', status: 'idle', busy: 0, turns: 0 }),
    })
  }
  return react.mount(componentFor(react, petRegistration(registrations)), {})
}

/** Compact description of one rendered tree, for loop diagnostics. */
function describeTree(node, depth = 0) {
  if (node === null || node === undefined) return String(node)
  if (Array.isArray(node)) return `[${node.map((child) => describeTree(child, depth)).join(' ')}]`
  if (typeof node !== 'object') return String(node)
  if (depth > 4) return '…'
  const className = node.props?.className
  const own = className ?? (typeof node.type === 'string' ? node.type : 'cmp')
  const children = (node.children ?? []).map((child) => describeTree(child, depth + 1)).filter((text) => text !== '').join(' ')
  return children === '' ? own : `${own}(${children})`
}

/** Walk a rendered tree, returning every element matching a predicate. */
function collect(node, predicate, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) collect(child, predicate, out)
    return out
  }
  if (node.type !== undefined && predicate(node)) out.push(node)
  for (const child of node.children ?? []) collect(child, predicate, out)
  return out
}

/** Find one element in a rendered tree by class name. */
function byClass(tree, className) {
  return collect(tree, (node) => node.props?.className === className)[0]
}

/** Every button in the open menu, in render order. */
function menuButtons(tree) {
  const menu = byClass(tree, 'ons-menu')
  if (menu === undefined) return []
  return collect(menu, (node) => node.type === 'button')
}

/** Every button label currently rendered inside the open menu. */
function menuLabels(tree) {
  return menuButtons(tree).map((button) => button.children[0])
}

/** Click one menu button by its label. */
function clickMenu(tree, label) {
  const button = menuButtons(tree).find((candidate) => candidate.children[0] === label)
  assert.ok(button, `no menu button labelled ${label}`)
  button.props.onClick()
}

/** Open the context menu on a mounted pet. */
function openMenu(pet) {
  byClass(pet.tree, 'ons-sprite').props.onContextMenu({ preventDefault() {} })
  pet.render()
  return pet
}

/**
 * Publish one host snapshot and settle the component.
 *
 * The poll lives on an interval, so a test drives exactly one cycle: swap the
 * transport, fire the live timers, let the promise chain and any state updates
 * land, then re-render.
 */
async function publishSnapshot(pet, env, snapshot) {
  env.window.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve(snapshot) })
  env.tickPoll()
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  pet.render()
}

/** The component's local store state slot. */
function storeOf(pet) {
  const index = pet.hooks.findIndex((hook) => hook?.value && typeof hook.value === 'object' && 'points' in hook.value)
  assert.ok(index >= 0, 'the local store must be component state')
  return pet.hooks[index].value
}

/** Age the local store's nap clock, as a long quiet stretch would. */
function ageStore(pet, ms) {
  const store = storeOf(pet)
  store.lastSeenAt = Date.now() - ms
}

test('a long quiet stretch puts her to sleep when the Host has nothing to say', async (t) => {
  const { registrations, react, env } = registerPet(t)
  const pet = mountPet(react, registrations, env)
  ageStore(pet, 4 * 60 * 1000)
  await publishSnapshot(pet, env, { ok: true, state: 'idle', status: 'idle', busy: 0, turns: 2 })
  assert.equal(byClass(pet.tree, 'ons-root').props['data-mood'], 'sleep')
})

test('sleeping and working coexist: a long run does not force her awake', async (t) => {
  // By request. A busy Host must NOT wake her — she naps through a long run and
  // the user wakes her by interacting. Work is not a reason to be awake.
  const { registrations, react, env } = registerPet(t)
  const pet = mountPet(react, registrations, env)
  ageStore(pet, 10 * 60 * 1000)
  await publishSnapshot(pet, env, { ok: true, state: 'work', status: 'working', busy: 1, turns: 3 })
  assert.equal(byClass(pet.tree, 'ons-root').props['data-mood'], 'sleep', 'work alone must not wake her')
  // And a finished turn or a failure does not either.
  ageStore(pet, 10 * 60 * 1000)
  await publishSnapshot(pet, env, { ok: true, state: 'idle', status: 'done', busy: 0, turns: 4 })
  assert.equal(byClass(pet.tree, 'ons-root').props['data-mood'], 'sleep')
})

test('a pending question ALWAYS wins, even out of a deep sleep', async (t) => {
  // The one thing that must never be missed: the human is being asked to act.
  const { registrations, react, env } = registerPet(t)
  const pet = mountPet(react, registrations, env)
  ageStore(pet, 30 * 60 * 1000)
  await publishSnapshot(pet, env, { ok: true, state: 'work', status: 'working', busy: 1, turns: 3 })
  assert.equal(byClass(pet.tree, 'ons-root').props['data-mood'], 'sleep', 'asleep first')

  await publishSnapshot(pet, env, { ok: true, state: 'wait', status: 'waiting', awaiting: 1, busy: 1, turns: 3 })
  assert.equal(byClass(pet.tree, 'ons-root').props['data-mood'], 'wait', 'the question overrides the nap')

  // Answering it leaves her awake rather than dropping straight back to sleep.
  await publishSnapshot(pet, env, { ok: true, state: 'work', status: 'working', busy: 1, turns: 3 })
  assert.equal(byClass(pet.tree, 'ons-root').props['data-mood'], 'work', 'and she stays up afterwards')
})

test('a question outranks a manual mood override too', async (t) => {
  const { registrations, react, env } = registerPet(t)
  const pet = mountPet(react, registrations, env)
  openMenu(pet)
  clickMenu(pet.tree, LABEL.cheer)
  pet.render()
  assert.equal(byClass(pet.tree, 'ons-root').props['data-mood'], 'cheer')
  await publishSnapshot(pet, env, { ok: true, state: 'wait', status: 'waiting', awaiting: 1, busy: 1, turns: 1 })
  assert.equal(byClass(pet.tree, 'ons-root').props['data-mood'], 'wait', 'a pending question is not overridable')
})

test('poking her wakes her up and keeps her awake', async (t) => {
  const { registrations, react, env } = registerPet(t)
  const pet = mountPet(react, registrations, env)
  ageStore(pet, 10 * 60 * 1000)
  await publishSnapshot(pet, env, { ok: true, state: 'idle', status: 'idle', busy: 0, turns: 2 })
  assert.equal(byClass(pet.tree, 'ons-root').props['data-mood'], 'sleep')

  // One pat.
  withWindowCapture(env, (listeners) => {
    pressSprite(pet, ELEMENT)
    listeners.get('pointerup')({ clientX: 1000, clientY: 600 })
  })
  pet.render()
  assert.equal(byClass(pet.tree, 'ons-root').props['data-mood'], 'idle', 'a pat wakes her')

  // The nap clock is stale again, but the poke keeps her up.
  const store = storeOf(pet)
  store.lastSeenAt = Date.now() - 10 * 60 * 1000
  assert.ok(store.awakeUntil > Date.now(), 'the pat must set an awake window')
  pet.render()
  assert.equal(byClass(pet.tree, 'ons-root').props['data-mood'], 'idle', 'and she stays awake through it')
})

test('the sleep line is allowed while working, because sleeping and working coexist', async (t) => {
  const { registrations, react, env } = registerPet(t)
  const pet = mountPet(react, registrations, env)
  await publishSnapshot(pet, env, { ok: true, state: 'work', status: 'working', busy: 1, turns: 3 })
  ageStore(pet, 40 * 60 * 1000)
  pet.render()
  assert.equal(byClass(pet.tree, 'ons-root').props['data-mood'], 'sleep', 'she is asleep in the middle of the run')
  // The bubble is allowed to say so: it no longer contradicts the pose.
  env.tickTimers()
  pet.render()
  assert.ok(byClass(pet.tree, 'ons-bubble'), 'a sleeping companion may mutter a sleep line during a run')
})

/**
 * Run `body` with the listeners the mount effects registered.
 *
 * The registry lives on the environment window, so the body fires the very
 * handlers the component installed rather than a stand-in.
 */
function withWindowCapture(env, body) {
  return body(env.window.listeners)
}

/** Begin a gesture on the sprite. */
function pressSprite(pet, element, point = { clientX: 1000, clientY: 600 }) {
  byClass(pet.tree, 'ons-sprite').props.onPointerDown({
    button: 0,
    ...point,
    currentTarget: { closest: () => element },
  })
}

const ELEMENT = { getBoundingClientRect: () => ({ left: 900, top: 400, width: 148, height: 348 }) }

// Labels quoted straight from the bundle dictionaries.
const LABEL = {
  follow: '跟随实际状态',
  rest: '休息一下',
  work: '去干活',
  wait: '等你',
  cheer: '开心一下',
  pat: '摸摸头',
  feed: '投喂',
  hide: '隐藏桌宠',
  bigger: '＋',
  smaller: '－',
}

// Scope lines, quoted from the bundle so a copy change cannot pass silently.
const SCOPE_CURRENT = '跟随：你正在看的会话'
const SCOPE_HOST = '跟随：整个 Host'
const SCOPE_UNKNOWN = '跟随：整个 Host（当前会话尚未被识别）'

test('every expected label really exists in the bundle dictionaries', (t) => {
  for (const [name, text] of Object.entries(LABEL)) {
    assert.ok(SOURCE.includes(text), `${name} (${text}) is missing from the bundle`)
  }
  assert.ok(SOURCE.includes('Follow live status'), 'the English dictionary must ship too')
})

test('the bundle registers under the package id and exposes the plugin shape', () => {
  const { spec, plugin } = loadPlugin()
  assert.equal(spec.id, 'dsh-plugin-ostan-nanami-san')
  assert.equal(typeof spec.factory, 'function')
  assert.equal(typeof plugin.apply, 'function')
  assert.deepEqual(plugin.inject, ['slots'])
})

test('the factory only needs react from the module table', () => {
  // A missing module throws inside loadPlugin; reaching here proves the bundle
  // stays on the documented baseline and needs no react-dom at all.
  const { plugin } = loadPlugin()
  assert.equal(typeof plugin.apply, 'function')
})

test('apply seats the companion in the overlay and a probe in the conversation', (t) => {
  const { registrations, effects, injected } = registerPet(t)
  const pet = petRegistration(registrations)
  assert.equal(pet.options.id, 'ostan-nanami-san')
  assert.equal(pet.options.order, 88)
  assert.equal(typeof pet.component, 'function')
  const probe = probeRegistration(registrations)
  assert.equal(probe.options.id, 'ostan-nanami-san-session')
  assert.equal(typeof probe.component, 'function')
  assert.deepEqual(injected, ['shell.overlay', 'conversation.chat.turnTail'])
  assert.equal(effects.length, 1, 'only the style effect belongs to apply')
  assert.equal(effects[0].label, 'ostan-nanami-san: styles')
})

test('the companion rides the session the probe reports', async (t) => {
  const { registrations, react, env } = registerPet(t)
  const originalWindow = globalThis.window
  globalThis.window = env.window
  try {
    const fetched = []
    env.window.fetch = (url) => {
      fetched.push(String(url))
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, state: 'idle', status: 'idle', busy: 0, turns: 0, scoped: true }),
      })
    }
    // Mount the probe first: it is what tells the companion which session the
    // user is looking at. Without it the companion must ask for the whole Host.
    const probe = react.mount(probeRegistration(registrations).component, { sessionId: 'session-abc' })
    const pet = react.mount(componentFor(react, petRegistration(registrations)), {})
    assert.ok(probe.tree === null || probe.tree === undefined, 'the probe renders nothing')

    env.tickTimers()
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
    pet.render()

    assert.ok(fetched.length > 0, 'the companion must poll')
    assert.ok(
      fetched.every((url) => url.includes('current=session-abc')),
      `every poll must carry the visible session, got ${fetched.join(', ')}`,
    )
  } finally {
    globalThis.window = originalWindow
  }
})

test('without a session probe the companion asks for the whole Host', async (t) => {
  const { registrations, react, env } = registerPet(t)
  const originalWindow = globalThis.window
  globalThis.window = env.window
  try {
    const fetched = []
    env.window.fetch = (url) => {
      fetched.push(String(url))
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, state: 'idle', status: 'idle', busy: 0, turns: 0, scoped: false }),
      })
    }
    const pet = mountPet(react, registrations, env)
    env.window.fetch = (url) => {
      fetched.push(String(url))
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, state: 'idle', status: 'idle', busy: 0, turns: 0, scoped: false }),
      })
    }
    pet.render()
    env.tickTimers()
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
    assert.ok(fetched.length > 0)
    assert.ok(fetched.every((url) => !url.includes('current=')), 'no session means no narrowing')
  } finally {
    globalThis.window = originalWindow
  }
})

test('the scope line repeats the Host\'s answer, not the client\'s guess', async (t) => {
  const { registrations, react, env } = registerPet(t)
  // Probe first, then the pet: the companion's poll reads the scope when its
  // effect opens, and the menu renders the same value.
  react.mount(probeRegistration(registrations).component, { sessionId: 'session-xyz' })
  const pet = mountPet(react, registrations)
  const openMenuAndRead = () => {
    byClass(pet.tree, 'ons-sprite').props.onContextMenu({ preventDefault() {} })
    pet.render()
    const line = byClass(pet.tree, 'ons-scope')
    assert.ok(line, 'the menu must carry a scope line')
    return line.children[0]
  }

  // The Host reports the session is followed.
  const base = { ok: true, busy: 1, turns: 1, state: 'work', status: 'working' }
  await publishSnapshot(pet, env, { ...base, following: 'session', scoped: true, counted: 1 })
  assert.equal(openMenuAndRead(), SCOPE_CURRENT)

  // The id was sent but the Host has not recorded it: the readings in force are
  // the Host-wide ones, and the line must not claim otherwise.
  await publishSnapshot(pet, env, { ...base, following: 'unknown', scoped: true, counted: 0 })
  assert.equal(openMenuAndRead(), SCOPE_UNKNOWN)

  // No session reported at all.
  await publishSnapshot(pet, env, { ...base, following: 'host', scoped: false, counted: 3 })
  assert.equal(openMenuAndRead(), SCOPE_HOST)

  assert.equal(new Set([SCOPE_CURRENT, SCOPE_UNKNOWN, SCOPE_HOST]).size, 3, 'three distinct lines')
})

test('a snapshot from an older Host falls back to the Host-wide line', async (t) => {
  const { registrations, react, env } = registerPet(t)
  react.mount(probeRegistration(registrations).component, { sessionId: 'session-xyz' })
  const pet = mountPet(react, registrations)
  // No `following` field: the Host answered before scope reporting existed.
  await publishSnapshot(pet, env, { ok: true, state: 'idle', status: 'idle', busy: 0, turns: 1 })
  byClass(pet.tree, 'ons-sprite').props.onContextMenu({ preventDefault() {} })
  pet.render()
  assert.equal(byClass(pet.tree, 'ons-scope').children[0], SCOPE_HOST)
})

test('apply survives a Host with no shell.overlay seat', (t) => {
  const { plugin } = loadPlugin()
  assert.doesNotThrow(() => plugin.apply({
    slots: { inject() { throw new Error('no such slot') } },
    effect: () => () => {},
  }))
})

test('the first render is idle, bottom-right, and shows the idle pose', (t) => {
  const { registrations, react, env } = registerPet(t)
  const pet = mountPet(react, registrations)
  const root = byClass(pet.tree, 'ons-root')
  assert.ok(root, 'the companion root must render')
  assert.equal(root.props['data-mood'], 'idle')
  assert.equal(root.props['data-motion'], 'on')
  const sprite = byClass(pet.tree, 'ons-sprite')
  assert.equal(sprite.props.src, '/ostan-nanami-san-assets/idle.png?v=2')
  assert.equal(sprite.props.draggable, false)
  // Bottom-right default in a 1280x820 frame: left = 1280 - width - 26.
  assert.equal(root.props.style.width, '148px')
  assert.equal(root.props.style.left, `${1280 - 148 - 26}px`)
  assert.equal(env.document.body, undefined, 'the pet must never be appended to document.body')
})

test('a working snapshot switches the pose and shows the session badge', async (t) => {
  const { registrations, react, env } = registerPet(t)
  const pet = mountPet(react, registrations, env)
  await publishSnapshot(pet, env, { ok: true, state: 'work', status: 'working', busy: 3, turns: 1 })
  assert.equal(byClass(pet.tree, 'ons-root').props['data-mood'], 'work')
  assert.equal(byClass(pet.tree, 'ons-sprite').props.src, '/ostan-nanami-san-assets/work.png?v=2')
  assert.equal(byClass(pet.tree, 'ons-badge').children[0], '3')
})

test('each host status maps to its own pose', async () => {
  const cases = [
    [{ status: 'waiting', state: 'wait' }, 'wait', 'wait'],
    [{ status: 'error', state: 'wait' }, 'error', 'wait'],
    [{ status: 'done', state: 'cheer' }, 'cheer', 'cheer'],
    [{ status: 'idle', state: 'idle' }, 'idle', 'idle'],
    [{ status: 'cancelled', state: 'idle' }, 'idle', 'idle'],
  ]
  for (const [snapshot, mood, spriteState] of cases) {
    // A fresh harness per case, with the window installed only for that case:
    // `t.after` runs once for the whole test, so it cannot isolate iterations.
    const { registrations, react, env } = registerPet()
    const originalWindow = globalThis.window
    globalThis.window = env.window
    try {
      const pet = mountPet(react, registrations, env)
      env.window.__OSTAN_DEBUG = true
      env.window.fetch = (url) => {
        if (LOOP_TRACE) console.error(`[fetch] ${String(url)} -> status ${snapshot.status}`)
        return Promise.resolve({
          ok: true,
          json: () => {
            if (LOOP_TRACE) console.error(`[fetch] json() for ${snapshot.status}`)
            return Promise.resolve({ ok: true, busy: 0, turns: 4, ...snapshot })
          },
        })
      }
      await publishSnapshot(pet, env, { ok: true, busy: 0, turns: 4, ...snapshot })
      if (LOOP_TRACE) {
        console.error('[debug]', JSON.stringify(env.window.__OSTAN_DEBUG_LOG)?.slice(0, 200))
        console.error('[debug-error]', String(env.window.__OSTAN_DEBUG_ERROR).slice(0, 300)); console.error('[debug-turns]', env.window.__OSTAN_DEBUG_TURNS, JSON.stringify(env.window.__OSTAN_DEBUG_DEPS)); console.error('[debug-say]', env.window.__OSTAN_DEBUG_SAY)
      }
      const landed = pet.hooks.find((hook) => hook?.value && typeof hook.value === 'object' && 'busy' in hook.value)
      assert.equal(
        landed?.value?.status,
        snapshot.status,
        `the polled snapshot should carry status ${snapshot.status}`,
      )
      assert.equal(
        byClass(pet.tree, 'ons-root').props['data-mood'],
        mood,
        `status ${snapshot.status} should render mood ${mood}`,
      )
      assert.equal(
        byClass(pet.tree, 'ons-sprite').props.src,
        `/ostan-nanami-san-assets/${spriteState}.png?v=2`,
      )
    } finally {
      globalThis.window = originalWindow
    }
  }
})

test('an unreachable host keeps the idle pose instead of breaking', async (t) => {
  const { registrations, react, env } = registerPet(t)
  env.window.fetch = () => Promise.reject(new Error('offline'))
  const pet = mountPet(react, registrations, env)
  await new Promise((resolve) => setImmediate(resolve))
  pet.render()
  assert.equal(byClass(pet.tree, 'ons-root').props['data-mood'], 'idle')
  assert.equal(byClass(pet.tree, 'ons-sprite').props.src, '/ostan-nanami-san-assets/idle.png?v=2')
})

test('a pat click raises affinity and opens a speech bubble', (t) => {
  const { registrations, react, env } = registerPet(t)
  const pet = mountPet(react, registrations, env)
  assert.equal(storeOf(pet).points, 0)
  assert.equal(byClass(pet.tree, 'ons-bubble'), undefined)

  withWindowCapture(env, (listeners) => {
    pressSprite(pet, ELEMENT)
    assert.ok(listeners.has('pointerup'), 'the drag effect must listen on window')
    listeners.get('pointerup')({ clientX: 1000, clientY: 600 })
  })
  pet.render()
  assert.equal(storeOf(pet).points, 2, 'a pat is worth 2 affinity')
  assert.equal(storeOf(pet).pets, 1)
  const bubble = byClass(pet.tree, 'ons-bubble')
  assert.ok(bubble, 'the pet must say something when patted')
  assert.ok(typeof bubble.children[0] === 'string' && bubble.children[0].length > 0)
})

test('a drag moves the pet instead of patting it', (t) => {
  const { registrations, react, env } = registerPet(t)
  const pet = mountPet(react, registrations, env)
  withWindowCapture(env, (listeners) => {
    pressSprite(pet, ELEMENT)
    listeners.get('pointermove')({ clientX: 1100, clientY: 700 })
    listeners.get('pointerup')({ clientX: 1100, clientY: 700 })
  })
  pet.render()
  assert.equal(storeOf(pet).points, 0, 'a drag is not a pat')
  assert.equal(storeOf(pet).pets, 0)
  assert.ok(storeOf(pet).pos, 'a drag must persist a position')
})

test('the context menu offers a follow mode and manual mood overrides', (t) => {
  const { registrations, react } = registerPet(t)
  const pet = openMenu(mountPet(react, registrations))
  const labels = menuLabels(pet.tree)
  for (const expected of [LABEL.follow, LABEL.rest, LABEL.work, LABEL.wait, LABEL.cheer, LABEL.pat, LABEL.feed, LABEL.hide]) {
    assert.ok(labels.includes(expected), `menu is missing ${expected}: ${labels.join(', ')}`)
  }
  const follow = menuButtons(pet.tree).find((button) => button.children[0] === LABEL.follow)
  assert.equal(follow.props['data-on'], '1', 'follow mode is the default')
})

test('a manual override outranks the live snapshot', async (t) => {
  const { registrations, react, env } = registerPet(t)
  const pet = openMenu(mountPet(react, registrations, env))
  clickMenu(pet.tree, LABEL.cheer)
  pet.render()
  assert.equal(byClass(pet.tree, 'ons-root').props['data-mood'], 'cheer')
  assert.equal(byClass(pet.tree, 'ons-sprite').props.src, '/ostan-nanami-san-assets/cheer.png?v=2')
  await publishSnapshot(pet, env, { ok: true, state: 'idle', status: 'idle', busy: 0, turns: 9 })
  assert.equal(byClass(pet.tree, 'ons-root').props['data-mood'], 'cheer', 'manual mood must stick')
})

test('hiding leaves a summon button that brings her back', (t) => {
  const { registrations, react } = registerPet(t)
  const pet = openMenu(mountPet(react, registrations))
  clickMenu(pet.tree, LABEL.hide)
  pet.render()
  assert.equal(byClass(pet.tree, 'ons-root'), undefined)
  assert.equal(byClass(pet.tree, 'ons-sprite'), undefined)
  const summon = byClass(pet.tree, 'ons-summon')
  assert.ok(summon, 'a hidden pet must leave a way back')
  summon.props.onClick()
  pet.render()
  assert.ok(byClass(pet.tree, 'ons-root'))
  assert.equal(byClass(pet.tree, 'ons-sprite').props.src, '/ostan-nanami-san-assets/idle.png?v=2')
})

test('the size controls stay inside their bounds', (t) => {
  const { registrations, react } = registerPet(t)
  const pet = openMenu(mountPet(react, registrations))
  for (let i = 0; i < 20; i += 1) {
    clickMenu(pet.tree, LABEL.bigger)
    pet.render()
  }
  assert.equal(byClass(pet.tree, 'ons-root').props.style.width, '320px')
  for (let i = 0; i < 40; i += 1) {
    clickMenu(pet.tree, LABEL.smaller)
    pet.render()
  }
  assert.equal(byClass(pet.tree, 'ons-root').props.style.width, '84px')
})

test('feeding is worth more affinity than patting', (t) => {
  const { registrations, react } = registerPet(t)
  const pet = openMenu(mountPet(react, registrations))
  clickMenu(pet.tree, LABEL.feed)
  pet.render()
  assert.equal(storeOf(pet).points, 6)
  assert.equal(storeOf(pet).feeds, 1)
})

test('the store round-trips through localStorage', (t) => {
  const { registrations, react, env } = registerPet(t)
  const pet = openMenu(mountPet(react, registrations))
  clickMenu(pet.tree, LABEL.feed)
  pet.render()
  const raw = env.window.localStorage.getItem('ostan-nanami-san:v1')
  assert.ok(raw, 'the store must persist')
  const parsed = JSON.parse(raw)
  assert.equal(parsed.points, 6)
  assert.equal(parsed.visible, true)
})

test('unmounting disposes the effects the component registered', (t) => {
  const { registrations, react } = registerPet(t)
  const pet = mountPet(react, registrations)
  assert.ok(pet.hooks.length > 0)
  assert.doesNotThrow(() => pet.unmount())
})

test('polling starts even when the frame does not report itself visible', (t) => {
  // The regression this guards: `start()` was gated on
  // `document.visibilityState === 'visible'`, so a frame that never reported
  // visible never polled at all and the companion froze on its last snapshot —
  // only a click, which forced a re-render, made the stale read show up.
  const { registrations, react, env } = registerPet(t)
  const originalWindow = globalThis.window
  globalThis.window = env.window
  try {
    const fetched = []
    env.setVisibility('hidden')
    // Mount first: `mountPet` installs its own default stub, so the recording
    // stub must be installed after it or it records nothing.
    mountPet(react, registrations, env)
    env.window.fetch = (url) => {
      fetched.push(String(url))
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, state: 'idle', status: 'idle', busy: 0, turns: 0 }),
      })
    }
    assert.ok(env.intervals.size > 0, 'the poll interval must be open even while hidden')
    env.tickTimers()
    assert.ok(fetched.length > 0, 'the poll must run without any visibility event')
  } finally {
    globalThis.window = originalWindow
  }
})

test('a visibility event that never arrives cannot stall the poll', async (t) => {
  const { registrations, react, env } = registerPet(t)
  const originalWindow = globalThis.window
  globalThis.window = env.window
  try {
    let polls = 0
    const pet = mountPet(react, registrations, env)
    env.window.fetch = () => {
      polls += 1
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, state: 'work', status: 'working', busy: 1, turns: 0 }),
      })
    }
    // Claim visible WITHOUT ever firing visibilitychange: the watchdog is the
    // only thing that can notice the interval needs (re)opening.
    env.setVisibility('visible')
    const before = polls
    env.tickTimers()
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
    pet.render()
    assert.ok(polls > before, 'the watchdog must keep the poll alive')
    assert.equal(byClass(pet.tree, 'ons-root').props['data-mood'], 'work')
  } finally {
    globalThis.window = originalWindow
  }
})

test('switching session re-reads immediately, even while hidden', async (t) => {
  const { registrations, react, env } = registerPet(t)
  const originalWindow = globalThis.window
  globalThis.window = env.window
  try {
    const fetched = []
    const probe = react.mount(probeRegistration(registrations).component, { sessionId: 'one' })
    env.setVisibility('hidden')
    // Mount the companion first — it installs its own fetch stub — then swap in
    // the recording stub, then mount the probe carrying a NEW session id, which
    // is what the shell does when the user switches tabs.
    mountPet(react, registrations, env)
    env.window.fetch = (url) => {
      fetched.push(String(url))
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, state: 'idle', status: 'idle', busy: 0, turns: 0, following: 'session' }),
      })
    }
    const before = fetched.length
    react.mount(probeRegistration(registrations).component, { sessionId: 'two' })
    assert.ok(fetched.length > before, 'a session switch is worth one request regardless')
    assert.ok(
      fetched.slice(before).every((url) => url.includes('current=two')),
      `expected the new session to be ridden, got ${fetched.slice(before).join(', ')}`,
    )
  } finally {
    globalThis.window = originalWindow
  }
})

test('the boundary wraps the companion and stays a real element', (t) => {
  // The regression this guards: a component that threw during a later render
  // left the frame showing its last good picture while every effect kept
  // running, so the poll stayed alive and nothing ever moved again.
  const { registrations } = registerPet(t)
  const boundary = petRegistration(registrations).component({})
  assert.ok(boundary, 'the guard must render a boundary element')
  assert.equal(typeof boundary.type, 'function', 'the boundary is a real element type')
  assert.equal(boundary.props.failure, null, 'with no failure recorded yet')

  // THE invariant: the companion is handed over as an ELEMENT, never called.
  // `render() { return this.props.render() }` ran the companion's hooks outside
  // React's render context and threw #321 "Invalid hook call"; a harness that
  // does not enforce hook context cannot catch that, so this asserts the shape.
  const children = Array.isArray(boundary.children) ? boundary.children : []
  assert.equal(children.length, 1, 'the boundary wraps exactly one child')
  assert.equal(typeof children[0].type, 'function', 'the child is an element type')
  assert.deepEqual(children[0].props, {}, 'and it is an element, not the result of calling one')
})

test('the boundary shows a readable failure and offers a retry', (t) => {
  const { registrations } = registerPet(t)
  const boundary = petRegistration(registrations).component({})
  const instance = Object.create(boundary.type.prototype)
  instance.state = {}
  let retried = 0

  // A healthy render passes its children straight through.
  // React hands children through props; the element keeps them on its own field.
  instance.props = { ...boundary.props, children: boundary.children, onRetry: () => { retried += 1 } }
  assert.equal(instance.render(), boundary.children)

  // With a failure recorded, the boundary shows a visible, readable report.
  instance.props = {
    ...boundary.props,
    failure: 'TypeError: x is not a function\n    at foo',
    children: boundary.children,
    onError: () => {},
    onRetry: () => { retried += 1 },
  }
  const fallback = instance.render()
  assert.equal(fallback.props.className, 'ons-error')
  assert.ok(String(fallback.children[0].children[0]).includes('Nanami'), 'and says who broke')
  assert.match(String(fallback.children[1].children[0]), /TypeError/, 'and shows the reason')
  assert.match(String(fallback.children[2].children[0]), /Retry/, 'and offers a way back')

  // The retry clears the failure so the companion is rendered again.
  fallback.children[2].props.onClick()
  assert.equal(retried, 1)
})

test('hiding must not change the hook count between renders', async (t) => {
  // The regression this guards is React #321 ("Invalid hook call"): an early
  // `return` in the hidden branch sat ABOVE several hooks, so hiding her made
  // React see fewer hooks on the next render and the whole subtree died. It
  // only appeared after a hide, and a refresh cured it until the next hide.
  const { registrations, react, env } = registerPet(t)
  const pet = mountPet(react, registrations, env)
  const before = pet.hooks.length
  assert.ok(before > 0, 'the companion must use hooks at all')

  // Open the menu and press Hide.
  openMenu(pet)
  clickMenu(pet.tree, LABEL.hide)
  pet.render()
  assert.ok(byClass(pet.tree, 'ons-summon'), 'hiding leaves the summon button')
  assert.equal(
    pet.hooks.length,
    before,
    'the hidden render must consume exactly the same hooks as the visible one',
  )

  // And back again, still with a stable hook count.
  byClass(pet.tree, 'ons-summon').props.onClick()
  pet.render()
  assert.ok(byClass(pet.tree, 'ons-root'), 'the summon button brings her back')
  assert.equal(pet.hooks.length, before, 'un-hiding must not shift the hook order either')

  // The poll must survive the round trip, which is what actually froze before.
  const intervalsBefore = env.intervals.size
  await publishSnapshot(pet, env, { ok: true, state: 'work', status: 'working', busy: 1, turns: 3 })
  assert.equal(byClass(pet.tree, 'ons-root').props['data-mood'], 'work', 'she must still react after a hide')
  assert.equal(env.intervals.size, intervalsBefore, 'and the poll must still be open')
})

test('the frame language selects the dictionary', () => {
  const english = loadPlugin({ language: 'en-US' })
  const registrations = []
  english.plugin.apply({
    slots: {
      inject: (key, callback) => callback(),
      register: (options, component) => registrations.push({ options, component }),
    },
    effect: (fn) => { fn(); return () => {} },
  })
  const pet = openMenu(english.react.mount(
    componentFor(english.react, registrations.find((entry) => entry.options.name === 'shell.overlay')),
    {},
  ))
  const labels = menuLabels(pet.tree)
  assert.ok(labels.includes('Follow live status'), `expected English labels, got ${labels.join(', ')}`)
  assert.ok(!labels.includes(LABEL.follow), 'the Chinese dictionary must not leak into an English frame')
})

test('the status pill reports the running step, in the frame language', async (t) => {
  const { registrations, react, env } = registerPet(t)
  const pet = mountPet(react, registrations, env)
  await publishSnapshot(pet, env, {
    ok: true,
    state: 'work',
    status: 'working',
    busy: 1,
    turns: 4,
    work: {
      kind: 'tool',
      stale: false,
      since: 1,
      label: { key: 'grep', zh: '正在搜代码', en: 'searching the code', known: true },
    },
  })
  const pill = byClass(pet.tree, 'ons-work')
  assert.ok(pill, 'a running step must show the pill')
  assert.equal(pill.props['data-kind'], 'tool')
  assert.equal(pill.props['data-stale'], '0')
  assert.equal(pill.children[1].children[0], '正在搜代码…')

  // The same payload under an English frame renders the English half.
  const english = loadPlugin({ language: 'en-US' })
  const originalWindow = globalThis.window
  globalThis.window = english.env.window
  try {
    const registrationsEn = []
    english.plugin.apply({
      slots: {
        inject: (key, callback) => callback(),
        register: (options, component) => registrationsEn.push({ options, component }),
      },
      effect: (fn) => { fn(); return () => {} },
    })
    const petEn = english.react.mount(
      componentFor(english.react, registrationsEn.find((entry) => entry.options.name === 'shell.overlay')),
      {},
    )
    english.env.window.fetch = () => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        ok: true, state: 'work', status: 'working', busy: 1, turns: 4,
        work: { kind: 'tool', stale: false, since: 1, label: { key: 'grep', zh: '正在搜代码', en: 'searching the code', known: true } },
      }),
    })
    english.env.tickTimers()
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
    petEn.render()
    assert.equal(byClass(petEn.tree, 'ons-work').children[1].children[0], 'searching the code…')
  } finally {
    globalThis.window = originalWindow
  }
})

test('a pending question shows the waiting pill and the waiting face', async (t) => {
  const { registrations, react, env } = registerPet(t)
  const pet = mountPet(react, registrations, env)
  await publishSnapshot(pet, env, {
    ok: true,
    state: 'wait',
    status: 'waiting',
    busy: 1,
    awaiting: 1,
    turns: 4,
    work: {
      kind: 'question',
      stale: false,
      since: 1,
      label: { key: 'ask_user_question', zh: '正在等你回答', en: 'waiting for your answer', known: true },
    },
  })
  assert.equal(byClass(pet.tree, 'ons-root').props['data-mood'], 'wait')
  assert.equal(byClass(pet.tree, 'ons-sprite').props.src, '/ostan-nanami-san-assets/wait.png?v=2')
  const pill = byClass(pet.tree, 'ons-work')
  assert.ok(pill, 'a pending question must show the pill')
  assert.equal(pill.props['data-kind'], 'question')
  assert.equal(pill.children[1].children[0], '正在等你回答…')
})

test('the pill is absent with no step, and a stale step is not shown as live', async (t) => {
  const { registrations, react, env } = registerPet(t)
  const pet = mountPet(react, registrations, env)
  await publishSnapshot(pet, env, { ok: true, state: 'idle', status: 'idle', busy: 0, turns: 4, work: null })
  assert.equal(byClass(pet.tree, 'ons-work'), undefined)

  await publishSnapshot(pet, env, {
    ok: true,
    state: 'idle',
    status: 'idle',
    busy: 0,
    turns: 4,
    work: {
      kind: 'last-tool',
      stale: true,
      since: 1,
      label: { key: 'bash', zh: '正在跑命令', en: 'running a command', known: true },
    },
  })
  assert.equal(byClass(pet.tree, 'ons-work'), undefined, 'old history must not read as status')
})

test('a finished step rides along with the completion, then goes quiet', async (t) => {
  const { registrations, react, env } = registerPet(t)
  const pet = mountPet(react, registrations, env)
  await publishSnapshot(pet, env, {
    ok: true,
    state: 'cheer',
    status: 'done',
    busy: 0,
    turns: 5,
    work: {
      kind: 'last-tool',
      stale: false,
      since: 1,
      label: { key: 'edit', zh: '正在改代码', en: 'editing code', known: true },
    },
  })
  const pill = byClass(pet.tree, 'ons-work')
  assert.ok(pill, 'the last step is worth one beat after the turn lands')
  assert.equal(pill.props['data-kind'], 'last-tool')
  assert.equal(pill.children[1].children[0], '上一步：正在改代码')

  // Once the host calls it stale, the pill goes away.
  await publishSnapshot(pet, env, {
    ok: true,
    state: 'idle',
    status: 'idle',
    busy: 0,
    turns: 5,
    work: {
      kind: 'last-tool',
      stale: true,
      since: 1,
      label: { key: 'edit', zh: '正在改代码', en: 'editing code', known: true },
    },
  })
  assert.equal(byClass(pet.tree, 'ons-work'), undefined)
})
