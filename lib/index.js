/**
 * OStan Nanami-San — host half.
 *
 * Two responsibilities, both deliberately small:
 *
 *  1. Observe live turn boundaries (which session is working, whether the last
 *     turn ended well) and project them into ONE pet-state snapshot. No chat
 *     content, no history, no model calls.
 *  2. Serve that snapshot plus the packaged sprite artwork over same-origin
 *     `/api/ostan-nanami-san/*` and `/ostan-nanami-san-assets/*` routes.
 *
 * The pet keeps no ledger of its own: affinity/treats/display preferences live
 * in the browser (localStorage), so this file stays stateless apart from the
 * in-memory boundary projection.
 *
 * @module dsh-plugin-ostan-nanami-san
 */

import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'

/** Cordis plugin name (also the public service key). */
export const name = 'ostanNanamiSan'

/**
 * Host services this plugin needs. `agents` is what keeps the projection honest:
 * a pure event ledger drifts — a session that was already running before this
 * plugin mounted is never announced, and one missed `turn/end` pins a session at
 * "running" forever. The service is the authority, reconciled at mount and on
 * every status change.
 */
export const inject = ['webServer', 'agents']

/** Same-origin JSON API prefix consumed by the browser half. */
const API_PREFIX = '/api/ostan-nanami-san'
/** Immutable artwork prefix. */
const ASSET_PREFIX = '/ostan-nanami-san-assets'

/** Labels of the four packaged poses, in manifest order. */
export const SPRITE_STATES = ['idle', 'work', 'wait', 'cheer']

/** Reported by `/health`; keep in step with package.json. */
export const VERSION = '0.6.0'

/** How long a freshly finished turn counts as "just succeeded". */
const CELEBRATE_MS = 6000
/** How long a failed turn keeps the worried face up. */
const ERROR_MS = 20000
/** After this long, a remembered tool step is history rather than status. */
const WORK_STALE_MS = 90000
/** Minimum spacing between read-time reconciles with the live agent registry. */
const RECONCILE_MS = 1000

/**
 * What each known tool is doing, for the status line above the pet.
 *
 * `tool/call` carries `{ callId, name, arguments }` and nothing else, so this
 * map is the only place a tool's *meaning* can come from — deliberately: the
 * pet reports what kind of step is running, never what it contains. An unknown
 * tool falls back to its raw wire name, which is still honest and still safe.
 */
const TOOL_LABELS = {
  read: { zh: '正在读文件', en: 'reading a file' },
  write: { zh: '正在写文件', en: 'writing a file' },
  edit: { zh: '正在改代码', en: 'editing code' },
  glob: { zh: '正在找文件', en: 'finding files' },
  grep: { zh: '正在搜代码', en: 'searching the code' },
  bash: { zh: '正在跑命令', en: 'running a command' },
  pwsh: { zh: '正在跑命令', en: 'running a command' },
  web_search: { zh: '正在查资料', en: 'searching the web' },
  web_fetch: { zh: '正在读网页', en: 'reading a web page' },
  read_image: { zh: '正在看图', en: 'looking at an image' },
  todo_write: { zh: '正在列计划', en: 'planning the steps' },
  skill: { zh: '正在翻技能书', en: 'consulting a skill' },
  subagent: { zh: '正在派小助手', en: 'delegating to a helper' },
  workflow: { zh: '正在编排流程', en: 'orchestrating a workflow' },
  ask_user_question: { zh: '正在等你回答', en: 'waiting for your answer' },
  present: { zh: '正在交付文件', en: 'handing over files' },
  create_goal: { zh: '正在定目标', en: 'setting a goal' },
  update_goal: { zh: '正在更新目标', en: 'updating the goal' },
}
/** Turn ends with these reasons are user cancellations, not failures. */
const CANCELLED_REASONS = new Set(['cancelled', 'canceled', 'aborted', 'stopped', 'interrupted'])
/** Turn ends with these reasons are successful completions. */
const SUCCESS_REASONS = new Set(['completed', 'complete', 'success', 'succeeded', 'done'])
/** Bound on tracked sessions so a long-lived Host cannot grow this forever. */
const MAX_SESSIONS = 512

/** The tool whose open call means "the human must answer before this continues". */
const ASK_TOOL = 'ask_user_question'

/** One tracked session's live boundary bookkeeping. */
function blankSession() {
  return {
    running: false,
    cancelled: false,
    error: false,
    /** A published child (subagent) rather than a session the user drives. */
    subagent: false,
    lastTurnKey: undefined,
    /** Wall clock of this session's most recent turn or tool activity. */
    activeAt: 0,
    /** The tool call this session is inside right now, if any. */
    tool: null,
    /** The last tool this session finished, shown under a finished turn. */
    lastTool: null,
    /**
     * The call id of an open `ask_user_question`, or null. This is the real
     * "waiting for you" signal: the tool blocks the turn until an answer lands,
     * so the pairing of its call and result is durable log truth.
     */
    pendingQuestion: null,
  }
}

/** Human label for one tool name, or the raw name when it is not known. */
export function toolLabel(name) {
  if (typeof name !== 'string' || name === '') return null
  const label = TOOL_LABELS[name]
  if (label === undefined) return { key: name, zh: name, en: name, known: false }
  return { key: name, zh: label.zh, en: label.en, known: true }
}

/**
 * Describe what the user's own work is doing right now, or failing that what it
 * last did. Subagents are skipped for the same reason they do not drive the
 * mood: the user did not start them and does not watch them.
 *
 * @param sessions - the tracked session map.
 * @param now - current wall clock, used for the freshness bound.
 */
export function describeWork(sessions, now = Date.now(), only = null) {
  const inScope = (id) => only === null || id === only

  // One fresh pass, so an open question is reported as exactly that rather than
  // as "using ask_user_question": the step a human sees is "she needs you", not
  // the name of the tool that is blocking.
  let fresh = null
  let question = null
  for (const [id, session] of sessions) {
    if (!inScope(id)) continue
    if (session.subagent) continue
    if (session.pendingQuestion !== null && session.pendingQuestion !== undefined) {
      if (question === null || (session.activeAt ?? 0) > (question.activeAt ?? 0)) question = session
    } else if (session.tool !== null && session.tool !== undefined) {
      if (fresh === null || (session.activeAt ?? 0) > (fresh.activeAt ?? 0)) fresh = session
    }
  }
  if (question !== null) {
    const label = toolLabel(ASK_TOOL)
    if (label !== null) return { kind: 'question', label, since: question.activeAt ?? null, stale: false }
  }
  if (fresh !== null) {
    const label = toolLabel(fresh.tool.name)
    if (label !== null) return { kind: 'tool', label, since: fresh.activeAt ?? null, stale: false }
  }

  let last = null
  for (const [id, session] of sessions) {
    if (!inScope(id)) continue
    if (session.subagent) continue
    if (session.lastTool !== null && session.lastTool !== undefined) {
      if (last === null || (session.lastTool.at ?? 0) > (last.lastTool.at ?? 0)) last = session
    }
  }
  if (last === null) return null
  const label = toolLabel(last.lastTool.name)
  if (label === null) return null
  // A step from an old turn is history, not a status: let it go stale.
  const stale = now - (last.lastTool.at ?? 0) > WORK_STALE_MS
  return { kind: 'last-tool', label, since: last.lastTool.at ?? null, stale }
}

/**
 * Project live turn boundaries into the single state the pet renders.
 *
 * Every count answers "is the USER's work moving?", so subagents are excluded:
 * their turns are real work, but the user did not start them and does not see
 * them, so counting them makes the pet look busy while the visible session sits
 * idle. They stay tracked for diagnosis, just not counted.
 *
 * With `only`, the projection narrows to ONE session — the one the user is
 * actually looking at — which is what "follow the current tab" means. The
 * narrow read never falls back to global silently: an unknown or subagent id
 * projects an empty session set, so the caller can tell "that session is idle"
 * apart from "I could not find that session".
 */
export function projectState(sessions, now = Date.now(), only = null) {
  let running = 0
  let waiting = 0
  let subagents = 0
  let failedAt = 0
  let endedAt = 0
  let cancelled = 0
  let counted = 0

  for (const [id, session] of sessions) {
    if (only !== null && id !== only) continue
    if (session.subagent) {
      if (session.running) subagents += 1
      continue
    }
    counted += 1
    if (session.running) running += 1
    if (session.pendingQuestion !== null && session.pendingQuestion !== undefined) waiting += 1
    if (session.cancelled) cancelled += 1
    if (session.error) failedAt = Math.max(failedAt, session.errorAt ?? 0)
    if (session.endedAt) endedAt = Math.max(endedAt, session.endedAt)
  }

  // A live question outranks a running turn: a turn that is blocked on the user
  // has nothing to show, and she should say so instead of looking busy.
  const lastTurnAt = Math.max(failedAt, endedAt)
  let state = 'idle'
  let status = 'idle'
  if (waiting > 0) {
    state = 'wait'
    status = 'waiting'
  } else if (running > 0) {
    state = 'work'
    status = 'working'
  } else if (failedAt > 0 && now - failedAt < ERROR_MS) {
    state = 'wait'
    status = 'error'
  } else if (endedAt > 0 && now - endedAt < CELEBRATE_MS) {
    state = 'cheer'
    status = 'done'
  } else if (cancelled > 0) {
    status = 'cancelled'
  }

  return {
    state,
    status,
    busy: running,
    awaiting: waiting,
    subagents,
    sessions: sessions.size,
    counted,
    scoped: only !== null,
    lastTurnAt: lastTurnAt > 0 ? lastTurnAt : null,
    cancelled,
    observedAt: now,
  }
}

/**
 * Mutable live boundary projection. Fed by `session/event` and `agent/status`;
 * read by the HTTP route. Every mutation is defensive: an unexpected event
 * shape must never take the pet (or the Host) down.
 */
export class PetBoundaryTracker {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now
    this.sessions = new Map()
    this.turns = 0
    this.stateEvents = 0
  }

  /**
   * Latest snapshot for the browser half.
   * @param current - the session the shell reported, if any.
   * @param explicit - true when `current` came from a request rather than from
   *   a replay of the last known one, so an unknown id can be answered honestly
   *   instead of being read as "no scoping was requested".
   */
  snapshot(current = null, explicit = false) {
    const known = typeof current === 'string' && current !== '' && this.sessions.has(current)
    // An unknown session still narrows to nothing: "that session is idle" and
    // "the Host is busy elsewhere" are different answers, and the menu states
    // which scope is in force.
    const only = known ? current : (explicit ? current ?? '\u0000' : null)
    const now = this.now()
    const projection = projectState(this.sessions, now, only)
    const following = only === null ? 'host' : (projection.counted > 0 ? 'session' : 'unknown')
    return {
      ...projection,
      following,
      turns: this.turns,
      stateEvents: this.stateEvents,
      work: describeWork(this.sessions, now, only),
    }
  }

  session(id) {
    let session = this.sessions.get(id)
    if (session === undefined) {
      if (this.sessions.size >= MAX_SESSIONS) {
        const oldest = this.sessions.keys().next().value
        if (oldest !== undefined) this.sessions.delete(oldest)
      }
      session = blankSession()
      this.sessions.set(id, session)
    }
    return session
  }

  /** Fold one durable session event into the projection. */
  accept(sessionId, event) {
    if (typeof sessionId !== 'string' || sessionId === '' || event === null || typeof event !== 'object') return
    const type = event.type
    // The complete set this projection understands. `SessionEventMap` is the
    // authority: a type outside it is not a session event, and an earlier
    // version of this file invented `question/request` — which the Host never
    // emits — so the "waiting for you" face never appeared.
    if (type !== 'turn/start' && type !== 'turn/end' && type !== 'tool/call' && type !== 'tool/result') return
    // Turn boundaries carry their durable sequence; without it the event is not
    // a boundary this pet can trust (and must never be counted as one).
    if ((type === 'turn/start' || type === 'turn/end') && !(Number.isSafeInteger(event.seq) && event.seq >= 0)) return
    const tracked = this.session(sessionId)
    const at = this.now()

    if (type === 'tool/call') {
      // Only the tool's identity is kept. Its `arguments` are model output and
      // never enter this projection, let alone the browser.
      const name = event.data?.name
      const callId = event.data?.callId
      if (typeof name !== 'string' || name === '') return
      tracked.tool = { name, callId: typeof callId === 'string' ? callId : null }
      tracked.activeAt = at
      // The real "the human must answer" signal. `ask_user_question` blocks the
      // turn inside `ctx.userQuestions` until an answer lands, so an open call
      // of that name *is* a pending question — and its matching tool/result is
      // the answer. That pairing is durable log truth, which beats subscribing
      // to a live waterfall event the pet has no business joining.
      if (name === ASK_TOOL) tracked.pendingQuestion = tracked.tool.callId ?? 'open'
      return
    }

    if (type === 'tool/result') {
      const callId = event.data?.message?.toolCallId
      if (tracked.tool !== null && (callId === undefined || tracked.tool.callId === null || tracked.tool.callId === callId)) {
        tracked.lastTool = { name: tracked.tool.name, at: at, error: event.data?.error !== undefined }
        if (tracked.tool.name === ASK_TOOL) tracked.pendingQuestion = null
        tracked.tool = null
      }
      tracked.activeAt = at
      return
    }

    if (type === 'turn/start') {
      const key = `${sessionId}:${String(event.seq)}`
      if (tracked.lastTurnKey !== key) {
        tracked.lastTurnKey = key
        this.turns += 1
      }
      tracked.running = true
      tracked.activeAt = at
      tracked.error = false
      tracked.errorAt = undefined
      tracked.cancelled = false
      tracked.cancelledAt = undefined
      return
    }

    if (type === 'turn/end') {
      tracked.running = false
      // A turn that ends with a step still in flight (an abort, or a result the
      // log never recorded) retires that step rather than leaving it "running".
      if (tracked.tool !== null && tracked.tool !== undefined) {
        tracked.lastTool = { name: tracked.tool.name, at: at, error: false }
      }
      tracked.tool = null
      // Whatever the reason, a closed turn has no question outstanding.
      tracked.pendingQuestion = null
      tracked.activeAt = at
      const reason = event.data?.reason?.kind
      const kind = typeof reason === 'string' ? reason : 'unknown'
      if (kind === 'error' || kind === 'failed') {
        tracked.error = true
        tracked.errorAt = at
        tracked.cancelled = false
        tracked.cancelledAt = undefined
        tracked.endedAt = undefined
      } else if (CANCELLED_REASONS.has(kind)) {
        tracked.error = false
        tracked.errorAt = undefined
        tracked.cancelled = true
        tracked.cancelledAt = at
        tracked.endedAt = undefined
      } else if (SUCCESS_REASONS.has(kind)) {
        tracked.error = false
        tracked.errorAt = undefined
        tracked.cancelled = false
        tracked.cancelledAt = undefined
        tracked.endedAt = at
      } else {
        // An unrecognized reason is a plain stop: clear the "busy" face without
        // claiming a success the Host never reported.
        tracked.error = false
        tracked.errorAt = undefined
        tracked.cancelled = false
        tracked.cancelledAt = undefined
        tracked.endedAt = undefined
      }
      return
    }
  }

  /**
   * Fold one live status change (idle <-> running) into the projection.
   * @param sessionId - the session whose agent changed state.
   * @param running - the Host's own answer, which outranks any inference.
   * @param subagent - whether that session is a published child.
   */
  acceptStatus(sessionId, running, subagent) {
    if (typeof sessionId !== 'string' || sessionId === '') return
    const tracked = this.session(sessionId)
    tracked.running = running === true
    if (subagent !== undefined) tracked.subagent = subagent === true
    if (tracked.running) {
      tracked.activeAt = this.now()
      tracked.error = false
      tracked.errorAt = undefined
      tracked.cancelled = false
      tracked.cancelledAt = undefined
    }
  }

  /**
   * Reconcile the projection against the Host's live registry.
   *
   * This is the correction that a pure event ledger cannot make on its own:
   * every live agent is written down with the status the Host reports right
   * now, including agents that started before this plugin mounted. Agents the
   * Host no longer lists are dropped, so a session whose end event was missed
   * cannot stay "running" forever.
   *
   * @param agents - Host agent service (`ctx.agents`).
   * @returns how many live agents were seen.
   */
  reconcile(agents) {
    if (agents === undefined || agents === null || typeof agents.list !== 'function') return 0
    let live
    try {
      live = [...agents.list()]
    } catch {
      return 0
    }
    const roots = new Set()
    try {
      for (const root of agents.roots()) roots.add(root)
    } catch {
      // Without the root set every session counts as user-driven work, which is
      // the conservative answer: better busy than silently idle.
    }

    const seen = new Set()
    for (const agent of live) {
      const id = agent?.id
      if (typeof id !== 'string' || id === '') continue
      seen.add(id)
      const tracked = this.session(id)
      if (typeof agent.status === 'string') {
        tracked.running = agent.status === 'running'
        // An adopted session has no event history here, so its adoption time is
        // the best evidence of activity the projection will ever have.
        if (tracked.running && (tracked.activeAt ?? 0) === 0) tracked.activeAt = this.now()
      }
      if (roots.size > 0) tracked.subagent = !roots.has(agent)
    }
    for (const id of [...this.sessions.keys()]) {
      if (!seen.has(id)) this.sessions.delete(id)
    }
    return seen.size
  }

  /** Drop a session that left the live registry. */
  forget(sessionId) {
    if (typeof sessionId === 'string') this.sessions.delete(sessionId)
  }
}

/** Sprite filename allowlist: no caller-supplied path ever reaches the disk. */
const SPRITE_FILES = new Set(SPRITE_STATES.map(state => `${state}.png`))

/** Read one JSON request body with a hard cap; `undefined` means "no body". */
async function readJson(req, maxBytes = 8 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) throw new Error('body too large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text === '') return undefined
  return JSON.parse(text)
}

/** Write one JSON response. */
function json(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(payload)
}

/**
 * Register the pet's HTTP surface while the plugin is enabled.
 * @param ctx - Host plugin context (webServer is required).
 */
export function apply(ctx) {
  const tracker = new PetBoundaryTracker()
  const assetDir = new URL('../assets/', import.meta.url)
  const manifest = SPRITE_STATES.map(state => ({ state, file: `${state}.png` }))

  const agents = ctx.get('agents')
  let reconciledAt = 0
  /** Reconcile against the live registry, at most once per window. */
  const reconcile = (force = false) => {
    const now = tracker.now()
    if (!force && now - reconciledAt < RECONCILE_MS) return
    reconciledAt = now
    tracker.reconcile(agents)
  }

  ctx.inject(['webServer'], webCtx => {
    const server = webCtx.get('webServer')
    if (server === undefined || typeof server.register !== 'function') return

    webCtx.effect(() => server.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const route = url.pathname.slice(API_PREFIX.length) || '/'
        const method = req.method ?? 'GET'
        try {
          if (route === '/state' && (method === 'GET' || method === 'HEAD')) {
            // Read-time reconciliation: the page polls every 1.5 s, so any
            // boundary this ledger missed heals within one poll instead of
            // pinning the pet at "working" (or idle) until a restart.
            reconcile()
            // `current` is the session the user is looking at, as last reported
            // by the shell through a session-scoped slot. Narrowing to it is
            // what makes the pet follow the visible tab instead of the Host.
            //
            // An empty or whitespace value means "no session", not "a session
            // with no name": reading `?current=` as an explicit request would
            // report `unknown` for a client that simply had nothing to report.
            const raw = url.searchParams.get('current')
            const current = raw === null || raw.trim() === '' ? null : raw
            // `ids` exists for exactly one caller: a human debugging scope with
            // curl. It is opt-in and carries session identity only — never a
            // title, never message text — so the ordinary poll keeps its tiny
            // payload.
            const ids = url.searchParams.get('ids') === '1' ? [...tracker.sessions.keys()] : undefined
            json(res, 200, {
              ok: true,
              name: 'OStan Nanami-San',
              sprites: manifest,
              ...tracker.snapshot(current, current !== null),
              ...(ids === undefined ? {} : { ids }),
            })
            return
          }
          if (route === '/health' && (method === 'GET' || method === 'HEAD')) {
            json(res, 200, { ok: true, version: VERSION, sessions: tracker.sessions.size })
            return
          }
          if (route === '/interact' && method === 'POST') {
            const body = await readJson(req)
            const kind = body?.kind
            const action = kind === 'feed' || kind === 'pet' || kind === 'cheer' ? kind : 'pet'
            json(res, 200, { ok: true, action, at: tracker.now() })
            return
          }
          json(res, 404, { ok: false, error: 'unknown route' })
        } catch (error) {
          json(res, error?.message === 'body too large' ? 413 : 400, { ok: false, error: 'bad request' })
        }
      },
    }), 'ostan-nanami-san: pet api')

    webCtx.effect(() => server.register({
      kind: 'prefix',
      path: ASSET_PREFIX,
      handler: async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { Allow: 'GET, HEAD' }).end()
          return
        }
        const url = new URL(req.url ?? '/', 'http://localhost')
        const file = url.pathname.slice(ASSET_PREFIX.length + 1)
        if (!SPRITE_FILES.has(file)) {
          res.writeHead(404).end()
          return
        }
        let bytes
        try {
          bytes = await readFile(new URL(file, assetDir))
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error
          res.writeHead(404).end()
          return
        }
        // Revalidate on every use. `immutable` was a mistake here: the artwork
        // ships inside the package, so a corrected sprite must reach a browser
        // that already cached the old one. `no-cache` still allows a 304, so
        // repeat loads stay cheap, and the validator is the content hash —
        // never the filename, which does not change when a pose is redrawn.
        const etag = `"${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}"`
        const headers = {
          'content-type': 'image/png',
          'cache-control': 'no-cache, must-revalidate',
          'x-content-type-options': 'nosniff',
          ETag: etag,
        }
        const inm = req.headers['if-none-match']
        if (typeof inm === 'string' && inm.split(',').some(value => value.trim().replace(/^W\//, '') === etag || value.trim() === '*')) {
          res.writeHead(304, headers).end()
          return
        }
        res.writeHead(200, { ...headers, 'content-length': String(bytes.length) })
        res.end(req.method === 'HEAD' ? undefined : bytes)
      },
    }), 'ostan-nanami-san: sprite assets')
  })

  // Live boundaries. `global: true` sees every session on this Host, main or
  // child; the projection keeps only identity-free counters.
  ctx.on('session/event', (session, event) => {
    const id = session?.id
    if (typeof id === 'string') tracker.accept(id, event)
  }, { global: true })

  try {
    // The status event carries an Agent; its root membership is what separates
    // the user's own work from a published child's.
    ctx.on('api-session/status', (sessionId, running) => {
      const agent = typeof agents?.get === 'function' ? agents.get(sessionId) : undefined
      let subagent
      if (agent !== undefined && typeof agents?.roots === 'function') {
        try {
          subagent = !agents.roots().includes(agent)
        } catch {
          subagent = undefined
        }
      }
      tracker.acceptStatus(sessionId, running, subagent)
    }, { global: true })
    ctx.on('api-session/removed', sessionId => tracker.forget(sessionId), { global: true })
  } catch {
    // Older Hosts may not emit the registry events; session/event alone still
    // drives every pet state except sub-second idle detection.
  }

  // Reconcile at mount and on every config reload: a session that was already
  // running when this plugin mounted is otherwise invisible to the ledger.
  reconcile(true)
  ctx.on('app-boot/config-reload', () => reconcile(true), { global: true })

  const service = { snapshot: () => tracker.snapshot(), sprites: () => manifest, reconcile: () => reconcile(true) }
  ctx.provide(name, service)
}
