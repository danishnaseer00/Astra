// shell/electron-transport.ts — the lesson-6 door: the same CDP wire as the
// port (lesson 4), but on the embedded WebContentsView via webContents.debugger.
// No port, no separate Chrome — the page lives inside our own window.
import type { WebContents } from 'electron'
import type { CdpCommand, CdpMessage } from '../browser.ts'

export class DebuggerCommand implements CdpCommand {
  private attached = false
  private wc: WebContents

  constructor(wc: WebContents) {
    this.wc = wc
    wc.debugger.attach('1.3')
    this.attached = true
  }

  async send(method: string, params: Record<string, unknown> = {}): Promise<CdpMessage> {
    if (!this.attached) return { error: { message: 'debugger not attached' } }
    try {
      // webContents.debugger resolves with the result directly (unlike the
      // WebSocket door, responses carry no id) and rejects on CDP errors.
      // A dead debugger session NEVER settles — race it with a timeout so a
      // wedged page fails loudly instead of hanging the whole agent.
      const result = await Promise.race([
        this.wc.debugger.sendCommand(method, params),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`CDP timeout after 15s: ${method}`)), 15_000)
        ),
      ])
      return { result }
    } catch (err) {
      return { error: { message: err instanceof Error ? err.message : String(err) } }
    }
  }

  close(): void {
    if (!this.attached) return
    try {
      this.wc.debugger.detach()
    } catch {
      // already detached
    }
    this.attached = false
  }
}
