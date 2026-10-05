import type { ToolCallContent } from '@agentclientprotocol/sdk'
import { toolResultToText } from './pi-tools.js'
import { codeBlock } from './markdown.js'

export function codemodeDisplayInput(args: unknown): string | null {
  const code = (args as { code?: unknown } | undefined)?.code
  return typeof code === 'string' && code.trim() ? codeBlock(code, 'javascript') : null
}

export function codemodeContent(result: unknown): ToolCallContent[] {
  const value = result as { content?: unknown[]; details?: { calls?: unknown }; nestedCalls?: unknown } | undefined
  const hasCalls = Array.isArray(value?.details?.calls) || value?.nestedCalls != null
  const blocks = Array.isArray(value?.content) ? value.content : []
  const text = hasCalls
    ? toolResultToText(result, 'markdown')
    : blocks
        .map(block => {
          const item = block as { type?: string; text?: unknown }
          return item.type === 'text' && typeof item.text === 'string' ? item.text : ''
        })
        .filter(Boolean)
        .join('\n')
  const content: ToolCallContent[] = text
    ? [{ type: 'content', content: { type: 'text', text: hasCalls ? text : codeBlock(text) } }]
    : []
  for (const block of blocks) {
    const item = block as { type?: string; data?: unknown; mimeType?: unknown }
    if (item.type === 'image' && typeof item.data === 'string' && typeof item.mimeType === 'string') {
      content.push({ type: 'content', content: { type: 'image', data: item.data, mimeType: item.mimeType } })
    }
  }
  return content
}
