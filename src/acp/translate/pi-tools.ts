import { toolCallTitle } from '../tool-title.js'

/** Inner calls shown in a codemode card; Pi's own renderer also keeps only the latest ones. */
export const CODEMODE_CALL_PREVIEW = 20
const CODEMODE_ARGS_CHARS = 80
const CODEMODE_STATUS_ICONS: Record<string, string> = { running: '…', ok: '✓', error: '✗', cancelled: '⊘' }
// codemode prefixes its output with this header; Pi's renderer drops it too.
const CODEMODE_HEADER = /^Script completed\nWall time [^\n]*\nOutput:\n?$/

type CodemodeCall = { name: string; status: string; args?: unknown; durationMs?: unknown; error?: unknown }

/** codemode results carry `details.calls`: the tools the script called, with their status. */
function codemodeCalls(details: any): CodemodeCall[] | undefined {
  const calls = details?.calls
  if (!Array.isArray(calls)) return undefined
  const valid = calls.every(
    (c: any) => c && typeof c.name === 'string' && typeof c.status === 'string' && c.status in CODEMODE_STATUS_ICONS
  )
  return valid ? (calls as CodemodeCall[]) : undefined
}

function formatDuration(ms: unknown): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return ''
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
}

function formatCodemodeCall(call: CodemodeCall): string {
  const args = typeof call.args === 'string' ? call.args : ''
  const shortArgs = args.length > CODEMODE_ARGS_CHARS ? `${args.slice(0, CODEMODE_ARGS_CHARS - 3)}...` : args
  const parts = [CODEMODE_STATUS_ICONS[call.status], toolCallTitle(call.name, undefined)]
  if (shortArgs) parts.push(shortArgs)
  const duration = formatDuration(call.durationMs)
  if (duration) parts.push(duration)
  let line = parts.join(' ')
  if (call.status === 'error' && typeof call.error === 'string' && call.error) {
    line += `\n    ${call.error.split('\n').slice(0, 3).join('\n    ')}`
  }
  return line
}

/**
 * Text for a codemode tool call: the latest inner calls with their status, then the script output
 * without its "Script completed" header. The inner calls are not separate ACP tool calls (see the
 * `parentToolCallId` handling in session.ts), so this list is where they show up.
 */
function codemodeResultText(result: any, calls: CodemodeCall[]): string {
  const sections: string[] = []
  if (calls.length) {
    const shown = calls.slice(-CODEMODE_CALL_PREVIEW)
    const lines = shown.map(formatCodemodeCall)
    if (shown.length < calls.length) lines.unshift(`... (${calls.length - shown.length} earlier calls)`)
    sections.push(lines.join('\n'))
  }
  const content = Array.isArray(result?.content) ? result.content : []
  const texts = content
    .map((c: any) => (c?.type === 'text' && typeof c.text === 'string' ? c.text : ''))
    .filter(Boolean)
  if (texts.length && CODEMODE_HEADER.test(texts[0])) texts.shift()
  const output = texts.join('').trim()
  if (output) sections.push(output)
  return sections.join('\n\n')
}

export function toolResultToText(result: unknown): string {
  if (!result) return ''

  const details = (result as any)?.details

  const calls = codemodeCalls(details)
  if (calls) return codemodeResultText(result, calls)

  // pi's edit tool returns a terse success message in content and the full unified diff in details.diff.
  const diff = details?.diff
  if (typeof diff === 'string' && diff.trim()) {
    return diff
  }

  // pi tool results generally look like: { content: [{type:"text", text:"..."}], details: {...} }
  const content = (result as any).content
  if (Array.isArray(content)) {
    const texts = content
      .map((c: any) => (c?.type === 'text' && typeof c.text === 'string' ? c.text : ''))
      .filter(Boolean)
    if (texts.length) return texts.join('')
  }

  // The bash tool frequently returns stdout/stderr in `details` rather than content blocks.
  const stdout =
    (typeof details?.stdout === 'string' ? details.stdout : undefined) ??
    (typeof (result as any)?.stdout === 'string' ? (result as any).stdout : undefined) ??
    (typeof details?.output === 'string' ? details.output : undefined) ??
    (typeof (result as any)?.output === 'string' ? (result as any).output : undefined)

  const stderr =
    (typeof details?.stderr === 'string' ? details.stderr : undefined) ??
    (typeof (result as any)?.stderr === 'string' ? (result as any).stderr : undefined)

  const exitCode =
    (typeof details?.exitCode === 'number' ? details.exitCode : undefined) ??
    (typeof (result as any)?.exitCode === 'number' ? (result as any).exitCode : undefined) ??
    (typeof details?.code === 'number' ? details.code : undefined) ??
    (typeof (result as any)?.code === 'number' ? (result as any).code : undefined)

  if ((typeof stdout === 'string' && stdout.trim()) || (typeof stderr === 'string' && stderr.trim())) {
    const parts: string[] = []
    if (typeof stdout === 'string' && stdout.trim()) parts.push(stdout)
    if (typeof stderr === 'string' && stderr.trim()) parts.push(`stderr:\n${stderr}`)
    if (typeof exitCode === 'number') parts.push(`exit code: ${exitCode}`)
    return parts.join('\n\n').trimEnd()
  }

  try {
    return JSON.stringify(result, null, 2)
  } catch {
    return String(result)
  }
}
