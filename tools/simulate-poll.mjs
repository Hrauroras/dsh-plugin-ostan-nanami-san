// Simulate what the browser polls: ride one real session id and print changes.
const real = process.argv[2]
const seconds = Number(process.argv[3] ?? 12)
if (!real) {
  console.error('usage: node tools/simulate-poll.mjs <sessionId> [seconds]')
  process.exit(2)
}
const url = `http://127.0.0.1:19387/api/ostan-nanami-san/state?current=${encodeURIComponent(real)}`
const deadline = Date.now() + seconds * 1000
let previous = null
while (Date.now() < deadline) {
  const snapshot = await (await fetch(url)).json()
  const step = snapshot.work
    ? `${snapshot.work.kind === 'tool' ? '*' : '-'} ${snapshot.work.label.zh}`
    : '(none)'
  const line = `following=${snapshot.following} state=${snapshot.state} status=${snapshot.status} busy=${snapshot.busy} counted=${snapshot.counted} step=${step}`
  if (line !== previous) {
    console.log(new Date().toISOString().slice(11, 19), line)
    previous = line
  }
  await new Promise((resolve) => setTimeout(resolve, 600))
}
