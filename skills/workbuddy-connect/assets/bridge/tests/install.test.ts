import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { installOpenCodex, removeOpenCodex } from '../src/install.ts'

const adminToken = 'ocx_admin_abcdefghijklmnopqrstuvwxyz-ABCDEFGHIJKLMNO'
const bridgeToken = 'workbuddy-bridge-token-abcdefghijklmnopqrstuvwxyz'

function json(res: any, status: number, value: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(value))
}

async function fixture(t: any) {
  const providers = new Map<string, any>()
  const calls: Array<{ method: string, path: string, body?: any }> = []
  let failAfterPersistFor: string | undefined
  let defaultProviderOnFailure: string | undefined
  let defaultProvider = 'openai'
  let unreadableConfigOnFailure = false
  const models = {
    cn: [{ id: 'cn-text', context_window: 128000, input_modalities: ['text'], reasoning: { supportedEfforts: ['high', 'low'], defaultEffort: 'high' } }],
    global: [{ id: 'global-vision', context_length: 200000, supports_vision: true, reasoning: { supportedEfforts: ['medium'] } }],
  }
  const root = await mkdtemp(join(process.cwd(), '.test-opencodex-workbuddy-install-'))
  const configPath = join(root, 'config.json')
  async function persistConfig() {
    await writeFile(configPath, JSON.stringify({ defaultProvider, providers: Object.fromEntries(providers) }), 'utf8')
  }
  await persistConfig()
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (/^\/(cn|global)\/v1\/models$/.test(url.pathname)) {
      if (req.headers.authorization !== `Bearer ${bridgeToken}`) return json(res, 401, { error: 'unauthorized' })
      return json(res, 200, { object: 'list', data: models[url.pathname.split('/')[1] as 'cn' | 'global'] })
    }
    if (req.headers['x-opencodex-api-key'] !== adminToken) return json(res, 401, { error: 'unauthorized' })
    if (req.method === 'GET' && url.pathname === '/api/providers') {
      return json(res, 200, [...providers.entries()].map(([name, provider]) => ({ name, adapter: provider.adapter, baseUrl: provider.baseUrl })))
    }
    let body: any
    if (req.method === 'POST' && url.pathname === '/api/providers') {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk)
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      calls.push({ method: 'POST', path: url.pathname, body })
      providers.set(body.name, body.provider)
      await persistConfig()
      if (body.name === failAfterPersistFor) {
        if (defaultProviderOnFailure !== undefined) {
          defaultProvider = defaultProviderOnFailure
          await persistConfig()
        }
        if (unreadableConfigOnFailure) await rm(configPath, { force: true })
        return json(res, 500, { error: 'persisted_then_failed' })
      }
      return json(res, 200, { success: true, name: body.name })
    }
    if (req.method === 'DELETE' && url.pathname === '/api/providers') {
      calls.push({ method: 'DELETE', path: `${url.pathname}?${url.searchParams}` })
      providers.delete(url.searchParams.get('name') ?? '')
      await persistConfig()
      return json(res, 200, { success: true })
    }
    return json(res, 404, { error: 'not_found' })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address() as { port: number }
  const url = `http://127.0.0.1:${address.port}`
  const prior = process.env.OPENCODEX_ADMIN_AUTH_TOKEN
  process.env.OPENCODEX_ADMIN_AUTH_TOKEN = adminToken
  t.after(async () => {
    if (prior === undefined) delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN
    else process.env.OPENCODEX_ADMIN_AUTH_TOKEN = prior
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await rm(root, { recursive: true, force: true })
  })
  return {
    url, providers, calls, configPath, persistConfig,
    failAfterPersist(name: string | undefined, makeDefault?: string, makeConfigUnreadable = false) {
      failAfterPersistFor = name
      defaultProviderOnFailure = makeDefault
      unreadableConfigOnFailure = makeConfigUnreadable
    },
  }
}

test('installs both regional providers live with catalog metadata and preserves OpenCodex default', async t => {
  const { url, providers, calls, configPath } = await fixture(t)
  const report = await installOpenCodex({ bridgeUrl: url, token: bridgeToken, openCodexUrl: url, openCodexConfigPath: configPath })
  assert.deepEqual(report.map(item => item.action), ['installed', 'installed'])
  const cn = providers.get('workbuddy-cn')
  assert.equal(cn.adapter, 'openai-chat')
  assert.equal(cn.baseUrl, `${url}/cn/v1`)
  assert.equal(cn.allowPrivateNetwork, true)
  assert.deepEqual(cn.modelContextWindows, { 'cn-text': 128000 })
  assert.deepEqual(cn.modelInputModalities, { 'cn-text': ['text'] })
  assert.deepEqual(cn.modelReasoningEfforts, { 'cn-text': ['low', 'high'] })
  assert.equal(cn.modelDefaultReasoningEfforts['cn-text'], 'high')
  assert.deepEqual(providers.get('workbuddy-global').modelInputModalities, { 'global-vision': ['text', 'image'] })
  assert.equal(calls.length, 2)
})

test('is idempotent and refuses to overwrite another provider with the same name', async t => {
  const { url, providers, calls, configPath, persistConfig } = await fixture(t)
  await installOpenCodex({ bridgeUrl: url, token: bridgeToken, openCodexUrl: url, openCodexConfigPath: configPath, regions: ['cn'] })
  const again = await installOpenCodex({ bridgeUrl: url, token: bridgeToken, openCodexUrl: url, openCodexConfigPath: configPath, regions: ['cn'] })
  assert.deepEqual(again, [{ provider: 'workbuddy-cn', region: 'cn', action: 'unchanged', models: 1 }])
  assert.equal(calls.length, 1)
  providers.set('workbuddy-global', { adapter: 'openai-chat', baseUrl: 'http://127.0.0.1:9999/global/v1' })
  await persistConfig()
  await assert.rejects(() => installOpenCodex({ bridgeUrl: url, token: bridgeToken, openCodexUrl: url, openCodexConfigPath: configPath, regions: ['global'] }), /refusing to overwrite/)
})

test('removal only touches a matching loopback bridge provider', async t => {
  const { url, providers, calls, configPath, persistConfig } = await fixture(t)
  providers.set('workbuddy-cn', { adapter: 'openai-chat', baseUrl: `${url}/cn/v1` })
  providers.set('workbuddy-global', { adapter: 'openai-chat', baseUrl: 'https://example.com/global/v1' })
  await persistConfig()
  const report = await removeOpenCodex({ bridgeUrl: url, openCodexUrl: url, openCodexConfigPath: configPath })
  assert.deepEqual(report, [
    { provider: 'workbuddy-cn', region: 'cn', action: 'removed' },
    { provider: 'workbuddy-global', region: 'global', action: 'skipped', reason: 'not_owned' },
  ])
  assert.equal(providers.has('workbuddy-cn'), false)
  assert.equal(providers.has('workbuddy-global'), true)
  assert.equal(calls.filter(call => call.method === 'DELETE').length, 1)
})

test('rolls back a prior provider and a second provider persisted before its failed response', async t => {
  const { url, providers, calls, configPath, failAfterPersist } = await fixture(t)
  failAfterPersist('workbuddy-global')
  await assert.rejects(
    () => installOpenCodex({ bridgeUrl: url, token: bridgeToken, openCodexUrl: url, openCodexConfigPath: configPath }),
    /management API rejected/,
  )
  assert.equal(providers.has('workbuddy-cn'), false)
  assert.equal(providers.has('workbuddy-global'), false)
  assert.deepEqual(calls.filter(call => call.method === 'DELETE').map(call => call.path).sort(), [
    '/api/providers?name=workbuddy-cn',
    '/api/providers?name=workbuddy-global',
  ])
})

test('rollback honors the explicit config path when a prior provider became default', async t => {
  const { url, providers, calls, configPath, failAfterPersist } = await fixture(t)
  failAfterPersist('workbuddy-global', 'workbuddy-cn')
  await assert.rejects(
    () => installOpenCodex({ bridgeUrl: url, token: bridgeToken, openCodexUrl: url, openCodexConfigPath: configPath }),
    /management API rejected/,
  )
  assert.equal(providers.has('workbuddy-cn'), true)
  assert.equal(providers.has('workbuddy-global'), false)
  assert.deepEqual(calls.filter(call => call.method === 'DELETE').map(call => call.path), [
    '/api/providers?name=workbuddy-global',
  ])
})

test('rollback preserves newly installed providers when the default provider cannot be read', async t => {
  const { url, providers, calls, configPath, failAfterPersist } = await fixture(t)
  failAfterPersist('workbuddy-global', undefined, true)
  await assert.rejects(
    () => installOpenCodex({ bridgeUrl: url, token: bridgeToken, openCodexUrl: url, openCodexConfigPath: configPath }),
    /management API rejected/,
  )
  assert.equal(providers.has('workbuddy-cn'), true)
  assert.equal(providers.has('workbuddy-global'), true)
  assert.equal(calls.filter(call => call.method === 'DELETE').length, 0)
})

test('rejects loopback URLs with embedded credentials before contacting either service', async t => {
  const { url, calls, configPath } = await fixture(t)
  await assert.rejects(
    () => installOpenCodex({ bridgeUrl: `http://user:pass@127.0.0.1:${new URL(url).port}`, token: bridgeToken, openCodexUrl: url, openCodexConfigPath: configPath, regions: ['cn'] }),
    /absolute HTTP loopback URL/,
  )
  await assert.rejects(
    () => installOpenCodex({ bridgeUrl: url, token: bridgeToken, openCodexUrl: `http://user:pass@127.0.0.1:${new URL(url).port}`, openCodexConfigPath: configPath, regions: ['cn'] }),
    /absolute HTTP loopback URL/,
  )
  await assert.rejects(
    () => installOpenCodex({ bridgeUrl: 'https://example.com', token: bridgeToken, openCodexUrl: url, openCodexConfigPath: configPath, regions: ['cn'] }),
    /absolute HTTP loopback URL/,
  )
  assert.equal(calls.length, 0)
})

test('applies a timeout signal to bridge discovery and management API requests', async t => {
  const { url, configPath } = await fixture(t)
  const original = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout')
  let timeouts = 0
  Object.defineProperty(AbortSignal, 'timeout', {
    configurable: true,
    value: () => { timeouts += 1; return AbortSignal.abort() },
  })
  try {
    await assert.rejects(
      () => installOpenCodex({ bridgeUrl: url, token: bridgeToken, openCodexUrl: url, openCodexConfigPath: configPath, regions: ['cn'] }),
      /model discovery failed/,
    )
    await assert.rejects(
      () => removeOpenCodex({ openCodexUrl: url, openCodexConfigPath: configPath, regions: ['cn'] }),
      /management API is unavailable/,
    )
    assert.equal(timeouts, 2)
  } finally {
    if (original === undefined) delete (AbortSignal as any).timeout
    else Object.defineProperty(AbortSignal, 'timeout', original)
  }
})
