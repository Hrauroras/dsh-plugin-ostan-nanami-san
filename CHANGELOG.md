# Changelog

All notable changes to this plugin. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet.

## [0.6.0] — 2026-09-30

### Changed

- **Sleeping and working now coexist.** A busy Host no longer forces her awake: she
  naps through a long run and the user wakes her by interacting. The poke sets
  `awakeUntil`, which also stops her from dozing off again on the next tick. Because
  the two states genuinely coexist, the idle-chatter line is allowed during a run
  again — a sleeping companion muttering "Zzz…" no longer contradicts its own pose.
- **A pending question is now the single override.** `status === 'waiting'` outranks
  sleep *and* a manual mood. She comes out of a deep sleep to ask, and stays awake
  afterwards instead of dropping straight back down once answered.

### Fixed

- The wake-on-question hook ran **inside the render body**, so it scheduled another
  render, which fired another poll — a render side effect that made a test observe an
  offline posture instead of the snapshot it had just published. Moved into an effect.
- The test harness helper `tickTimers()` fired *every* interval, so one "publish a
  snapshot" step sent two racing requests (the 1500 ms poll and the 5000 ms watchdog).
  Added `tickPoll()` to fire exactly one.

## [0.5.1] — 2026-09-30

### Fixed

- **A long nap no longer masks work.** The nap branch was evaluated *before* the status
  lookup and its clock was the one the *user* resets by touching her, so a Host busy
  past the nap threshold was drawn asleep and the work only appeared once the user
  happened to click — reported as "she stays asleep until I click".

## [0.5.0] — 2026-09-30

### Fixed

- **React #321, "Invalid hook call" (a frozen companion).** The error boundary was
  written as `render() { return this.props.render() }`, which ran the companion's hooks
  outside React's render context. React unmounted the subtree while the polling effects
  stayed alive: the picture froze on the last good render and only a click or a refresh
  appeared to fix it. The boundary now receives an **element**, never a call.

### Added

- The error boundary **renders the failure text on screen** with a stack and a retry
  button, instead of only logging it. A frozen picture with a live poll is nearly
  undiagnosable from the outside; a visible `⚠ 奈奈酱出错了` is not.
- `轮询 / 应用 / 渲染` counters in the right-click menu, which separate "the poll died"
  from "the request failed" from "the state updated but the render did not happen".

## [0.4.3] — 2026-09-30

### Fixed

- **React #321, "Invalid hook call" (an early return above the hooks).** Hiding the
  companion returned early, above several hooks, so the next render saw a different
  hook count. The hidden state is now a value chosen at the end of a render, never an
  exit taken in the middle.

## [0.4.2] — 2026-09-30

### Changed

- The error detail (message and stack) is rendered rather than hidden in a `title`
  attribute: a failure the user cannot read is a failure nobody can report.

## [0.4.1] — 2026-09-30

### Fixed

- **The poll could stall permanently.** `start()` was gated on
  `document.visibilityState === 'visible'`, so a frame that did not report visible at
  mount never polled — and because `visibilitychange` only fires on a *change*, nothing
  could rescue it. The interval now opens unconditionally, a 5 s watchdog reconciles it,
  and a session switch re-reads immediately even while the document reports itself
  hidden.

### Added

- An error boundary around the companion, so one failing render cannot take the whole
  subtree down.

## [0.4.0] — 2026-09-30

### Fixed

- **The "waiting for you" face never appeared.** It listened for a `question/request`
  session event that **does not exist** in `SessionEventMap`, so the handler was
  unreachable. The signal is now durable log truth: `ask_user_question` blocks the turn
  inside `ctx.userQuestions` until an answer lands, so its open `tool/call` *is* the
  pending question and its matching `tool/result` *is* the answer. `turn/end` clears it
  whatever the reason, so an abort cannot leave her waiting forever.

### Added

- A `question` work kind, so the step pill reads "正在等你回答…" rather than naming the
  tool that happens to be blocking.
- A regression test asserting that an invented event type moves nothing.

## [0.3.2] — earlier

### Fixed

- State drift: the projection is now reconciled against the live agent registry at
  mount, on every config reload, and (throttled to 1 s) on every poll. A session
  already running at mount is adopted, and a missed `turn/end` is dropped once the Host
  stops listing the agent. Subagents never count as the user's work.

## [0.3.0] — earlier

### Added

- **Four-poses cut-out**, redrawn from the reference illustrations with a **border
  flood fill** instead of a colour threshold: the blouse, collar, sleeves and
  thigh-high socks are large enclosed white areas, so a global "distance from white"
  test punched them out as holes.
- Sprite caching fixed — `immutable, max-age=31536000` with a filename ETag meant a
  redrawn pose never reached a browser that already held the old one. Now
  `no-cache, must-revalidate` against a content-hash ETag, plus `ASSET_VERSION` on the
  client URL.

## [0.2.0] — earlier

### Added

- **Follows the session you are viewing.** The client half has no `sessions.list`, so a
  zero-pixel probe seats itself in the session-scoped `conversation.chat.turnTail` slot
  and hands `sessionId` to the floating companion in `shell.overlay`.
- The `following` tri-state (`session` / `unknown` / `host`), so the menu reports the
  scope the Host actually used rather than the one the client asked for.

## [0.1.0] — earlier

### Added

- Initial release: host projection over `turn/*` and `tool/*` boundaries, four poses,
  affinity, pats, snacks, drag, right-click menu, two languages.

[Unreleased]: https://github.com/Hrauroras/dsh-plugin-ostan-nanami-san/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/Hrauroras/dsh-plugin-ostan-nanami-san/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/Hrauroras/dsh-plugin-ostan-nanami-san/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/Hrauroras/dsh-plugin-ostan-nanami-san/compare/v0.4.3...v0.5.0
[0.4.3]: https://github.com/Hrauroras/dsh-plugin-ostan-nanami-san/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/Hrauroras/dsh-plugin-ostan-nanami-san/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/Hrauroras/dsh-plugin-ostan-nanami-san/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/Hrauroras/dsh-plugin-ostan-nanami-san/compare/v0.3.2...v0.4.0

<!-- Before publishing: replace every Hrauroras above with your GitHub username. -->

