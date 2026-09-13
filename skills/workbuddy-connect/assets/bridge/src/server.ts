import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { once } from 'node:events'
import { hostIsLoopback, originIsLoopback } from './loopback.ts'
import { prepareChatBody, normalizeCredits, WorkBuddyUpstreamClient, type WorkBuddyUpstreamModel, type WorkBuddyRegion } from './upstream.ts'
import { CompletionAccumulator, readSse } from './sse.ts'

export type Region = WorkBuddyRegion
export interface RegionStore {
  resolve(): Promise<any>
  current(): Promise<any>
  status(): Promise<any>
}
export interface BridgeOptions {
  token: string
  port?: number
  stores: Record<Region, RegionStore>
  client?: Pick<WorkBuddyUpstreamClient, 'fetchModels' | 'chatStream' | 'fetchCredits'>
  timeoutMs?: number
}
const errorStatus = { hard_credit: 402, soft_rate: 429, session_dead: 401, not_found: 404, server: 502, client: 400 }
const MAX_BODY = 64 * 1024 * 1024

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}
function fail(res: ServerResponse, status: number, code: string, message: string): void {
  json(res, status, { error: { type: code, code, message } })
}
async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw Object.assign(new Error('Request body exceeds 64 MiB'), { status: 413 })
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw Object.assign(new Error('Invalid JSON request'), { status: 400 }) }
}
function modelRow(region: Region, model: WorkBuddyUpstreamModel) {
  const credits = normalizeCredits(model.billing?.credits)
  return {
    id: model.id, object: 'model', created: 0, owned_by: `workbuddy-${region}`,
    name: `${model.name}${credits ? ` · ${credits}` : ''}`,
    context_length: model.contextWindow, context_window: model.contextWindow,
    max_output_tokens: model.maxTokens,
    input_modalities: model.supportsImages ? ['text', 'image'] : ['text'],
    output_modalities: ['text'], supports_vision: model.supportsImages,
    reasoning: model.reasoning, billing: model.billing,
  }
}

export function createBridge(options: BridgeOptions) {
  if (options.token.length < 24) throw new Error('Bridge token must contain at least 24 characters')
  const client = options.client ?? new WorkBuddyUpstreamClient()
  const cache = new Map<Region, { identity: string; at: number; models: readonly WorkBuddyUpstreamModel[] }>()
  const loads = new Map<string, Promise<readonly WorkBuddyUpstreamModel[]>>()
  async function models(region: Region, credential: any) {
    const identity = `${credential.domain}:${credential.uid}:${credential.enterpriseId ?? ''}`
    const cached = cache.get(region)
    if (cached?.identity === identity && Date.now() - cached.at < 5 * 60_000) return cached.models
    const key = `${region}:${identity}`
    let pending = loads.get(key)
    if (!pending) {
      pending = client.fetchModels(credential).then(found => {
        cache.set(region, { identity, at: Date.now(), models: found })
        return found
      }).finally(() => loads.delete(key))
      loads.set(key, pending)
    }
    return pending
  }
  const server = createServer((req, res) => { void handle(req, res) })
  server.requestTimeout = 120_000
  server.headersTimeout = 30_000
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const controller = new AbortController()
    const abort = () => { if (!res.writableFinished) controller.abort() }
    res.on('close', abort)
    const timeout = setTimeout(() => controller.abort(new Error('WorkBuddy request timed out')), options.timeoutMs ?? 5 * 60_000)
    timeout.unref()
    try {
      if (!hostIsLoopback(req.headers.host) || !originIsLoopback(req.headers.origin)) {
        fail(res, 403, 'origin_not_allowed', 'Only localhost requests are accepted'); return
      }
      const auth = req.headers.authorization ?? ''
      const actual = Buffer.from(auth)
      const expected = Buffer.from(`Bearer ${options.token}`)
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        fail(res, 401, 'unauthorized', 'Missing or invalid bridge API key'); return
      }
      const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname.replace(/\/$/, '')
      if (req.method === 'GET' && path === '/healthz') {
        json(res, 200, { ok: true, service: 'opencodex-workbuddy-connect', version: '1.1.2' }); return
      }
      if (req.method === 'GET' && path === '/status') {
        const regions = Object.fromEntries(await Promise.all((['cn', 'global'] as const).map(async region => {
          const status = await options.stores[region].status()
          return [region, { state: status.state, domain: status.domain, expiresAtMs: status.expiresAtMs }]
        })))
        json(res, 200, { regions }); return
      }
      const match = /^\/(cn|global)\/v1\/(models|chat\/completions|credits)$/.exec(path)
      if (!match) { fail(res, 404, 'not_found', 'Unknown bridge route'); return }
      const region = match[1] as Region
      const route = match[2]
      let credential: any
      try { credential = await options.stores[region].resolve() }
      catch { fail(res, 401, 'not_signed_in', `Sign in to WorkBuddy ${region} desktop again, then retry`); return }
      if (req.method === 'GET' && route === 'models') {
        json(res, 200, { object: 'list', data: (await models(region, credential)).map(m => modelRow(region, m)) }); return
      }
      if (req.method === 'GET' && route === 'credits') {
        json(res, 200, await client.fetchCredits(credential)); return
      }
      if (req.method !== 'POST' || route !== 'chat/completions') {
        fail(res, 405, 'method_not_allowed', 'Unsupported HTTP method'); return
      }
      if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) {
        fail(res, 415, 'unsupported_media_type', 'Content-Type must be application/json'); return
      }
      const body = await readJson(req)
      if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.model !== 'string' || !Array.isArray(body.messages) || body.messages.length === 0) {
        fail(res, 400, 'invalid_request', 'A model and a non-empty messages array are required'); return
      }
      const catalog = await models(region, credential)
      const model = catalog.find(m => m.id === body.model)
      if (!model) { fail(res, 404, 'model_not_found', 'Model is not available in this WorkBuddy region'); return }
      const hasImage = body.messages.some((m: any) => Array.isArray(m?.content) && m.content.some((p: any) => p?.type === 'image_url'))
      if (hasImage && !model.supportsImages) {
        fail(res, 400, 'unsupported_image', 'This model does not support image input'); return
      }
      const stream = body.stream === true
      // Global WorkBuddy rejects a user-first conversation with code 11128.
      // Developer messages become system in prepareChatBody below.
      if (region === 'global' && !['system', 'developer'].includes(body.messages[0]?.role)) {
        body.messages.unshift({ role: 'system', content: 'You are a helpful coding assistant.' })
      }
      if (body.max_completion_tokens !== undefined) {
        body.max_tokens ??= body.max_completion_tokens
        delete body.max_completion_tokens
      }
      delete body.stream_options
      // Only forward efforts declared by this account's live catalog. An
      // unknown Codex default must not break an otherwise supported model.
      if (body.reasoning_effort && !model.reasoning?.supportedEfforts?.includes(body.reasoning_effort)) delete body.reasoning_effort
      body.max_tokens = Math.min(body.max_tokens ?? model.maxTokens, model.maxTokens)
      const result = await client.chatStream(credential, prepareChatBody(JSON.stringify(body)), controller.signal)
      if (!result.ok) {
        fail(res, errorStatus[result.kind], result.kind, `WorkBuddy ${region} rejected the request (${result.kind}, HTTP ${result.status})`); return
      }
      if (!result.response.body || !result.response.headers.get('content-type')?.includes('text/event-stream')) {
        await result.response.body?.cancel()
        fail(res, 502, 'upstream_protocol', 'WorkBuddy returned an unexpected response format'); return
      }
      if (stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' })
        res.flushHeaders()
      }
      const accumulator = new CompletionAccumulator()
      let sawDone = false
      let finished = false
      for await (const payload of readSse(result.response.body, controller.signal)) {
        if (payload === '[DONE]') { sawDone = true; break }
        let chunk: any
        try { chunk = JSON.parse(payload) } catch { throw new Error('Malformed upstream stream') }
        if (chunk.error) throw new Error('Upstream stream reported an error')
        if (chunk.choices?.some((choice: any) => choice.finish_reason)) finished = true
        accumulator.add(chunk)
        if (stream && !res.write(`data: ${payload}\n\n`)) await once(res, 'drain', { signal: controller.signal })
      }
      if (!sawDone || !finished) throw new Error('Upstream stream ended before completion')
      if (stream) res.end('data: [DONE]\n\n')
      else json(res, 200, accumulator.result())
    } catch (error: any) {
      if (res.destroyed) return
      if (!res.headersSent) fail(res, error.status ?? 502, 'bridge_error', error.status ? error.message : 'WorkBuddy request failed; retry or check the desktop login and network')
      else res.end(`data: ${JSON.stringify({ error: { type: 'upstream_stream_error', message: 'WorkBuddy stream interrupted; retry the request' } })}\n\n`)
    } finally {
      clearTimeout(timeout)
      res.off('close', abort)
    }
  }
  return {
    server,
    async listen() {
      server.listen(options.port ?? 10108, '127.0.0.1')
      await once(server, 'listening')
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Could not resolve bridge listener')
      return `http://127.0.0.1:${address.port}`
    },
    async close() {
      const done = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      server.closeAllConnections()
      await done
    },
  }
}
