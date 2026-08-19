<div align="center">

# Astra

**An autonomous browser agent on the raw Chrome DevTools Protocol — zero runtime dependencies.**

[![TypeScript](https://img.shields.io/badge/TypeScript-7.x-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node.js-%E2%89%A522-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![CDP](https://img.shields.io/badge/Chrome%20DevTools%20Protocol-handwritten-4285F4?style=flat-square&logo=googlechrome&logoColor=white)](https://chromedevtools.github.io/devtools-protocol/)
[![Dependencies](https://img.shields.io/badge/runtime%20dependencies-0-00C853?style=flat-square)](package.json)
[![Tests](https://img.shields.io/badge/e2e%20battery-13%2F13-4CAF50?style=flat-square)](e2e/harness.ts)
[![License](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](LICENSE)

</div>

---

## Overview

Astra is an LLM-driven agent that operates a **real Chromium** end-to-end. It hand-writes the
Chrome DevTools Protocol client (WebSocket transport, JSON-RPC, input pipeline) instead of wrapping
Puppeteer or Playwright — the entire runtime is built on Node.js built-ins.

The agent perceives the page (DOM snapshot + vision), plans with 14 tools, and acts through the real
input pipeline (`Input.dispatchMouseEvent`, `Input.insertText`), which passes bot detection where
scripted `element.click()` fails. A safety layer gates every action, scrubs PII, and writes a full
audit trail.

> Scope note: this is an **agent harness**, not a browser build. It drives the installed
> Chrome/Edge/Electron Chromium over CDP — the value is the control plane, not the rendering engine.

## Features

- **Perception** — DOM snapshot with indexed elements, plus screenshot-based vision for captchas and pixel-level facts
- **Action tools** — navigate, click, type, select, upload, scroll, extract (prices/tables/page text), search, tabs, memory, done
- **Safety rails** — blocklist gating (pay/send/login/delete), allow/ask/deny policies, domain scoping, PII scrubbing, JSONL audit log
- **Multi-tab** — open, switch, and compare pages across tabs
- **Persistent memory** — domain-keyed facts survive across sessions
- **Verification** — hand-rolled test harnesses for every subsystem plus an e2e battery with randomized ground truth

## Architecture

```
┌─────────────────────────────┐
│  agent.ts  (decision loop)  │
│  perceive → plan → act      │
│  gates, budget, loop detect │
└──────────────┬──────────────┘
               │ 14 tools
┌──────────────▼──────────────┐
│  browser.ts  (CDP client)   │
│  hand-written WebSocket     │
│  JSON-RPC + input pipeline  │
└──────────────┬──────────────┘
               │ CDP (WebSocket / webContents.debugger)
┌──────────────▼──────────────┐
│  Chromium (Chrome/Electron) │
└─────────────────────────────┘
```

## Getting Started

**Requirements:** Node.js ≥ 22, Google Chrome (or set `CHROME_PATH`), an OpenAI-compatible LLM endpoint.

```bash
npm install

# configure the LLM
# LLM_BASE_URL=https://your-endpoint/v1
# LLM_API_KEY=sk-...
# LLM_MODEL=your-model
```

Run the agent from the CLI:

```bash
npm run agent -- "Find the cheapest book on books.toscrape.com and report its price"
npm run agent-ask -- "..."        # ask before sensitive actions
```

Or launch the Electron shell:

```bash
npm run shell
```

## Environment

| Variable      | Default                            | Purpose                          |
| ------------- | ---------------------------------- | -------------------------------- |
| `LLM_BASE_URL`| `https://generativelanguage.googleapis.com/v1beta/openai` | OpenAI-compatible endpoint |
| `LLM_API_KEY` | `unused`                           | API key                          |
| `LLM_MODEL`   | `gemini-3.5-flash-lite`            | Model id                         |
| `CHROME_PATH` | Windows Chrome install path        | Browser binary for the CLI agent |

## Safety Model

Every tool call passes through a gate before execution:

- **Blocklist** — URLs, element text, and input types matching pay/send/login/delete patterns pause the loop
- **Policies** — `allowAll` (agent), `ask` (shell with approval cards), `denyAll` (tests)
- **Scope** — each task declares its domains; navigation outside them is gated
- **PII** — card numbers, phones, and emails are replaced before anything reaches the model
- **Audit** — every action, verdict, and reason is appended to `logs/audit.jsonl`

## Testing

Subsystem harnesses drive a real Chrome session and check PASS/FAIL:

| Suite          | Command             | Checks |
| -------------- | ------------------- | ------ |
| Safety rails   | `npm run safety`    | 35     |
| Form wizardry  | `npm run form-test` | 30     |
| Memory         | `npm run memory-test`| 13     |
| Tabs           | `npm run tab-test`  | 8      |
| Vision         | `npm run vision-test`| 4     |
| Perception     | `npm run perceive`  | —      |
| E2E battery    | `npm run e2e`       | 13     |

The e2e battery runs the full agent against randomized fixtures — ground truth (prices, order IDs)
is regenerated per run, and an anti-parrot test proves the agent re-verifies memory instead of
echoing stale facts.

## Project Structure

```
src/        production code — agent loop, CDP client, perception, safety, memory, vision, shell
test/       verification harnesses and fixtures
e2e/        generality battery (randomized ground truth)
scripts/    build tooling
```

## License

[MIT](LICENSE)