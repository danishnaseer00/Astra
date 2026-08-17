// The chrome: dumb UI. All logic lives in the main process; this file only
// forwards clicks/keystrokes and renders what the main process streams back.
const $ = (s) => document.querySelector(s)

const askEl = $('#ask')
const omniboxEl = $('#omnibox-input')
const modeEl = $('#mode')
const domainsEl = $('#domains')
const maxMsEl = $('#maxms')
const logEl = $('#log')
const gateEl = $('#gate')
const resultCardEl = $('#result-card')
const resultAnswerEl = $('#result-answer')
const resultStatsEl = $('#result-stats')
const stepsEl = $('#steps')
const stepsHead = $('#steps-head')
const stepCountEl = $('#step-count')
const statusDot = $('#status-dot')
const statusText = $('#status-text')
const runBtn = $('#run')
const stopBtn = $('#stop')
const backBtn = $('#back')
const fwdBtn = $('#forward')
const tabsEl = $('#tabs')
const paneEl = $('#pane')
const paneToggleBtn = $('#pane-toggle')
const themeToggleBtn = $('#theme-toggle')
const themeSun = $('#theme-sun')
const themeMoon = $('#theme-moon')

let gateId = null
let stepLines = 0
let paneOpen = true
let running = false
const tabChips = new Map()

// ---------- theme ----------

const applyTheme = (theme) => {
  document.body.dataset.theme = theme
  themeSun.hidden = theme === 'dark'
  themeMoon.hidden = theme !== 'dark'
  try { localStorage.setItem('comet-theme', theme) } catch {}
}

applyTheme((() => {
  try { return localStorage.getItem('comet-theme') || 'dark' } catch { return 'dark' }
})())

themeToggleBtn.addEventListener('click', () => {
  applyTheme(document.body.dataset.theme === 'dark' ? 'light' : 'dark')
})

// ---------- status / log ----------

const setStatus = (state, text) => {
  statusDot.className = `dot ${state}`
  statusText.textContent = text
}

const appendLog = (line) => {
  stepLines++
  stepCountEl.textContent = `${stepLines} lines`
  const el = document.createElement('div')
  el.textContent = line
  logEl.appendChild(el)
  logEl.scrollTop = logEl.scrollHeight
}

const setRunning = (isRunning) => {
  running = isRunning
  runBtn.hidden = isRunning
  stopBtn.hidden = !isRunning
  if (isRunning) askEl.disabled = true
  else askEl.disabled = false
}

askEl.addEventListener('input', () => {
  runBtn.hidden = !askEl.value.trim()
  stopBtn.hidden = running
})

const showResult = (r) => {
  resultAnswerEl.textContent = r.answer
  resultStatsEl.textContent =
    `${r.steps} steps · ~${r.totalTokens.toLocaleString()} tokens · ${r.gated} gated · ${r.denied} denied`
  resultCardEl.hidden = false
}

// ---------- tabs ----------

const renderTab = (t) => {
  let chip = tabChips.get(t.id)
  if (!chip) {
    chip = document.createElement('div')
    chip.className = 'tab'
    const fav = document.createElement('img')
    fav.className = 'tfav'
    fav.alt = ''
    const label = document.createElement('span')
    label.className = 'tlabel'
    chip.append(fav, label)
    if (t.closable) {
      const x = document.createElement('button')
      x.className = 'tx'
      x.textContent = '×'
      x.title = 'Close tab'
      x.addEventListener('click', (e) => {
        e.stopPropagation()
        shell.closeTab(t.id)
      })
      chip.appendChild(x)
    }
    chip.addEventListener('click', () => shell.activateTab(t.id))
    tabsEl.appendChild(chip)
    tabChips.set(t.id, chip)
  }
  const fav = chip.querySelector('.tfav')
  fav.src = t.favicon || ''
  fav.style.visibility = t.favicon ? 'visible' : 'hidden'
  chip.querySelector('.tlabel').textContent = t.label
  chip.title = t.url
  chip.classList.toggle('active', t.active)
  if (t.active) askEl.placeholder = t.url ? '' : 'Ask anything…'
}

const removeTab = (id) => {
  tabChips.get(id)?.remove()
  tabChips.delete(id)
}

shell.onTab((t) => renderTab(t))
shell.onTabRemoved((id) => removeTab(id))

$('#newtab').addEventListener('click', () => shell.createTab())

shell.onNavState((s) => {
  backBtn.disabled = !s.canBack
  fwdBtn.disabled = !s.canForward
})

$('#back').addEventListener('click', () => shell.goBack())
$('#forward').addEventListener('click', () => shell.goForward())
$('#reload').addEventListener('click', () => shell.reload())

paneToggleBtn.addEventListener('click', () => {
  paneOpen = !paneOpen
  paneEl.classList.toggle('closed', !paneOpen)
  paneToggleBtn.textContent = paneOpen ? '»' : '«'
  shell.togglePane(paneOpen)
})

// ---------- the omnibox ----------

// Chrome behavior: URLs go to a new tab, anything else is a web search.
const looksLikeUrl = (s) => {
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return true // any scheme (http, mailto, …)
  return !/\s/.test(s) && /^[^\s]+\.[a-z]{2,}([/?#].*)?$/i.test(s) // domain.tld
}

omniboxEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return
  const text = omniboxEl.value.trim()
  if (!text) return
  shell.goUrl(looksLikeUrl(text) ? text : `https://www.bing.com/search?q=${encodeURIComponent(text)}`)
  omniboxEl.value = ''
})

// ---------- suggestions ----------

document.querySelectorAll('.suggest-ex li').forEach((li) => {
  li.addEventListener('click', () => {
    askEl.value = li.textContent.trim()
    askEl.focus()
    runBtn.hidden = false
    stopBtn.hidden = true
  })
})

// ---------- the ask bar ----------

// One bar: URLs go to a new tab, everything else is an agent task.

async function submitAsk() {
  const text = askEl.value.trim()
  if (!text) return
  if (looksLikeUrl(text)) {
    shell.goUrl(text)
    askEl.value = ''
    return
  }
  resultCardEl.hidden = true
  resultAnswerEl.textContent = ''
  resultStatsEl.textContent = ''
  stepLines = 0
  stepCountEl.textContent = ''
  logEl.textContent = ''
  stepsEl.classList.add('open')
  setRunning(true)
  setStatus('running', 'running')
  const res = await shell.startRun({
    goal: text,
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
}

askEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitAsk()
})
runBtn.addEventListener('click', submitAsk)

stopBtn.addEventListener('click', () => {
  shell.stop()
  appendLog('(stop requested — finishing current step…)')
  setStatus('running', 'stopping…')
})

$('#deny').addEventListener('click', () => {
  shell.decideGate(gateId, false)
  gateEl.hidden = true
  setStatus('working', 'working')
})

$('#allow').addEventListener('click', () => {
  shell.decideGate(gateId, true)
  gateEl.hidden = true
  setStatus('working', 'working')
})

shell.onLog((line) => {
  appendLog(line)
  setStatus('working', 'working')
})

shell.onGate((g) => {
  gateId = g.id
  $('#gate-summary').textContent = `[${g.tool}] ${g.summary}`
  gateEl.hidden = false
  setStatus('gate', 'approval pending')
})

shell.onDone((r) => {
  gateEl.hidden = true
  setRunning(false)
  setStatus('done', 'completed')
  showResult(r)
  stepsEl.classList.remove('open')
})

stepsHead.addEventListener('click', () => {
  stepsEl.classList.toggle('open')
})
stepsHead.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    stepsEl.classList.toggle('open')
  }
})