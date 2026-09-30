import { toolCallTitle } from './acp/tool-title.js'
import { toolResultToText } from './acp/translate/pi-tools.js'

export type SubagentToolActivity = {
  id: string
  name: string
  title: string
  status: 'running' | 'completed' | 'failed'
  output?: string
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function bounded(text: string, max: number, lines = Infinity): string {
  const chunks = Number.isFinite(lines) ? text.split('\n', lines + 1) : [text]
  const visible = chunks.slice(0, lines).join('\n')
  if (visible.length <= max && chunks.length <= lines) return visible
  return `${visible
    .slice(0, max - 1)
    .trimEnd()
    .replace(/[\uD800-\uDBFF]$/, '')}…`
}

function textContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block): block is Record<string, unknown> => record(block) && block.type === 'text')
    .map(block => (typeof block.text === 'string' ? block.text : ''))
    .join('')
}

function preview(result: unknown): string | undefined {
  if (!record(result)) return undefined
  const details = record(result.details) ? result.details : {}
  const content = textContent(result.content)
  // Pass only readable fields to the translator: its generic JSON fallback is not an activity preview.
  const readable: Record<string, unknown> = {
    content: content ? [{ type: 'text', text: content }] : [],
    details: {
      diff: typeof details.diff === 'string' ? details.diff : undefined,
      stdout: typeof details.stdout === 'string' ? details.stdout : undefined,
      stderr: typeof details.stderr === 'string' ? details.stderr : undefined
    },
    stdout: typeof result.stdout === 'string' ? result.stdout : undefined,
    stderr: typeof result.stderr === 'string' ? result.stderr : undefined
  }
  const hasText = [content, details.diff, details.stdout, details.stderr, result.stdout, result.stderr].some(
    value => typeof value === 'string' && value.trim()
  )
  return hasText ? bounded(toolResultToText(readable).trim(), 320, 4) : undefined
}

function activityTitle(name: string, args: unknown): string {
  const input = record(args) ? args : {}
  let title = toolCallTitle(name, input)
  if (name === 'bash' && typeof input.command === 'string') title = `bash: ${input.command}`
  if (['read', 'edit', 'write'].includes(name) && typeof input.path === 'string') title = `${name}: ${input.path}`
  return bounded(title.replace(/\s+/g, ' ').trim(), 160)
}

export class SubagentActivityCollector {
  private prompt?: string
  private hydratedPrompt = false
  private workingText = ''
  private liveResponse = false
  private readonly tools = new Map<string, SubagentToolActivity>()
  // Remember evicted IDs so replaying a transcript cannot displace newer live activity.
  private readonly seen = new Set<string>()

  observe(event: unknown): void {
    if (!record(event)) return
    if ((event.type === 'message_start' || event.type === 'message_end') && record(event.message)) {
      if (event.type === 'message_start' && event.message.role === 'assistant') {
        this.workingText = ''
        this.liveResponse = true
      }
      if (event.message.role === 'user' && this.prompt === undefined) {
        const text = textContent(event.message.content)
        if (text.trim()) this.prompt = bounded(text, 2000)
      }
    }
    if (event.type === 'message_update' && record(event.assistantMessageEvent)) {
      const update = event.assistantMessageEvent
      if (update.type === 'text_delta' && typeof update.delta === 'string') {
        this.liveResponse = true
        const text = record(update.partial) ? textContent(update.partial.content) : ''
        this.workingText = bounded(text || this.workingText + update.delta, 1200)
      }
      return
    }
    if (!['tool_execution_start', 'tool_execution_update', 'tool_execution_end'].includes(String(event.type))) return
    this.upsert(
      event.toolCallId,
      event.toolName,
      event.args,
      event.type === 'tool_execution_end' ? (event.isError === true ? 'failed' : 'completed') : 'running',
      event.type === 'tool_execution_update' ? event.partialResult : event.result,
      false
    )
  }

  hydrate(messages: readonly unknown[]): void {
    let boundary = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]
      if (record(message) && message.role === 'user') {
        boundary = i
        if (!this.hydratedPrompt) {
          const text = textContent(message.content)
          if (text.trim()) {
            this.prompt = bounded(text, 2000)
            this.hydratedPrompt = true
          }
        }
        break
      }
    }
    if (boundary < 0) return
    for (const message of messages.slice(boundary + 1)) {
      if (!record(message)) continue
      if (message.role === 'assistant' && Array.isArray(message.content)) {
        const text = textContent(message.content)
        if (!this.liveResponse && text) this.workingText = bounded(text, 1200)
        for (const block of message.content) {
          if (record(block) && block.type === 'toolCall') {
            this.upsert(block.id, block.name, block.arguments, 'running', undefined, true)
          }
        }
      } else if (message.role === 'toolResult') {
        this.upsert(
          message.toolCallId,
          message.toolName,
          undefined,
          message.isError === true ? 'failed' : 'completed',
          message,
          true
        )
      }
    }
  }

  snapshot(): { prompt?: string; activityTools: SubagentToolActivity[]; workingText?: string } {
    return {
      prompt: this.prompt,
      activityTools: [...this.tools.values()].map(tool => ({ ...tool })),
      workingText: this.workingText || undefined
    }
  }

  private upsert(
    id: unknown,
    name: unknown,
    args: unknown,
    status: SubagentToolActivity['status'],
    result: unknown,
    hydrated: boolean
  ): void {
    if (typeof id !== 'string' || !id) return
    let tool = this.tools.get(id)
    if (!tool) {
      if (this.seen.has(id) || typeof name !== 'string' || !name) return
      tool = { id, name, title: activityTitle(name, args), status }
      this.tools.set(id, tool)
      this.seen.add(id)
      if (this.tools.size > 8) this.tools.delete(this.tools.keys().next().value!)
    } else if (args !== undefined) {
      tool.title = activityTitle(tool.name, args)
    }
    const output = preview(result)
    if (output !== undefined && (!hydrated || tool.output === undefined || tool.status === 'running'))
      tool.output = output
    if (tool.status === 'running' || status === 'failed') tool.status = status
  }
}
