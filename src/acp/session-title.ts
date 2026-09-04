/**
 * Decodes `acp:session_title` custom entries into ACP session-title updates.
 *
 * The producer is the user's `auto-title` pi extension: after generating a
 * conversation title it appends a custom entry via
 * `pi.appendEntry('acp:session_title', <payload>)`. That crosses RPC as
 * `entry_appended`, which the adapter decodes here into a title for an ACP
 * `session_info_update` — the mechanism ACP clients (e.g. Zed) use to name
 * external-agent threads.
 *
 * Payload shapes:
 *  - `{ title: string, source?: 'auto' | 'manual' }` — set/update the title.
 *  - `{ source: 'manual', title?: undefined }`       — a manual rename with no
 *    title change; nothing to display, so it decodes to null.
 */

/** One plan item-style narrow parse: returns the title, or null when unusable. */
export function parseSessionTitleEntry(data: unknown): string | null {
  if (data == null || typeof data !== 'object') return null
  const r = data as Record<string, unknown>
  if (typeof r.title !== 'string') return null
  const title = r.title.trim()
  return title === '' ? null : title
}
