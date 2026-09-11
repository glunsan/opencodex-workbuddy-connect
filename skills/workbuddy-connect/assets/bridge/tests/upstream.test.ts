import test from 'node:test'
import assert from 'node:assert/strict'
import { WorkBuddyUpstreamClient } from '../src/upstream.ts'

test('CN and global model discovery use their respective real client paths', async () => {
  const original = globalThis.fetch
  const urls: string[] = []
  globalThis.fetch = (async (url: any) => {
    urls.push(String(url))
    return Response.json({ code: 0, data: { models: [{ id: 'test', maxInputTokens: 100, maxOutputTokens: 10 }], agents: [{ name: 'cli', models: ['test'] }] } })
  }) as typeof fetch
  try {
    const client = new WorkBuddyUpstreamClient()
    for (const domain of ['www.codebuddy.cn', 'www.workbuddy.ai']) await client.fetchModels({ domain, accessToken: 'fixture', uid: 'fixture', expiresAtMs: 1, refreshToken: '', source: 'desktop' })
    assert.deepEqual(urls, ['https://copilot.tencent.com/console/enterprises/personal/models', 'https://www.workbuddy.ai/v2/enterprises/personal/models'])
  } finally { globalThis.fetch = original }
})
