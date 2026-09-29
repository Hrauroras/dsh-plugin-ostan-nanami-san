// Sample the pet's state and print every change, so a human's observation can
// be checked against what the Host actually reported.
const seconds = Number(process.argv[2] ?? 45)
const interval = Number(process.argv[3] ?? 500)
const url = 'http://127.0.0.1:19387/api/ostan-nanami-san/state'
const deadline = Date.now() + seconds * 1000
let previous = null
let samples = 0

while (Date.now() < deadline) {
  try {
    const snapshot = await (await fetch(url)).json()
    samples += 1
    const step = snapshot.work
      ? `${snapshot.work.kind}:${snapshot.work.label.zh}${snapshot.work.stale ? ' (stale)' : ''}`
      : '(none)'
    const line = `following=${snapshot.following} state=${snapshot.state} status=${snapshot.status} busy=${snapshot.busy} awaiting=${snapshot.awaiting} counted=${snapshot.counted} step=${step}`
    if (line !== previous) {
      console.log(new Date().toISOString().slice(11, 19), line)
      previous = line
    }
  } catch (error) {
    console.log(new Date().toISOString().slice(11, 19), 'transport error:', error?.message)
  }
  await new Promise((resolve) => setTimeout(resolve, interval))
}
console.log(`--- ${samples} samples ---`)
