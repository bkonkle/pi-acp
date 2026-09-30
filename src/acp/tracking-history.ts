import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { PLAN_CUSTOM_TYPE } from './plan-bridge.js'
import { SUBAGENT_PLAN_CUSTOM_TYPE, SUBAGENT_RECORD_CUSTOM_TYPE } from './subagent-plan.js'

const TRACKING_TYPES = new Set([PLAN_CUSTOM_TYPE, SUBAGENT_PLAN_CUSTOM_TYPE, SUBAGENT_RECORD_CUSTOM_TYPE])

type Entry = { id: string; parentId?: string | null; type?: string; customType?: string; data?: unknown }

/** Read tracking entries on the active (last appended) branch without retaining message bodies. */
export async function readTrackingHistory(path: string): Promise<Entry[]> {
  const input = createReadStream(path, { encoding: 'utf8' })
  const lines = createInterface({ input, crlfDelay: Infinity })
  const entries = new Map<string, Entry>()
  let leaf: string | undefined
  try {
    for await (const line of lines) {
      try {
        const parsed = JSON.parse(line) as Entry
        if (typeof parsed.id !== 'string' || parsed.type === 'session') continue
        const entry: Entry = { id: parsed.id, parentId: parsed.parentId }
        if (
          parsed.type === 'custom' &&
          typeof parsed.customType === 'string' &&
          TRACKING_TYPES.has(parsed.customType)
        ) {
          entry.type = parsed.type
          entry.customType = parsed.customType
          entry.data = parsed.data
        }
        entries.set(entry.id, entry)
        leaf = entry.id
      } catch {
        // A partial final line or malformed legacy entry must not prevent a resume.
      }
    }
    const branch: Entry[] = []
    const seen = new Set<string>()
    while (leaf && !seen.has(leaf)) {
      seen.add(leaf)
      const entry = entries.get(leaf)
      if (!entry) break
      if (entry.type === 'custom') branch.push(entry)
      leaf = typeof entry.parentId === 'string' ? entry.parentId : undefined
    }
    return branch.reverse()
  } finally {
    lines.close()
    input.destroy()
  }
}
