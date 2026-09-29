/**
 * OStan Nanami-San — browser half.
 *
 * Mounts one floating chibi companion into the DSH frame and drives it from the
 * host's same-origin `/api/ostan-nanami-san/state` snapshot. Affinity, treats,
 * size, position and visibility are browser-local (localStorage); the host only
 * reports live work boundaries.
 *
 * Module contract: `window.__ModuleLoader__.load({id, factory})`, with
 * `exports.apply` + `exports.inject`, React resolved from the loader table.
 *
 * @module dsh-plugin-ostan-nanami-san/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-ostan-nanami-san',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')

    const h = React.createElement

    //#region constants
    const API = '/api/ostan-nanami-san'
    const ASSETS = '/ostan-nanami-san-assets'
    /**
     * Sprite cache key. The asset route revalidates by content hash, but bump
     * this whenever a pose is redrawn: it changes the URL, which is the only
     * thing that reaches a browser holding an older copy under an old policy.
     */
    const ASSET_VERSION = '2'
    const POLL_MS = 1500
    /** How often the poll interval is reconciled against the document state. */
    const LIVENESS_MS = 5000
    const STORE_KEY = 'ostan-nanami-san:v1'
    const DRAG_THRESHOLD = 4
    const IDLE_LINE_MS = 150000
    const SLEEP_AFTER_MS = 180000
    const SIZE_MIN = 84
    const SIZE_MAX = 320
    const TURN_BUBBLE_MS = 6000
    const ACTION_BUBBLE_MS = 4200

    /** Affinity ladder: [threshold, title-zh, title-en]. */
    const LEVELS = [
      [0, '初次见面', 'Just met'],
      [20, '认识的人', 'Acquaintance'],
      [60, '熟人', 'Buddy'],
      [140, '朋友', 'Friend'],
      [300, '最好的朋友', 'Best friend'],
      [600, '命定之人', 'Fated one'],
    ]

    /** Sprite per rendered mood. */
    const MOODS = {
      idle: 'idle',
      work: 'work',
      wait: 'wait',
      cheer: 'cheer',
      sleep: 'idle',
      error: 'wait',
    }

    const COPY = {
      zh: {
        name: 'OStan Nanami-San',
        offline: '……信号不太好呢',
        status: { idle: '待机中', working: '干活中', waiting: '在等你', error: '出了点问题', done: '完成啦', cancelled: '已取消', sleep: '睡着了' },
        bubble: {
          idle: ['嗯？有事找我吗？', '我在这儿哦～', '今天也一起加油吧！', '（偷偷看你）', '要不要摸摸头？'],
          work: ['我在认真干活！', '交给我吧～', '嗯嗯，正在处理…', '不要打扰我哦～'],
          wait: ['……那个，需要你点一下。', '我在等你决定呢。', '唔…还没好吗？'],
          cheer: ['做完了！夸夸我～', '成功啦！', '耶！任务完成～'],
          error: ['唔…好像出错了。', '这次不太顺利呢…', '要不要看看日志？'],
          sleep: ['Zzz…', '（睡着了）', '……好困'],
        },
        pet: ['嘿嘿～', '好舒服…', '再摸摸嘛！', '唔…有点害羞'],
        feed: ['谢谢！我开动了～', '好吃！', '最喜欢这个了！', '呜…好幸福'],
        levelUp: (title) => `好感度提升！现在是「${title}」`,
        work: {
          /** Above the pet while a step is running. */
          now: (label) => `${label}…`,
          /** After the turn lands: the step it finished on. */
          last: (label) => `上一步：${label}`,
          /** A tool the host does not describe; its wire name is still honest. */
          unknown: (name) => `正在用 ${name}`,
        },
        menu: {
          title: 'OStan Nanami-San',
          affinity: '好感度',
          likes: (pets, feeds, treats) => `摸头 ${pets} · 投喂 ${feeds} · 零食 ${treats}`,
          follow: '跟随实际状态',
          force: '让奈奈酱…',
          forceIdle: '休息一下',
          forceWork: '去干活',
          forceWait: '等你',
          forceCheer: '开心一下',
          pet: '摸摸头',
          feed: '投喂',
          size: '大小',
          bigger: '大一点',
          smaller: '小一点',
          hide: '隐藏桌宠',
          reset: '恢复默认位置',
          hint: '左键拖动 · 单击摸头 · 右键菜单',
          scopeNow: '跟随：你正在看的会话',
          scopeHost: '跟随：整个 Host',
          scopeUnknown: '跟随：整个 Host（当前会话尚未被识别）',
          summon: '叫奈奈酱出来',
        },
      },
      en: {
        name: 'OStan Nanami-San',
        offline: '…connection looks shaky',
        status: { idle: 'idle', working: 'working', waiting: 'waiting for you', error: 'hit a problem', done: 'finished', cancelled: 'cancelled', sleep: 'asleep' },
        bubble: {
          idle: ['Hm? Need me?', "I'm right here~", "Let's work hard today!", '(peeking at you)', 'Pat my head?'],
          work: ["I'm on it!", 'Leave it to me~', 'Working, working…', "Don't distract me~"],
          wait: ['…it needs your click.', "I'm waiting on you.", 'Um… not yet?'],
          cheer: ['Done! Praise me~', 'It worked!', 'Yay! All finished~'],
          error: ['Uh oh… something broke.', 'That did not go well…', 'Should we check the logs?'],
          sleep: ['Zzz…', '(fast asleep)', '…so sleepy'],
        },
        pet: ['Hehe~', 'That feels nice…', 'Pat me again!', 'Um… a little shy'],
        feed: ["Thanks! Digging in~", 'Tasty!', 'My favourite!', 'Mmm… so happy'],
        levelUp: (title) => `Affinity up! Now “${title}”`,
        work: {
          now: (label) => `${label}…`,
          last: (label) => `Last step: ${label}`,
          unknown: (name) => `using ${name}`,
        },
        menu: {
          title: 'OStan Nanami-San',
          affinity: 'Affinity',
          likes: (pets, feeds, treats) => `${pets} pats · ${feeds} treats · ${treats} snacks`,
          follow: 'Follow live status',
          force: 'Make Nanami…',
          forceIdle: 'take a break',
          forceWork: 'go to work',
          forceWait: 'wait',
          forceCheer: 'cheer up',
          pet: 'Pat head',
          feed: 'Give a snack',
          size: 'Size',
          bigger: 'Bigger',
          smaller: 'Smaller',
          hide: 'Hide companion',
          reset: 'Reset position',
          hint: 'drag · click to pat · right-click for menu',
          scopeNow: 'Following: the session you are viewing',
          scopeHost: 'Following: the whole Host',
          scopeUnknown: 'Following: the whole Host (this session is not known to the Host yet)',
          summon: 'Call Nanami back',
        },
      },
    }

    /** Pick the dictionary that matches the frame language. */
    function pickCopy() {
      const lang = (document.documentElement.lang || navigator.language || 'zh').toLowerCase()
      return lang.startsWith('zh') ? COPY.zh : COPY.en
    }

    function randomLine(lines) {
      if (!Array.isArray(lines) || lines.length === 0) return ''
      return lines[Math.floor(Math.random() * lines.length)]
    }

    function levelOf(points) {
      let index = 0
      for (let i = 0; i < LEVELS.length; i += 1) {
        if (points >= LEVELS[i][0]) index = i
      }
      const [threshold, zh, en] = LEVELS[index]
      const next = LEVELS[index + 1]
      return {
        index,
        threshold,
        next: next ? next[0] : null,
        title: { zh, en },
      }
    }
    //#endregion

    //#region local store
    function defaultStore() {
      return {
        visible: true,
        size: 148,
        pos: null,
        points: 0,
        pets: 0,
        feeds: 0,
        treats: 0,
        lastPetAt: 0,
        lastFeedAt: 0,
        lastSeenAt: Date.now(),
        /**
         * Set when the user interacts with her: she stays awake until then.
         *
         * Sleeping and working are allowed to coexist by design — she naps
         * through a long run and the user wakes her by poking. This is what
         * makes that poke mean something, and it is the only thing that keeps
         * her from dozing off again immediately afterwards.
         */
        awakeUntil: 0,
      }
    }

    function loadStore() {
      try {
        const raw = window.localStorage.getItem(STORE_KEY)
        if (raw === null) return defaultStore()
        const parsed = JSON.parse(raw)
        if (parsed === null || typeof parsed !== 'object') return defaultStore()
        return { ...defaultStore(), ...parsed }
      } catch {
        return defaultStore()
      }
    }

    function saveStore(value) {
      try {
        window.localStorage.setItem(STORE_KEY, JSON.stringify(value))
      } catch {
        // A blocked storage quota must never break the pet.
      }
    }
    //#endregion

    //#region styles
    const CSS = `
.ons-root{position:fixed;z-index:2147482000;display:flex;flex-direction:column;align-items:center;
  font-family:"PingFang SC","Microsoft YaHei","Segoe UI",system-ui,-apple-system,sans-serif;
  color:#16305c;user-select:none;-webkit-user-select:none;pointer-events:none;}
.ons-root *{box-sizing:border-box;}
.ons-stage{position:relative;display:flex;flex-direction:column;align-items:flex-end;justify-content:center;
  cursor:grab;pointer-events:none;}
.ons-root.ons-dragging .ons-stage{cursor:grabbing;}
.ons-sprite{display:block;width:100%;height:auto;pointer-events:auto;touch-action:none;
  filter:drop-shadow(0 10px 14px rgba(20,48,92,.22));
  animation:ons-float 3.4s ease-in-out infinite;transform-origin:50% 92%;}
.ons-root[data-motion="off"] .ons-sprite{animation:none;}
.ons-root[data-mood="work"] .ons-sprite{animation-duration:1.25s;}
.ons-root[data-mood="cheer"] .ons-sprite{animation:ons-hop .32s ease-in-out 6;}
.ons-root[data-mood="sleep"] .ons-sprite{animation:ons-sleep 4.6s ease-in-out infinite;opacity:.92;}
.ons-root[data-mood="error"] .ons-sprite{animation:ons-worry 1.1s ease-in-out infinite;}
@keyframes ons-float{0%,100%{transform:translateY(0) rotate(-1.1deg)}50%{transform:translateY(-7px) rotate(1.1deg)}}
@keyframes ons-hop{0%,100%{transform:translateY(0) scale(1)}45%{transform:translateY(-16px) scale(1.045)}}
@keyframes ons-sleep{0%,100%{transform:translateY(2px) scale(.99)}50%{transform:translateY(-2px) scale(1.005)}}
@keyframes ons-worry{0%,100%{transform:rotate(-2.2deg)}50%{transform:rotate(2.2deg)}}
.ons-bubble{position:relative;max-width:186px;margin-bottom:6px;padding:9px 13px;border-radius:15px;
  background:rgba(255,255,255,.94);border:1.5px solid rgba(58,116,200,.5);color:#16305c;
  font-size:12.5px;line-height:1.5;text-align:center;box-shadow:0 8px 22px rgba(20,48,92,.18);
  backdrop-filter:blur(8px);animation:ons-pop .26s cubic-bezier(.34,1.56,.64,1);pointer-events:none;}
.ons-bubble::after{content:"";position:absolute;left:50%;bottom:-7px;width:11px;height:11px;margin-left:-5.5px;
  background:rgba(255,255,255,.94);border-right:1.5px solid rgba(58,116,200,.5);
  border-bottom:1.5px solid rgba(58,116,200,.5);transform:rotate(45deg);}
.ons-bubble[data-kind="cheer"]{border-color:#f0a63c;color:#8a5310;}
.ons-bubble[data-kind="error"]{border-color:#e5798f;color:#8d2740;}
.ons-bubble[data-kind="sleep"]{border-color:rgba(58,116,200,.3);color:#5c6f92;}
@keyframes ons-pop{from{opacity:0;transform:translateY(6px) scale(.9)}to{opacity:1;transform:none}}
.ons-badge{position:absolute;top:2px;right:-4px;min-width:20px;height:20px;padding:0 5px;border-radius:10px;
  background:linear-gradient(180deg,#4d8fe8,#2f6bc4);color:#fff;font-size:11px;font-weight:700;
  display:flex;align-items:center;justify-content:center;box-shadow:0 3px 9px rgba(47,107,196,.4);
  border:1.5px solid rgba(255,255,255,.85);pointer-events:none;}
/* The "what is she doing" status pill: a quiet, secondary line above the pet,
   visually distinct from the speech bubble so it never reads as her talking. */
.ons-work{display:flex;align-items:center;gap:6px;max-width:200px;margin-bottom:5px;padding:4px 10px;
  border-radius:999px;background:rgba(255,255,255,.88);border:1px solid rgba(58,116,200,.3);
  color:#3d5678;font-size:11px;line-height:1.35;white-space:nowrap;overflow:hidden;
  text-overflow:ellipsis;box-shadow:0 4px 12px rgba(20,48,92,.1);backdrop-filter:blur(8px);
  pointer-events:none;animation:ons-fade .24s ease-out;}
.ons-work[data-stale="1"]{opacity:.62;}
.ons-work .ons-dot{flex:none;width:6px;height:6px;border-radius:50%;background:#4d8fe8;
  animation:ons-pulse 1.15s ease-in-out infinite;}
.ons-work[data-kind="last-tool"] .ons-dot{background:#9fb4d0;animation:none;}
@keyframes ons-pulse{0%,100%{opacity:.35;transform:scale(.85)}50%{opacity:1;transform:scale(1.15)}}
@keyframes ons-fade{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion: reduce){.ons-work .ons-dot{animation:none;}}
.ons-summon{position:fixed;z-index:2147482000;width:44px;height:44px;border-radius:50%;border:1.5px solid rgba(58,116,200,.55);
  background:rgba(255,255,255,.92);color:#2f6bc4;font-size:20px;cursor:pointer;display:flex;align-items:center;
  justify-content:center;box-shadow:0 8px 20px rgba(20,48,92,.2);backdrop-filter:blur(8px);transition:transform .16s;}
.ons-summon:hover{transform:scale(1.08);}
.ons-menu{position:fixed;z-index:2147482001;width:216px;padding:10px;border-radius:15px;pointer-events:auto;
  background:rgba(252,253,255,.97);border:1.5px solid rgba(58,116,200,.35);
  box-shadow:0 18px 44px rgba(20,48,92,.26);backdrop-filter:blur(14px) saturate(160%);
  font-size:12.5px;animation:ons-pop .18s ease-out;}
.ons-menu h4{margin:0 0 2px;font-size:13px;color:#1b3d75;letter-spacing:.2px;}
.ons-menu .ons-sub{color:#6b7f9e;font-size:11px;margin-bottom:7px;}
.ons-bar{height:7px;border-radius:4px;background:rgba(58,116,200,.16);overflow:hidden;margin:5px 0 3px;}
.ons-bar span{display:block;height:100%;border-radius:4px;background:linear-gradient(90deg,#7fb8f5,#2f6bc4);transition:width .32s;}
.ons-row{display:flex;gap:6px;flex-wrap:wrap;margin-top:5px;}
.ons-menu button{flex:1 1 auto;min-width:60px;padding:6px 8px;border-radius:9px;cursor:pointer;
  border:1px solid rgba(58,116,200,.3);background:rgba(255,255,255,.9);color:#1b3d75;
  font-size:12px;font-family:inherit;transition:all .14s;}
.ons-menu button:hover{background:rgba(77,143,232,.14);border-color:rgba(58,116,200,.6);}
.ons-menu button[data-on="1"]{background:linear-gradient(180deg,#4d8fe8,#2f6bc4);color:#fff;border-color:transparent;}
.ons-menu .ons-label{margin-top:8px;color:#6b7f9e;font-size:11px;}
.ons-scope{margin-top:8px;padding:5px 8px;border-radius:8px;background:rgba(77,143,232,.1);
  color:#3d5678;font-size:11px;line-height:1.4;}
.ons-hint{margin-top:7px;color:#8a9ab5;font-size:10.5px;line-height:1.45;}
.ons-note{margin-top:6px;padding:5px 7px;border-radius:8px;background:rgba(229,121,143,.12);color:#8d2740;font-size:11px;}
/* A visible failure report: never larger than it needs to be, never silent. */
.ons-error{position:fixed;right:20px;bottom:20px;z-index:2147482002;max-width:300px;padding:8px 12px;
  border-radius:12px;background:rgba(255,244,246,.97);border:1.5px solid #e5798f;color:#8d2740;
  font-size:12px;line-height:1.45;box-shadow:0 10px 26px rgba(141,39,64,.22);pointer-events:auto;}
.ons-error-detail{margin-top:5px;padding-top:5px;border-top:1px solid rgba(229,121,143,.35);
  font-family:ui-monospace,Consolas,monospace;font-size:10.5px;white-space:pre-wrap;word-break:break-word;}
.ons-error-retry{margin-top:7px;width:100%;padding:5px 8px;border-radius:8px;cursor:pointer;
  border:1px solid rgba(229,121,143,.5);background:rgba(255,255,255,.9);color:#8d2740;
  font:inherit;font-size:11.5px;}
.ons-error-retry:hover{background:#fff;border-color:#e5798f;}
@media (prefers-reduced-motion: reduce){.ons-sprite{animation:none !important;}}
`

    const STYLE_ID = 'ostan-nanami-san/styles'
    function ensureStyles() {
      if (typeof document === 'undefined') return
      if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) !== null) return
      const tag = document.createElement('style')
      tag.dataset.plugin = 'ostan-nanami-san'
      tag.dataset.pluginCss = STYLE_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
    }
    //#endregion

    //#region session scope
    /**
     * The session the user is currently looking at.
     *
     * The frame reports it through a session-scoped slot, whose standard props
     * carry `sessionId`; the probe below writes it here and nudges the poller.
     * This client face has no `sessions.list` to read it from, and scraping the
     * DOM for a session marker would be both fragile and forbidden.
     */
    const scope = { sessionId: null, onChange: null, seen: false }

    /**
     * Live counters, surfaced in the context menu.
     *
     * They exist because a freeze report is otherwise unanswerable from the
     * outside: "she stopped reacting" can mean the poll died, the request
     * failed, the response arrived but the render did not happen, or a render
     * threw. These four numbers separate those cases at a glance, and they cost
     * three integer increments per cycle.
     */
    const stats = { polls: 0, applied: 0, renders: 0, failures: 0, lastError: null }

    /**
     * Keeps one failing render from freezing the whole companion.
     *
     * The slot renderer already reports an entry error and may abdicate the
     * entry, but a boundary that stays mounted is the difference between "she
     * shows a small error line and keeps updating" and "the frame keeps the
     * last good picture forever while the poll runs invisibly".
     */
    function guarded(Component) {
      return function Guarded() {
        const [failure, setFailure] = React.useState(null)
        return h(
          ErrorCatch,
          {
            failure,
            onError: (message) => {
              stats.failures += 1
              stats.lastError = message
              setFailure(message)
            },
            onRetry: () => setFailure(null),
          },
          // An ELEMENT, never a call. Calling the component here would run its
          // hooks outside React's render context, which is precisely "Invalid
          // hook call" (#321) — and it is the one mistake a hand-rolled test
          // harness cannot detect, because the harness does not enforce hook
          // context. The wrapper above is exercised in the harness by rendering
          // its children directly instead.
          h(Component, null),
        )
      }
    }

    /**
     * Catches a child's render failure and shows it, instead of React unmounting
     * the subtree and leaving the frame with a frozen picture.
     */
    class ErrorCatch extends React.Component {
      constructor(props) {
        super(props)
        this.state = {}
      }

      static getDerivedStateFromError() {
        return {}
      }

      componentDidCatch(error) {
        this.props.onError(String(error?.stack ?? error?.message ?? error))
      }

      render() {
        if (this.props.failure !== null && this.props.failure !== undefined) {
          // The message is rendered, not just a title attribute: a failure the
          // user cannot read is a failure nobody can report.
          return h(
            'div',
            { className: 'ons-error', title: this.props.failure },
            h('div', null, '⚠ 奈奈酱出错了 · Nanami hit an error'),
            h('div', { className: 'ons-error-detail' }, String(this.props.failure).slice(0, 300)),
            h(
              'button',
              { type: 'button', className: 'ons-error-retry', onClick: () => this.props.onRetry() },
              '重试 · Retry',
            ),
          )
        }
        return this.props.children
      }
    }

    /**
     * Zero-pixel session probe: renders nothing, reports which session is
     * mounted. Its only job is to hand `sessionId` to the floating companion,
     * which lives in a root-scoped slot and cannot receive it directly.
     */
    function SessionProbe(props) {
      const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : null
      scope.seen = true
      scope.sessionId = sessionId
      React.useEffect(() => {
        if (scope.onChange !== null) scope.onChange()
      }, [sessionId])
      return null
    }
    //#endregion

    //#region component
    function useStore() {
      const [store, setStore] = React.useState(loadStore)
      const update = React.useCallback((patch) => {
        setStore((previous) => {
          const next = typeof patch === 'function' ? patch(previous) : { ...previous, ...patch }
          saveStore(next)
          return next
        })
      }, [])
      return [store, update]
    }

    /** One floating companion: host snapshot in, pixels and interactions out. */
    function NanamiPet() {
      const [copy, setCopy] = React.useState(pickCopy)
      const [store, updateStore] = useStore()
      const [snapshot, setSnapshot] = React.useState(null)
      const [forced, setForced] = React.useState('follow')
      const [bubble, setBubble] = React.useState(null)
      const [menuOpen, setMenuOpen] = React.useState(false)
      const [motion, setMotion] = React.useState(true)
      const [dragging, setDragging] = React.useState(false)
      const [viewport, setViewport] = React.useState(() => ({ w: window.innerWidth, h: window.innerHeight }))
      const [, forceRerender] = React.useState(0)

      const drag = React.useRef(null)
      const bubbleTimer = React.useRef(undefined)
      const menuRef = React.useRef(null)
      const lastLevel = React.useRef(levelOf(store.points).index)

      const level = levelOf(store.points)
      const title = copy === COPY.zh ? level.title.zh : level.title.en
      stats.renders += 1

      /** Publish one transient speech bubble. */
      const say = React.useCallback((text, kind = 'idle', ttl = ACTION_BUBBLE_MS) => {
        if (text === '' || text === undefined) return
        if (bubbleTimer.current !== undefined) window.clearTimeout(bubbleTimer.current)
        setBubble({ text, kind })
        bubbleTimer.current = window.setTimeout(() => setBubble(null), ttl)
      }, [])

      // Language can change under a running frame; re-read it on theme/lang churn.
      React.useEffect(() => {
        const observer = new MutationObserver(() => setCopy(pickCopy()))
        try {
          observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
        } catch {
          // Observing is best-effort; the initial dictionary still works.
        }
        return () => observer.disconnect()
      }, [])

      // Viewport tracking keeps the pet inside the frame when the window resizes.
      React.useEffect(() => {
        const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight })
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
      }, [])

      // Host snapshot polling: only while the tab is visible.
      React.useEffect(() => {
        let alive = true
        let timer
        let sequence = 0
        const tick = () => {
          const seq = sequence + 1
          sequence = seq
          stats.polls += 1
          // Ride the session the user is looking at, so the Host narrows every
          // read to the visible tab instead of reporting the whole Host.
          const current = scope.sessionId
          const url = current === null
            ? `${API}/state`
            : `${API}/state?current=${encodeURIComponent(current)}`
          // Read through `window` rather than the ambient global so the whole
          // transport stays injectable (and stubbable) in a harness.
          window.fetch(url, { headers: { accept: 'application/json' } })
            .then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
            .then((data) => {
              if (!alive || seq !== sequence) return
              stats.applied += 1
              setSnapshot(data)
            })
            .catch(() => {
              if (!alive || seq !== sequence) return
              stats.failures += 1
              setSnapshot({ ok: false, state: 'idle', status: 'offline' })
            })
        }
        const start = () => {
          if (timer !== undefined) return
          tick()
          timer = window.setInterval(tick, POLL_MS)
        }
        const stop = () => {
          if (timer === undefined) return
          window.clearInterval(timer)
          timer = undefined
        }
        const onVisibility = () => {
          if (document.visibilityState === 'visible') start()
          else stop()
        }
        // Switching the visible session must re-read immediately rather than at
        // the next tick: the probe fires this on every session change. It is
        // deliberately NOT gated on visibility — a session switch is worth one
        // request even if the frame currently reports itself hidden, and gating
        // it here once made a switch wait out a whole poll cycle.
        scope.onChange = () => { tick() }
        // Reconcile the interval with the document's own state every 5 s.
        //
        // This exists because relying on `visibilitychange` alone once left the
        // companion frozen: an interval that was never started (a frame that
        // did not report `visible` at mount) has no event to rescue it, so the
        // pet kept rendering the last snapshot it had and only a click — which
        // forced a re-render — made the stale read visible. A watchdog cannot
        // get stuck that way, and it costs one wasted call every 5 s at worst.
        const watchdog = window.setInterval(() => {
          if (typeof document.visibilityState === 'string' && document.visibilityState !== 'visible') {
            // The document says hidden but a timer is still open (the browser
            // throttles it anyway): drop it and wait for a real wake-up.
            if (document.visibilityState === 'hidden') stop()
            return
          }
          start()
        }, LIVENESS_MS)
        start()
        document.addEventListener('visibilitychange', onVisibility)
        return () => {
          alive = false
          scope.onChange = null
          stop()
          window.clearInterval(watchdog)
          document.removeEventListener('visibilitychange', onVisibility)
        }
      }, [])

      // Turn completion → one line per finished turn. The watermark is the
      // host's own turn counter, so this fires exactly once per new turn even
      // across a page reload, and `say` replaces any line still on screen.
      const turns = snapshot?.turns ?? 0
      const status = snapshot?.status ?? 'idle'
      React.useEffect(() => {
        if (turns <= 0) return
        if (status === 'done') say(randomLine(copy.bubble.cheer), 'cheer', TURN_BUBBLE_MS)
        else if (status === 'error') say(randomLine(copy.bubble.error), 'error', TURN_BUBBLE_MS)
      }, [turns, status, copy, say])

      // Affinity level-ups announce themselves.
      React.useEffect(() => {
        const current = levelOf(store.points).index
        if (current > lastLevel.current) say(copy.levelUp(title), 'cheer')
        lastLevel.current = current
      }, [store.points, copy, title, say])

      // Keep the newest store value reachable from timers and the window-level
      // drag handlers without making them depend on every store change.
      const storeRef = React.useRef(store)
      storeRef.current = store
      /** Whether the previous render was already showing the waiting face. */
      const wasWaitingRef = React.useRef(false)

      /**
       * A question wakes her for real, not just for the moment it is open.
       *
       * The human is being asked to act, so she should be up and stay up
       * afterwards rather than dropping straight back to sleep once they answer.
       * This lives in an effect, never in the render body: writing to the store
       * while rendering schedules another render, and that second render fires
       * another poll — a side effect that does not belong in a render at all.
       */
      React.useEffect(() => {
        const waiting = status === 'waiting'
        if (waiting && !wasWaitingRef.current) {
          const now = Date.now()
          updateStore({ lastSeenAt: now, awakeUntil: now + SLEEP_AFTER_MS })
        }
        wasWaitingRef.current = waiting
      }, [status, updateStore])

      // Idle chatter / sleep bookkeeping. The interval runs often enough to
      // notice a long quiet stretch without polling the clock hard. It stays
      // silent while the Host is busy: muttering "Zzz…" in the middle of a turn
      // contradicts the pose she is wearing.
      React.useEffect(() => {
        const timer = window.setInterval(() => {
          const current = storeRef.current
          if (Date.now() - current.lastSeenAt < IDLE_LINE_MS) return
          if ((current.awakeUntil ?? 0) > Date.now()) return
          if (!current.visible) return
          say(randomLine(copy.bubble.sleep), 'sleep')
        }, 30000)
        return () => window.clearInterval(timer)
      }, [copy, say])

      /** Click-to-pat, with the pleasant-feeling cooldown the whale pet uses. */
      const petOnce = React.useCallback(() => {
        const now = Date.now()
        const current = storeRef.current
        const fresh = now - current.lastPetAt > 800
        updateStore({
          points: fresh ? current.points + 2 : current.points,
          pets: current.pets + 1,
          lastPetAt: now,
          lastSeenAt: now,
          // Poking her is how the user says "I am here": she stays awake past
          // the nap threshold instead of dozing off again on the next tick.
          awakeUntil: now + SLEEP_AFTER_MS,
        })
        say(randomLine(copy.pet), 'idle')
      }, [copy, say, updateStore])

      // Drag anywhere on the sprite; a sub-threshold gesture counts as a click.
      React.useEffect(() => {
        const onMove = (event) => {
          const state = drag.current
          if (state === null) return
          const dx = event.clientX - state.x
          const dy = event.clientY - state.y
          if (!state.moved && Math.abs(dx) + Math.abs(dy) > DRAG_THRESHOLD) {
            state.moved = true
            setDragging(true)
          }
          if (!state.moved) return
          state.last = { x: event.clientX, y: event.clientY }
          forceRerender((value) => value + 1)
        }
        const onUp = () => {
          const state = drag.current
          if (state === null) return
          drag.current = null
          setDragging(false)
          if (state.moved && state.last !== null) {
            const rect = state.element.getBoundingClientRect()
            const width = rect.width
            const height = rect.height
            const left = Math.min(Math.max(state.last.x - state.offsetX, 4), window.innerWidth - width - 4)
            const top = Math.min(Math.max(state.last.y - state.offsetY, 4), window.innerHeight - height - 4)
            updateStore({ pos: { left, top } })
          } else {
            petOnce()
          }
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
        window.addEventListener('pointercancel', onUp)
        return () => {
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          window.removeEventListener('pointercancel', onUp)
        }
      }, [updateStore])

      // Dismiss the context menu on any outside click.
      React.useEffect(() => {
        if (!menuOpen) return
        const onDown = (event) => {
          if (menuRef.current !== null && menuRef.current.contains(event.target)) return
          setMenuOpen(false)
        }
        window.addEventListener('pointerdown', onDown, true)
        return () => window.removeEventListener('pointerdown', onDown, true)
      }, [menuOpen])

      React.useEffect(() => () => {
        if (bubbleTimer.current !== undefined) window.clearTimeout(bubbleTimer.current)
      }, [])

      /** Feed from the context menu: a bigger, rarer affinity bump. */
      const feed = React.useCallback(() => {
        const current = storeRef.current
        const now = Date.now()
        const eaten = now - current.lastFeedAt > 1500
        updateStore({
          points: eaten ? current.points + 6 : current.points,
          feeds: current.feeds + 1,
          lastFeedAt: now,
          lastSeenAt: now,
          awakeUntil: now + SLEEP_AFTER_MS,
        })
        say(randomLine(copy.feed), 'cheer')
        setMenuOpen(false)
      }, [copy, say, updateStore])

      const pokeHost = React.useCallback((kind) => {
        window.fetch(`${API}/interact`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ kind }),
        }).catch(() => {
          // The host endpoint is a courtesy echo; the pet never blocks on it.
        })
      }, [])

      const onPointerDown = React.useCallback((event) => {
        if (event.button !== 0) return
        const element = event.currentTarget.closest('.ons-root')
        if (element === null) return
        const rect = element.getBoundingClientRect()
        drag.current = {
          x: event.clientX,
          y: event.clientY,
          offsetX: event.clientX - rect.left,
          offsetY: event.clientY - rect.top,
          element,
          moved: false,
          last: null,
        }
      }, [])

      const onContextMenu = React.useCallback((event) => {
        event.preventDefault()
        setMenuOpen(true)
      }, [])

      const setSize = (delta) => {
        updateStore({ size: Math.min(SIZE_MAX, Math.max(SIZE_MIN, storeRef.current.size + delta)) })
      }

      // Effective mood, in strict priority order.
      //
      // A manual override always wins. Then the two things that MUST be visible:
      // a question waiting on the human outranks everything (including sleep and
      // a manual mood — a pending question the user cannot see is the one
      // failure this pet cannot afford), and a failure is worth showing too.
      //
      // Sleeping is otherwise allowed to coexist with work: a long run does not
      // force her awake, and the user wakes her by interacting. `awakeUntil` is
      // that interaction's echo, and `idleFor` is time since the user last
      // touched her rather than time since the Host last did anything.
      const idleFor = Date.now() - store.lastSeenAt
      const awake = (store.awakeUntil ?? 0) > Date.now() || idleFor <= SLEEP_AFTER_MS
      const statusMood = {
        working: 'work',
        waiting: 'wait',
        error: 'error',
        done: 'cheer',
      }
      let mood
      if (status === 'waiting') mood = 'wait'
      else if (forced !== 'follow') mood = forced
      else if (snapshot === null || snapshot.ok === false) mood = 'idle'
      else if (!awake) mood = 'sleep'
      else mood = statusMood[status] ?? 'idle'

      // Position: user drag wins, then the frame's bottom-right, clamped. The
      // sprite keeps its own aspect ratio (`height:auto`), and the four poses
      // crop to slightly different widths, so the reserved box uses the tallest
      // pose's ratio — the point is to keep the pet inside the frame, not to
      // predict the exact painted height.
      const width = store.size
      const height = Math.round(width * 2.6)
      const dragPos = drag.current !== null && drag.current.last !== null
        ? {
            left: Math.min(Math.max(drag.current.last.x - drag.current.offsetX, 0), viewport.w - width),
            top: Math.min(Math.max(drag.current.last.y - drag.current.offsetY, 0), viewport.h - height),
          }
        : null
      const saved = store.pos
      const fallback = { left: viewport.w - width - 26, top: viewport.h - height - 24 }
      const base = dragPos ?? (saved !== null && saved !== undefined ? saved : fallback)
      const position = {
        left: Math.min(Math.max(base.left, 4), Math.max(4, viewport.w - width - 4)),
        top: Math.min(Math.max(base.top, 4), Math.max(4, viewport.h - height - 4)),
      }
      const statusLabel = copy.status[snapshot?.status] ?? copy.status[mood] ?? copy.status.idle
      const work = snapshot?.work ?? null

      // Host-side step description, rendered in the frame's language. The Host
      // sends both dictionaries so the pill never needs a second round trip.
      const workLabel = work === null ? '' : (copy === COPY.zh ? work.label.zh : work.label.en)
      const workKind = work === null ? 'none' : work.kind
      const workStale = work?.stale === true
      const workText = work === null
        ? null
        : workLabel === ''
          ? null
          : work.kind === 'last-tool'
            ? copy.work.last(workLabel)
            : copy.work.now(workLabel)
      // A finished-turn step is only worth showing while the completion is still
      // fresh; a stale one would read as "she is doing that right now". A live
      // step or an open question is always worth showing, whatever the mood.
      const showWork = workText !== null && workStale !== true
        && (work.kind === 'tool' || work.kind === 'question' || status === 'done' || status === 'working')

      // NOTE: everything below this line runs on EVERY render, including the
      // hidden state. An early `return` above any hook is an "Invalid hook
      // call" (React #321): hiding the companion would skip the later hooks,
      // React would see a different hook count on the next render, and the
      // whole subtree would die. The hidden branch is therefore a *value*
      // choice at the very end, not an exit.

      // The root is transparent to pointer events (so it can never swallow a
      // click meant for the app); the sprite opts back in and owns both
      // gestures, which is why the context-menu handler lives here too.
      const sprite = h('img', {
        className: 'ons-sprite',
        src: `${ASSETS}/${MOODS[mood] ?? 'idle'}.png?v=${ASSET_VERSION}`,
        alt: copy.name,
        draggable: false,
        onPointerDown,
        onContextMenu,
      })

      const bubbleNode = bubble === null
        ? null
        : h('div', { className: 'ons-bubble', 'data-kind': bubble.kind }, bubble.text)

      const badge = (snapshot?.busy ?? 0) > 0
        ? h('div', { className: 'ons-badge', title: statusLabel }, String(snapshot.busy))
        : null

      // The status pill: what step the Host says her work is on. Shown while a
      // step runs, and for a beat after a turn lands so the last step is not
      // lost. It reports the *kind* of step only — never its contents, and
      // never a word of the conversation.
      const workNode = workText === null || !showWork
        ? null
        : h(
            'div',
            { className: 'ons-work', 'data-kind': workKind, 'data-stale': workStale ? '1' : '0', title: workText },
            h('span', { className: 'ons-dot' }),
            h('span', null, workText),
          )

      // Park the menu beside the upper half of the sprite, clamped to the frame.
      const spriteHeight = Math.round(width * 2.33)
      const menuTop = Math.min(
        Math.max(position.top + Math.round(spriteHeight * 0.42), 8),
        Math.max(8, viewport.h - 344),
      )
      const menu = menuOpen
        ? h(
            'div',
            {
              ref: menuRef,
              className: 'ons-menu',
              style: {
                left: `${Math.min(position.left, Math.max(8, viewport.w - 232))}px`,
                top: `${menuTop}px`,
              },
            },
            h('h4', null, copy.menu.title),
            h('div', { className: 'ons-sub' }, `${statusLabel} · ${title} · ${store.points}`),
            h('div', { className: 'ons-bar' }, h('span', { style: { width: `${barPercent(level, store.points)}%` } })),
            h('div', { className: 'ons-sub' }, copy.menu.likes(store.pets, store.feeds, store.treats)),
            h(
              'div',
              { className: 'ons-row' },
              h('button', { type: 'button', onClick: petOnce }, copy.menu.pet),
              h('button', { type: 'button', onClick: feed }, copy.menu.feed),
            ),
            h(
              'div',
              { className: 'ons-label' },
              copy.menu.force,
            ),
            h(
              'div',
              { className: 'ons-row' },
              ...[
                ['follow', copy.menu.follow],
                ['idle', copy.menu.forceIdle],
                ['work', copy.menu.forceWork],
                ['wait', copy.menu.forceWait],
                ['cheer', copy.menu.forceCheer],
              ].map(([key, label]) =>
                h(
                  'button',
                  {
                    key,
                    type: 'button',
                    'data-on': forced === key ? '1' : '0',
                    onClick: () => {
                      setForced(key)
                      setMenuOpen(false)
                    },
                  },
                  label,
                ),
              ),
            ),
            h('div', { className: 'ons-label' }, `${copy.menu.size} · ${store.size}px`),
            h(
              'div',
              { className: 'ons-row' },
              h('button', { type: 'button', onClick: () => setSize(-18), title: copy.menu.smaller }, '－'),
              h('button', { type: 'button', onClick: () => setSize(18), title: copy.menu.bigger }, '＋'),
              h(
                'button',
                { type: 'button', 'data-on': motion ? '0' : '1', onClick: () => setMotion((value) => !value) },
                motion ? '🎬' : '⏸',
              ),
            ),
            h(
              'div',
              { className: 'ons-row' },
              h('button', { type: 'button', onClick: () => updateStore({ pos: null }) }, copy.menu.reset),
              h('button', { type: 'button', onClick: () => { setMenuOpen(false); updateStore({ visible: false }) } }, copy.menu.hide),
            ),
            snapshot !== null && snapshot.ok === false ? h('div', { className: 'ons-note' }, copy.offline) : null,
            // Scope transparency: the line reports what the Host actually did,
            // not what the client asked for — asking for a session the Host has
            // not recorded yet falls back to the Host-wide read, and saying
            // otherwise would be a lie the numbers contradict.
            h('div', { className: 'ons-scope' }, scopeLine(snapshot, copy)),
            // Diagnostics: four counters that answer "why is she not moving".
            // `polls` rising with `applied` flat means a request that never
            // lands; `applied` rising with `renders` flat means the state
            // updates but React is not re-rendering the companion.
            h('div', { className: 'ons-sub' }, `轮询 ${stats.polls} · 应用 ${stats.applied} · 渲染 ${stats.renders}${stats.failures > 0 ? ` · 失败 ${stats.failures}` : ''}`),
            h('div', { className: 'ons-hint' }, copy.menu.hint),
          )
        : null

      // The hidden state is a last-moment value choice, after every hook has
      // run: hiding her leaves the summon button, and un-hiding restores the
      // companion without React ever seeing a different hook order.
      if (!store.visible) {
        return h(
          'button',
          {
            type: 'button',
            className: 'ons-summon',
            title: copy.menu.summon,
            'aria-label': copy.menu.summon,
            style: { left: `${position.left}px`, top: `${position.top}px` },
            onClick: () => updateStore({ visible: true, lastSeenAt: Date.now(), awakeUntil: Date.now() + SLEEP_AFTER_MS }),
          },
          '🐾',
        )
      }

      return h(
        React.Fragment,
        null,
        h(
          'div',
          {
            className: `ons-root${dragging ? ' ons-dragging' : ''}`,
            'data-mood': mood,
            'data-motion': motion ? 'on' : 'off',
            style: { left: `${position.left}px`, top: `${position.top}px`, width: `${width}px` },
          },
          workNode,
          bubbleNode,
          h('div', { className: 'ons-stage', style: { width: `${width}px` } }, badge, sprite),
          menu,
        ),
      )
    }

    /** Progress toward the next affinity level, as a 4–100 percentage. */
    function barPercent(level, points) {
      if (level.next === null) return 100
      const span = level.next - level.threshold
      if (span <= 0) return 100
      return Math.min(100, Math.max(4, Math.round(((points - level.threshold) / span) * 100)))
    }

    /**
     * Which scope the menu reports.
     *
     * The Host answers this (`following`), because only the Host knows whether
     * the session the shell reported is one it has actually recorded. 'unknown'
     * is the honest middle state: a session id was sent, and it narrowed to
     * nothing, so the readings in force are the Host-wide ones.
     */
    function scopeLine(snapshot, copy) {
      const following = snapshot?.following
      if (following === 'session') return copy.menu.scopeNow
      if (following === 'unknown') return copy.menu.scopeUnknown
      return copy.menu.scopeHost
    }
    //#endregion

    //#region mounting
    return {
      inject: ['slots'],
      apply(ctx) {
        // Styles belong to the plugin fiber, not to a component: one <style>
        // tag for the page, removed when the plugin unloads.
        ctx.effect(() => {
          ensureStyles()
          return () => {
            const tag = document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`)
            if (tag !== null) tag.remove()
          }
        }, 'ostan-nanami-san: styles')

        // The companion IS the slot occupant — no second React root anywhere.
        // `shell.overlay` is the frame-wide floating layer, which is exactly the
        // seat a companion needs: above every column and outside their scroll
        // containers. Registration runs under the caller's fiber, so unloading
        // the plugin unloads the pet.
        try {
          ctx.slots.inject('shell.overlay', () => ctx.slots.register(
            { name: 'shell.overlay', id: 'ostan-nanami-san', order: 88 },
            guarded(NanamiPet),          ))
        } catch {
          // A Host without that seat simply shows no companion.
        }

        // The session probe: a session-scoped seat is the only place this client
        // is handed `sessionId`, which the root-scoped companion needs in order
        // to follow the visible tab. Failure here is not fatal — the pet falls
        // back to the Host-wide read.
        try {
          ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register(
            { name: 'conversation.chat.turnTail', id: 'ostan-nanami-san-session', order: 90 },
            SessionProbe,
          ))
        } catch {
          // No conversation seat: follow the Host instead of one session.
        }
      },
    }
    //#endregion
  },
})
