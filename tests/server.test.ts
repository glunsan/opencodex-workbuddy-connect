import test from 'node:test'
import assert from 'node:assert/strict'
import { createBridge } from '../src/server.ts'
import { prepareChatBody, regionOf } from '../src/upstream.ts'

const token = 'test-local-token-abcdefghijklmnopqrstuvwxyz'
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
const model = { id: 'sample', name: 'Sample', contextWindow: 128000, maxTokens: 1024, supportsImages: false }
const stores = Object.fromEntries(['cn', 'global'].map(region => [region, {
  async resolve() { return { domain: region, uid: region } },
  async current() { return { domain: region, uid: region } },
  async status() { return { state: 'signed-in', domain: region } },
}])) as any
function sse(chunks: any[], done = true) {
  const text = chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + (done ? 'data: [DONE]\n\n' : '')
  const bytes = new TextEncoder().encode(text)
  return new Response(new ReadableStream({ start(controller) {
    // Splits UTF-8 and SSE markers to exercise real network fragmentation.
    for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3))
    controller.close()
  } }), { headers: { 'Content-Type': 'text/event-stream' } })
}
const textChunks = [
  { id: 'chat-1', model: 'sample', choices: [{ index: 0, delta: { content: '你好' }, finish_reason: null }] },
  { id: 'chat-1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 } },
]
async function fixture(t: any, chatStream?: any) {
  const seen: any[] = []
  const bridge = createBridge({ port: 0, token, stores, client: {
    async fetchModels(c) { seen.push({ catalogRegion: c.domain }); return [model] },
    async fetchCredits() { return { total: 0, accounts: [] } },
    chatStream: chatStream ?? (async (c, body, signal) => {
      assert.equal(signal.aborted, false, 'a fully read request must not abort upstream')
      seen.push({ region: c.domain, body: JSON.parse(body) })
      return { ok: true, response: sse(textChunks) }
    }),
  } })
  const url = await bridge.listen()
  t.after(() => bridge.close())
  return { url, seen }
}
test('separate regions, authentication, browser origin gate and model metadata', async t => {
  const { url, seen } = await fixture(t)
  assert.equal((await fetch(`${url}/healthz`)).status, 401)
  assert.equal((await fetch(`${url}/healthz`, { headers: { ...headers, Origin: 'https://example.com' } })).status, 403)
  for (const region of ['cn', 'global']) {
    const r = await fetch(`${url}/${region}/v1/models`, { headers })
    const data = await r.json()
    assert.equal(r.status, 200)
    assert.equal(data.data[0].owned_by, `workbuddy-${region}`)
    assert.equal(data.data[0].context_length, 128000)
  }
  assert.deepEqual(seen, [{ catalogRegion: 'cn' }, { catalogRegion: 'global' }])
})
test('nonstream request aggregates fragmented SSE, forwards role/tools, and keeps region', async t => {
  const { url, seen } = await fixture(t)
  const response = await fetch(`${url}/global/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify({
    model: 'sample', messages: [{ role: 'developer', content: 'hi' }, { role: 'user', content: 'ping' }],
    stream: false, max_completion_tokens: 12, reasoning_effort: 'ultra',
    tools: [{ type: 'function', function: { name: 'foo', parameters: { type: 'object' } } }],
    tool_choice: { type: 'function', function: { name: 'foo' } },
  }) })
  assert.equal(response.status, 200)
  const answer = await response.json()
  assert.equal(answer.choices[0].message.content, '你好')
  assert.equal(answer.usage.total_tokens, 4)
  const sent = seen.find(row => row.body)
  assert.equal(sent.region, 'global')
  assert.equal(sent.body.messages[0].role, 'system')
  assert.equal(sent.body.tool_choice, 'foo')
  assert.equal(sent.body.stream, true)
  assert.equal(sent.body.max_tokens, 12)
  assert.equal(sent.body.reasoning_effort, undefined)
})
test('streaming preserves tool argument fragments and completion', async t => {
  const chunks = [
    { id: 'chat-tools', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'test', arguments: '{"x":' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] }, finish_reason: 'tool_calls' }] },
  ]
  const { url } = await fixture(t, async () => ({ ok: true, response: sse(chunks) }))
  for (const stream of [false, true]) {
    const res = await fetch(`${url}/cn/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model: 'sample', messages: [{ role: 'user', content: 'test' }], stream }) })
    if (stream) {
      const text = await res.text()
      assert.match(text, /call-1/)
      assert.match(text, /data: \[DONE\]/)
    } else {
      const body = await res.json()
      assert.deepEqual(body.choices[0].message.tool_calls, [{ id: 'call-1', type: 'function', function: { name: 'test', arguments: '{"x":1}' } }])
    }
  }
})
test('global user-first messages receive the required system prefix', async t => {
  const { url, seen } = await fixture(t)
  const response = await fetch(`${url}/global/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model: 'sample', messages: [{ role: 'user', content: 'ping' }], stream: false }) })
  assert.equal(response.status, 200)
  await response.json()
  const body = seen.find(row => row.body).body
  assert.equal(body.messages[0].role, 'system')
  assert.equal(body.messages[1].content, 'ping')
})
test('truncated streams cannot report a successful completion', async t => {
  const { url } = await fixture(t, async () => ({ ok: true, response: sse(textChunks.slice(0, 1), false) }))
  for (const stream of [false, true]) {
    const res = await fetch(`${url}/cn/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model: 'sample', messages: [{ role: 'user', content: 'test' }], stream }) })
    if (!stream) assert.equal(res.status, 502)
    else {
      const text = await res.text()
      assert.match(text, /upstream_stream_error/)
      assert.doesNotMatch(text, /\[DONE\]/)
    }
  }
})
test('reject unsupported image input before generating and map upstream credit errors', async t => {
  let calls = 0
  const { url } = await fixture(t, async () => { calls++; return { ok: false, status: 402, kind: 'hard_credit', message: 'private upstream body' } })
  const image = await fetch(`${url}/cn/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model: 'sample', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,x' } }] }] }) })
  assert.equal(image.status, 400)
  assert.equal(calls, 0)
  const credit = await fetch(`${url}/cn/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model: 'sample', messages: [{ role: 'user', content: 'test' }] }) })
  assert.equal(credit.status, 402)
  assert.doesNotMatch(await credit.text(), /private upstream body/)
})
test('normalization retains tool results and reasoning history; domains select independently', () => {
  const body = { model: 'sample', messages: [{ role: 'assistant', content: null, reasoning_content: 'reason', tool_calls: [{ id: 'call' }] }, { role: 'tool', tool_call_id: 'call', content: 'result' }], tool_choice: 'none', tools: [{}] }
  const out = JSON.parse(prepareChatBody(JSON.stringify(body)))
  assert.deepEqual(out.messages, body.messages)
  assert.equal(out.tools, undefined)
  assert.equal(regionOf('www.workbuddy.ai'), 'global')
  assert.equal(regionOf('www.codebuddy.cn'), 'cn')
})
