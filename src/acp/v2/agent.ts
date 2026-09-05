import type { AgentSideConnection } from '@agentclientprotocol/sdk'
import { RequestError } from '@agentclientprotocol/sdk'
import * as v2 from '@agentclientprotocol/sdk/experimental/v2'
import type {
  CloseSessionResponse,
  DeleteSessionResponse,
  InitializeResponse,
  ListSessionsResponse,
  NewSessionResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  ResumeSessionResponse,
  SessionConfigOption,
  SetSessionConfigOptionResponse
} from '@agentclientprotocol/sdk/experimental/v2'
import { PiAcpAgent } from '../agent.js'

/**
 * Experimental ACP v2 (draft) agent for pi, per `docs/v2-parity-and-mcp-plan.md` Track B.
 *
 * Strategy: delegate to the v1 `PiAcpAgent` (which owns sessions, pi-RPC translation, config
 * options, titles, plans) and adapt only what v2 changes on the wire:
 *
 *  - `initialize` echoes `protocolVersion: 2` and the v2 `info`/`capabilities` shape.
 *  - `session/prompt` returns void; the turn runs async and completion moves onto
 *    `state_update` notifications (`running` → `idle` with `stopReason` + usage).
 *  - `session/resume` gains `replayFrom`: `{type:"start"}` maps to the v1 history-replay
 *    `session/load` path; absent maps to the v1 no-replay resume path.
 *  - `session/set_config_option` values are typed (`id` | `boolean`) instead of string-only.
 *  - v1-only `modes`/`current_mode_update` are not part of the v2 response surface.
 *
 * Outbound `session/update` notifications keep the v1 wire shape (`{sessionId, update}`), which
 * is byte-identical to the v2 `UpdateSessionNotification`; v1-only variants (`plan`,
 * `current_mode_update`) are tolerated as unknown by v2 clients that follow the spec's
 * forward-compatibility rule. Translating `plan` → `plan_update` is deferred (Track B6).
 */

/** Subset of the v1 `AgentSideConnection` the adapter actually calls, bridged onto a v2 context. */
export type V1ConnShim = Pick<AgentSideConnection, 'sessionUpdate' | 'requestPermission' | 'createElicitation'>

export type V2AgentDeps = {
  /** Test seam: build the v1 agent instead of the real one. */
  createV1Agent?: (conn: V1ConnShim) => PiAcpAgent
}

/**
 * Translate a v1 session update onto the v2 surface. Returns null for updates v2 has no
 * equivalent for (dropped, never silently re-shaped into something wrong).
 */
function toV2Update(update: unknown): Record<string, unknown> | null {
  const u = update as { sessionUpdate?: string; messageId?: unknown; entries?: unknown } | null
  if (!u || typeof u !== 'object') return null

  switch (u.sessionUpdate) {
    case 'agent_message_chunk':
    case 'agent_thought_chunk':
    case 'user_message_chunk':
      // v2 requires messageId on every content chunk. v1 assigns one to streamed deltas;
      // status notices (retry/compaction/queue) may omit it, so synthesize a stable one.
      return { ...u, messageId: typeof u.messageId === 'string' && u.messageId ? u.messageId : 'm0' }

    case 'plan':
      // v2 replaced the `plan` update with `plan_update`; entry shapes are compatible.
      return {
        sessionUpdate: 'plan_update',
        plan: { type: 'items', planId: 'pi-acp-plan', entries: Array.isArray(u.entries) ? u.entries : [] }
      }

    case 'current_mode_update':
      // v2 removed the modes API; config_option_update carries the same signal.
      return null

    case 'config_option_update':
      // v2 renamed config option `id` to `configId`.
      return { ...u, configOptions: toV2ConfigOptions((u as { configOptions?: unknown }).configOptions) }

    default:
      return u as Record<string, unknown>
  }
}

function makeV1ConnShim(client: v2.AgentContext): V1ConnShim {
  return {
    sessionUpdate: (params: { sessionId: string; update: unknown }) => {
      const translated = toV2Update(params.update)
      if (!translated) return Promise.resolve()
      return client.notify(v2.methods.client.session.update, {
        sessionId: params.sessionId,
        update: translated
      } as never)
    },
    requestPermission: (params: RequestPermissionRequest): Promise<RequestPermissionResponse> =>
      // Wire passthrough; v1 params may omit fields v2 types as required (e.g. `title`).
      client.request(v2.methods.client.session.requestPermission, params as never) as Promise<RequestPermissionResponse>,
    createElicitation: (params: unknown): Promise<unknown> =>
      client.request(v2.methods.client.elicitation.create, params as never) as Promise<unknown>
  } as unknown as V1ConnShim
}

/** Translate v1 config options (id) onto the v2 surface (configId). */
function toV2ConfigOptions(options: unknown): SessionConfigOption[] {
  if (!Array.isArray(options)) return []
  return options.map(option => {
    const { id, ...rest } = option as { id?: string } & Record<string, unknown>
    return { ...rest, configId: String(rest.configId ?? id) } as unknown as SessionConfigOption
  })
}

/** Adapt the v1 `session/new` response to the v2 surface (sessionId + configOptions + _meta). */
function toV2SessionResponse(v1: {
  sessionId?: string
  configOptions?: unknown
  _meta?: unknown
}): NewSessionResponse {
  return {
    sessionId: v1.sessionId!,
    ...(v1.configOptions !== undefined ? { configOptions: toV2ConfigOptions(v1.configOptions) } : {}),
    ...(v1._meta !== undefined ? { _meta: v1._meta as Record<string, unknown> } : {})
  }
}

/** Adapt a v1 load/resume response (configOptions + _meta, no sessionId) to the v2 resume shape. */
function toV2ResumeResponse(v1: { configOptions?: unknown; _meta?: unknown }): ResumeSessionResponse {
  return {
    ...(v1.configOptions !== undefined ? { configOptions: toV2ConfigOptions(v1.configOptions) } : {}),
    ...(v1._meta !== undefined ? { _meta: v1._meta as Record<string, unknown> } : {})
  }
}

export function buildV2Agent(deps: V2AgentDeps = {}): v2.AgentApp {
  // Connection-scoped state. The router guarantees `initialize` is the first request, so the
  // v1 agent + client context are created there and reused by every later handler.
  let v1: PiAcpAgent | null = null

  function requireV1(): PiAcpAgent {
    if (!v1) throw new Error('session method called before initialize')
    return v1
  }

  function isRequestError(err: unknown): err is InstanceType<typeof RequestError> {
    return err instanceof Error && err.name === 'RequestError'
  }

  const app = new v2.AgentApp({ name: 'pi-acp' })

  app.onRequest(v2.methods.agent.initialize, async ctx => {
    const shim = makeV1ConnShim(ctx.client)
    v1 = deps.createV1Agent?.(shim) ?? new PiAcpAgent(shim as unknown as AgentSideConnection)

    // Run the v1 initialize for its side effects (client caps capture, settings seed) and
    // re-shape the response for v2 (info/capabilities keys, protocolVersion 2). v2 renames
    // `clientCapabilities` to `capabilities` — map it back for the v1 agent.
    const v1Response = (await v1.initialize({
      ...ctx.params,
      clientCapabilities: (ctx.params as { capabilities?: unknown }).capabilities
    } as never)) as unknown as {
      protocolVersion?: number
      agentInfo?: { name?: string; title?: string; version?: string }
      authMethods?: unknown
    }

    return {
      protocolVersion: v2.PROTOCOL_VERSION,
      info: {
        name: v1Response.agentInfo?.name ?? 'pi-acp',
        title: v1Response.agentInfo?.title,
        version: v1Response.agentInfo?.version
      },
      ...(v1Response.authMethods !== undefined ? { authMethods: v1Response.authMethods as never } : {})
    } as InitializeResponse
  })

  app.onRequest(v2.methods.agent.session.new, async ctx => {
    const res = (await requireV1().newSession(ctx.params as never)) as unknown as {
      sessionId: string
      configOptions?: unknown
      _meta?: unknown
    }
    return toV2SessionResponse(res)
  })

  app.onRequest(v2.methods.agent.session.prompt, ctx => {
    const client = ctx.client
    const sessionId = ctx.params.sessionId
    const v1Agent = requireV1()

    // v2 "beyond the turn": accept the request immediately (this SDK sends the response when
    // the handler resolves, so the turn must run in the background) and report progress via
    // state_update notifications, ending with an idle state carrying the stop reason.
    void (async () => {
      await client.notify(v2.methods.client.session.update, {
        sessionId,
        update: { sessionUpdate: 'state_update', state: 'running' }
      } as never)

      let stopReason: string = 'end_turn'
      let usage: unknown = null
      try {
        const res = (await v1Agent.prompt(ctx.params as never)) as unknown as {
          stopReason: string
          usage?: unknown
        }
        stopReason = res.stopReason
        usage = res.usage ?? null
      } catch (err) {
        // Auth/config errors must still surface as JSON-RPC errors so clients can offer login.
        if (isRequestError(err)) throw err
        stopReason = 'end_turn'
        usage = null
      }

      await client.notify(v2.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: 'state_update',
          state: 'idle',
          stopReason,
          ...(usage ? { usage } : {})
        }
      } as never)
    })().catch(err => {
      const detail = isRequestError(err) ? err.message : String(err)
      process.stderr.write(`[pi-acp] v2 prompt error: ${detail}\n`)
    })

    // Immediate acceptance; completion is reported via state_update.
    return {}
  })

  app.onNotification(v2.methods.agent.session.cancel, ctx => {
    return requireV1().cancel(ctx.params as never)
  })

  app.onRequest(v2.methods.agent.session.resume, async ctx => {
    if (ctx.params.replayFrom?.type === 'start') {
      // Full-history replay maps to the v1 `session/load` path.
      const res = (await requireV1().loadSession({
        sessionId: ctx.params.sessionId,
        cwd: ctx.params.cwd,
        mcpServers: ctx.params.mcpServers,
        additionalDirectories: ctx.params.additionalDirectories
      } as never)) as unknown as { configOptions?: unknown; _meta?: unknown }
      return toV2ResumeResponse(res)
    }

    const res = (await requireV1().resumeSession({
      sessionId: ctx.params.sessionId,
      cwd: ctx.params.cwd,
      mcpServers: ctx.params.mcpServers,
      additionalDirectories: ctx.params.additionalDirectories
    } as never)) as unknown as { configOptions?: unknown; _meta?: unknown }
    return toV2ResumeResponse(res)
  })

  app.onRequest(v2.methods.agent.session.list, ctx => {
    return requireV1().listSessions(ctx.params as never) as Promise<ListSessionsResponse>
  })

  app.onRequest(v2.methods.agent.session.delete, async ctx => {
    const res = await requireV1().deleteSession(ctx.params as never)
    return (res ?? {}) as DeleteSessionResponse
  })

  app.onRequest(v2.methods.agent.session.close, async ctx => {
    const res = await requireV1().closeSession(ctx.params as never)
    return (res ?? {}) as CloseSessionResponse
  })

  app.onRequest(v2.methods.agent.session.setConfigOption, async ctx => {
    // v2 types the value (`id` | `boolean`); v1 infers from the value's JS type.
    const res = (await requireV1().setSessionConfigOption({
      sessionId: ctx.params.sessionId,
      configId: ctx.params.configId,
      value: ctx.params.value
    } as never)) as unknown as { configOptions?: unknown }
    return {
      configOptions: toV2ConfigOptions(res.configOptions)
    } as SetSessionConfigOptionResponse
  })

  app.onRequest(v2.methods.agent.auth.logout, async () => {
    await requireV1().logout({} as never)
    return {}
  })

  return app
}
