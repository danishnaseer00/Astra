// The chrome: dumb UI. All logic lives in the main process; this file only
// forwards clicks/keystrokes and renders what the main process streams back.
const $ = (s) => document.querySelector(s)

const urlEl = $('#url')
const goalEl = $('#goal')
const modeEl = $('#mode')
const domainsEl = $('#domains')
const maxMsEl = $('#maxms')
const logEl = $('#log')
const gateEl = $('#gate')
const resultEl = $('#result')
const statusDot = $('#status-dot')
const statusText = $('#status-text')
const runBtn = $('#run')
const stopBtn = $('#stop')

let gateId = null

const setStatus = (state, text) => {
  statusDot.className = `dot ${state}`
  statusText.textContent = text
}

const appendLog = (line) => {
  const el = document.createElement('div')
  el.textContent = line
  logEl.appendChild(el)
  logEl.scrollTop = logEl.scrollHeight
}

const setRunning = (running) => {
  runBtn.disabled = running
  runBtn.hidden = running
  stopBtn.hidden = !running
}

$('#go').addEventListener('click', () => shell.goUrl(urlEl.value.trim()))
urlEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') shell.goUrl(urlEl.value.trim())
})

runBtn.addEventListener('click', async () => {
  const goal = goalEl.value.trim()
  if (!goal) return
  resultEl.hidden = true
  logEl.textContent = ''
  setRunning(true)
  setStatus('running', 'running')
  const res = await shell.startRun({
    goal,
    mode: modeEl.value,
    domains: domainsEl.value.split(',').map((s) => s.trim()).filter(Boolean),
    maxMs: Number(maxMsEl.value) || 600000,
    carry: $('#carry').checked,
  })
  if (res && !res.ok) {
    appendLog(`ERROR: ${res.error}`)
    setRunning(false)
    setStatus('idle', 'idle')
  }
})

stopBtn.addEventListener('click', () => {
  shell.stop()
  appendLog('(stop requested — finishing current step…)')
})

$('#deny').addEventListener('click', () => {
  shell.decideGate(gateId, false)
  gateEl.hidden = true
  setStatus('running', 'running')
})

$('#allow').addEventListener('click', () => {
  shell.decideGate(gateId, true)
  gateEl.hidden = true
  setStatus('running', 'running')
})

shell.onLog((line) => {
  appendLog(line)
  setStatus('working', 'working')
})

shell.onGate((g) => {
  gateId = g.id
  $('#gate-summary').textContent = `[${g.tool}] ${g.summary}`
  gateEl.hidden = false
  setStatus('running', 'gate pending')
})

shell.onDone((r) => {
  gateEl.hidden = true
  setRunning(false)
  setStatus('idle', 'idle')
  resultEl.hidden = false
  resultEl.textContent = `${r.answer}\n\n(${r.steps} steps · ~${r.totalTokens.toLocaleString()} tokens · ${r.gated} gated · ${r.denied} denied)`
})

shell.onUrl((url) => {
  urlEl.value = url
})
