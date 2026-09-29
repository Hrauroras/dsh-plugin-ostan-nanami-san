// Live sampler: poll the pet snapshot and print every change with timestamps.
//
// Usage: node tools/trace-state.mjs [seconds] [intervalMs]
const seconds = Number(process.argv[2] ?? 40)
const interval = Number(process.argv[3] ?? 400)
const url = 'http://127.0.0.1:19387/api/ostan-nanami-san/state'
const deadline = Date.now() + seconds * 1000

let previous = null
let samples = 0
let failures = 0
const transitions = []

const pad = (value, width) => String(value).padEnd(width)
const clock = () => new Date().toISOString().slice(11, 23)

console.log(`sampling ${url} every ${interval} ms for ${seconds} s`)
while (Date.now() < deadline) {
  let snapshot = null
  try {
    const response = await fetch(url, { headers: { accept: 'application/json' } })
    snapshot = await response.json()
    samples += 1
  } catch (error) {
    failures += 1
    if (failures <= 3) console.log(`${clock()}  transport error: ${error?.message}`)
    await new Promise((resolve) => setTimeout(resolve, interval))
    continue
  }

  const key = `${snapshot.state}|${snapshot.status}|${snapshot.busy}|${snapshot.awaiting}|${snapshot.turns}`
  const previousKey = previous === null ? null : `${previous.state}|${previous.status}|${previous.busy}|${previous.awaiting}|${previous.turns}`
  if (key !== previousKey) {
    const line = `${clock()}  state=${pad(snapshot.state, 6)} status=${pad(snapshot.status, 10)} busy=${snapshot.busy} awaiting=${snapshot.awaiting} sessions=${snapshot.sessions} turns=${snapshot.turns} cancelled=${snapshot.cancelled}`
    console.log(line)
    transitions.push(line)
  }
  previous = snapshot
  await new Promise((resolve) => setTimeout(resolve, interval))
}

console.log('---')
console.log(`samples=${samples} failures=${failures} transitions=${transitions.length}`)
if (previous !== null) {
  console.log(`final: state=${previous.state} status=${previous.status} busy=${previous.busy} sessions=${previous.sessions} turns=${previous.turns}`)
}
