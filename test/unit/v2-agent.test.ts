import test from 'node:test'
import assert from 'node:assert/strict'
import * as v2 from '@agentclientprotocol/sdk/experimental/v2'
import { buildV2Agent, type V1ConnShim } from '../../src/acp/v2/agent.js'
import type { PiAcpAgent } from '../../src/acp/agent.js'

/** Minimal v1 PiAcpAgent stub recording calls and scripting responses. */
function makeV1Stub(overrides: Partial<Record<string, unknown>> = {}) {
  const calls: Array<{ method: string; params: unknown }> = []
  const base = {
    initialize: async (params: unknown) => {
      calls.push({ method: 'initialize', params })
      return {
        protocolVersion: 1,
        agentInfo: { name: 'pi-acp', title: 'pi ACP adapter', version: 'test' },
        authMethods: []
      }
    },
    newSession: async (params: unknown) => {
      calls.push({ method: 'newSession', params })
      return {
        sessionId: 's1',
        configOptions: [
          {
            type: 'select',
            id: 'model',
            name: 'Model',
            currentValue: 'test/beta',
            options: [{ value: 'test/beta', name: 'Beta' }]
          }
        ]
      }
    },
    prompt: async (params: unknown) => {
      calls.push({ method: 'prompt', params })
      return { stopReason: 'end_turn', usage: { totalTokens: 10, inputTokens: 8, outputTokens: 2 } }
    },
    cancel: async (params: unknown) => {
      calls.push({ method: 'cancel', params })
    },
    resumeSession: async (params: unknown) => {
      calls.push({ method: 'resumeSession', params })
      return { configOptions: [] }
    },
    loadSession: async (params: unknown) => {
      calls.push({ method: 'loadSession', params })
      return { configOptions: [] }
    },
    listSessions: async (params: unknown) => {
      calls.push({ method: 'listSessions', params })
      return { sessions: [] }
    },
    deleteSession: async (params: unknown) => {
      calls.push({ method: 'deleteSession', params })
      return {}
    },
    closeSession: async (params: unknown) => {
      calls.push({ method: 'closeSession', params })
      return {}
    },
    setSessionConfigOption: async (params: unknown) => {
      calls.push({ method: 'setSessionConfigOption', params })
      return { configOptions: [] }
    },
    logout: async (params: unknown) => {
      calls.push({ method: 'logout', params })
      return {}
    },
    ...overrides
  }
  return { stub: base as unknown as PiAcpAgent, calls }
}

function connect(deps?: Parameters<typeof buildV2Agent>[0]) {
  const agentApp = buildV2Agent(deps)
  const clientApp = v2.client()
  return { agentApp, clientApp }
}

test('v2 agent: initialize negotiates protocolVersion 2 and maps client capabilities', async () => {
  const { clientApp } = connect()
  const initParams: unknown[] = []

  const agentApp2 = buildV2Agent({
    createV1Agent: () => {
      return makeV1Stub({
        initialize: async (params: unknown) => {
          initParams.push(params)
          return { protocolVersion: 1, agentInfo: { name: 'pi-acp', title: 'pi ACP adapter', version: 'test' } }
        }
      }).stub
    }
  })

  await clientApp.connectWith(agentApp2, async ctx => {
    const res = (await ctx.request('initialize', {
      protocolVersion: 2,
      info: { name: 'test-client', version: '0' },
      capabilities: { elicitation: { form: {} } }
    })) as any
    assert.equal(res.protocolVersion, 2)
    assert.equal(res.info.name, 'pi-acp')
    assert.equal(res.info.version, 'test')
  })

  // v2 `capabilities` must be mapped to the v1 agent's `clientCapabilities`.
  assert.deepEqual((initParams[0] as any).clientCapabilities, { elicitation: { form: {} } })
})

test('v2 agent: session/new maps to the v1 agent and returns sessionId + configOptions', async () => {
  const { stub, calls } = makeV1Stub()
  const agentApp = buildV2Agent({ createV1Agent: () => stub })
  const clientApp = v2.client()

  await clientApp.connectWith(agentApp, async ctx => {
    await ctx.request('initialize', {
      protocolVersion: 2,
      info: { name: 'test-client', version: '0' },
      capabilities: { elicitation: { form: {} } }
    })
    const res: any = await ctx.request('session/new', { cwd: '/tmp' })
    assert.equal(res.sessionId, 's1')
    assert.deepEqual(res.configOptions, [
      {
        type: 'select',
        configId: 'model',
        name: 'Model',
        currentValue: 'test/beta',
        options: [{ value: 'test/beta', name: 'Beta' }]
      }
    ])
    // v1-only response fields are dropped on the v2 surface.
    assert.equal(res.models, undefined)
    assert.equal(res.modes, undefined)
  })

  assert.deepEqual(
    calls.map(c => c.method),
    ['initialize', 'newSession']
  )
  assert.deepEqual((calls[1]!.params as any).cwd, '/tmp')
})

test('v2 agent: prompt accepts immediately and reports running -> idle state_update with stopReason and usage', async () => {
  const { stub, calls } = makeV1Stub()
  const agentApp = buildV2Agent({ createV1Agent: () => stub })
  const clientApp = v2.client()
  const updates: any[] = []
  clientApp.onNotification(v2.methods.client.session.update, ctx => {
    updates.push(ctx.params)
  })

  await clientApp.connectWith(agentApp, async ctx => {
    await ctx.request('initialize', {
      protocolVersion: 2,
      info: { name: 'test-client', version: '0' },
      capabilities: { elicitation: { form: {} } }
    })
    await ctx.request('session/new', { cwd: '/tmp' })
    const promptRes: any = await ctx.request('session/prompt', {
      sessionId: 's1',
      prompt: [{ type: 'text', text: 'hi' }]
    })
    // Accepted immediately (empty object), before the turn's idle state.
    assert.deepEqual(promptRes, {})

    // Keep the connection open until the background turn reports idle.
    const deadline = Date.now() + 2000
    while (!updates.some(u => u.update?.sessionUpdate === 'state_update' && u.update?.state === 'idle')) {
      if (Date.now() > deadline) throw new Error('timed out waiting for idle state_update')
      await new Promise(r => setTimeout(r, 5))
    }
  })

  const states = updates.filter(u => u.update?.sessionUpdate === 'state_update')
  assert.deepEqual(
    states.map(u => u.update.state),
    ['running', 'idle']
  )
  assert.equal(states[0]!.sessionId, 's1')
  assert.equal(states[1]!.update.stopReason, 'end_turn')
  assert.deepEqual(states[1]!.update.usage, { totalTokens: 10, inputTokens: 8, outputTokens: 2 })
  assert.deepEqual(
    calls.map(c => c.method),
    ['initialize', 'newSession', 'prompt']
  )
})

test('v2 agent: resume with replayFrom start routes to v1 loadSession, without to resumeSession', async () => {
  const { stub, calls } = makeV1Stub()
  const agentApp = buildV2Agent({ createV1Agent: () => stub })
  const clientApp = v2.client()

  await clientApp.connectWith(agentApp, async ctx => {
    await ctx.request('initialize', {
      protocolVersion: 2,
      info: { name: 'test-client', version: '0' },
      capabilities: { elicitation: { form: {} } }
    })
    await ctx.request('session/resume', { sessionId: 's1', cwd: '/tmp', replayFrom: { type: 'start' } })
    await ctx.request('session/resume', { sessionId: 's1', cwd: '/tmp' })
  })

  assert.deepEqual(
    calls.map(c => c.method),
    ['initialize', 'loadSession', 'resumeSession']
  )
})

test('v2 agent: set_config_option passes configId and typed value through to v1', async () => {
  const { stub, calls } = makeV1Stub()
  const agentApp = buildV2Agent({ createV1Agent: () => stub })
  const clientApp = v2.client()

  await clientApp.connectWith(agentApp, async ctx => {
    await ctx.request('initialize', {
      protocolVersion: 2,
      info: { name: 'test-client', version: '0' },
      capabilities: { elicitation: { form: {} } }
    })
    await ctx.request('session/set_config_option', {
      sessionId: 's1',
      configId: 'some_boolean_option',
      value: false,
      type: 'boolean'
    })
    await ctx.request('session/set_config_option', {
      sessionId: 's1',
      configId: 'model',
      value: 'test/beta',
      type: 'id'
    })
  })

  const opts = calls.filter(c => c.method === 'setSessionConfigOption')
  assert.deepEqual(opts[0]!.params, { sessionId: 's1', configId: 'some_boolean_option', value: false })
  assert.deepEqual(opts[1]!.params, { sessionId: 's1', configId: 'model', value: 'test/beta' })
})

test('v2 agent: lifecycle methods (list/delete/close/cancel/logout) delegate to v1', async () => {
  const { stub, calls } = makeV1Stub()
  const agentApp = buildV2Agent({ createV1Agent: () => stub })
  const clientApp = v2.client()

  await clientApp.connectWith(agentApp, async ctx => {
    await ctx.request('initialize', {
      protocolVersion: 2,
      info: { name: 'test-client', version: '0' },
      capabilities: { elicitation: { form: {} } }
    })
    await ctx.request('session/list', {})
    await ctx.request('session/delete', { sessionId: 's1' })
    await ctx.request('session/close', { sessionId: 's1' })
    await ctx.notify('session/cancel', { sessionId: 's1' })
    await ctx.request('auth/logout', {})
  })

  await new Promise(r => setTimeout(r, 10))

  assert.deepEqual(
    calls.map(c => c.method),
    ['initialize', 'listSessions', 'deleteSession', 'closeSession', 'cancel', 'logout']
  )
})

test('v2 agent: conn shim bridges session updates, permissions, and elicitations onto the v2 context', async () => {
  let shim: V1ConnShim | null = null
  const { stub } = makeV1Stub({
    initialize: async () => ({ protocolVersion: 1, agentInfo: { name: 'pi-acp', version: 'test' } }),
    // The stub keeps the shim to exercise it after initialize returns.
    newSession: async () => ({ sessionId: 's1' })
  })

  const agentApp = buildV2Agent({
    createV1Agent: conn => {
      shim = conn as unknown as V1ConnShim
      return stub
    }
  })
  const clientApp = v2.client()
  const updates: any[] = []
  clientApp.onNotification(v2.methods.client.session.update, ctx => {
    updates.push(ctx.params)
  })

  await clientApp.connectWith(agentApp, async ctx => {
    await ctx.request('initialize', {
      protocolVersion: 2,
      info: { name: 'test-client', version: '0' },
      capabilities: { elicitation: { form: {} } }
    })
    await shim!.sessionUpdate({
      sessionId: 's1',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } }
    } as any)
  })

  await new Promise(r => setTimeout(r, 10))
  assert.equal(updates.length, 1)
  assert.equal(updates[0]!.sessionId, 's1')
  assert.equal(updates[0]!.update.sessionUpdate, 'agent_message_chunk')
})

test('v2 agent: plan updates translate to plan_update and config options to configId', async () => {
  let shim: V1ConnShim | null = null
  const { stub } = makeV1Stub()

  const agentApp = buildV2Agent({
    createV1Agent: conn => {
      shim = conn as unknown as V1ConnShim
      return stub
    }
  })
  const clientApp = v2.client()
  const updates: any[] = []
  clientApp.onNotification(v2.methods.client.session.update, ctx => {
    updates.push(ctx.params)
  })

  await clientApp.connectWith(agentApp, async ctx => {
    await ctx.request('initialize', {
      protocolVersion: 2,
      info: { name: 'test-client', version: '0' },
      capabilities: { elicitation: { form: {} } }
    })

    // v1 `plan` -> v2 `plan_update` (entries preserved).
    await shim!.sessionUpdate({
      sessionId: 's1',
      update: { sessionUpdate: 'plan', entries: [{ content: 'step', status: 'pending', priority: 'high' }] }
    } as any)

    // v1 config_option_update carries `id`; v2 expects `configId`.
    await shim!.sessionUpdate({
      sessionId: 's1',
      update: {
        sessionUpdate: 'config_option_update',
        configOptions: [{ type: 'select', id: 'model', name: 'Model', currentValue: 'test/beta', options: [] }]
      }
    } as any)

    // v1 `current_mode_update` has no v2 equivalent -> dropped.
    await shim!.sessionUpdate({
      sessionId: 's1',
      update: { sessionUpdate: 'current_mode_update', currentModeId: 'high' }
    } as any)
  })

  await new Promise(r => setTimeout(r, 10))

  const planUpdate = updates.find(u => u.update?.sessionUpdate === 'plan_update')
  assert.ok(planUpdate)
  assert.equal(planUpdate.update.plan.type, 'items')
  assert.equal(planUpdate.update.plan.planId, 'pi-acp-plan')
  assert.deepEqual(planUpdate.update.plan.entries, [{ content: 'step', status: 'pending', priority: 'high' }])

  const configUpdate = updates.find(u => u.update?.sessionUpdate === 'config_option_update')
  assert.ok(configUpdate)
  assert.equal(configUpdate.update.configOptions[0]!.configId, 'model')
  assert.equal(configUpdate.update.configOptions[0]!.id, undefined)

  assert.equal(
    updates.find(u => u.update?.sessionUpdate === 'current_mode_update'),
    undefined
  )
})
