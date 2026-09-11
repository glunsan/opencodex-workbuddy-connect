#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { homedir } from 'node:os'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { RegionCredentialStore } from './auth.ts'
import { WorkBuddyUpstreamClient } from './upstream.ts'
import { createBridge, type Region } from './server.ts'
import { writeJsonAtomic } from './storage.ts'
import type { OpenCodexRemoveReport } from './install.ts'

export type RegionChoice = 'auto' | 'cn' | 'global' | 'both'
export type State = { version: 1; token: string; port: number }

type ParsedArgs = ReturnType<typeof parseArgs>
let args: ParsedArgs
let command: string
let stateDir: string
let stateFile: string

function initializeArguments(): void {
  args = parseArgs({ allowPositionals: true, options: {
    'state-dir': { type: 'string' }, port: { type: 'string' }, region: { type: 'string' },
    model: { type: 'string' }, prompt: { type: 'string' }, 'opencodex-url': { type: 'string' },
  } })
  command = args.positionals[0] ?? 'status'
  stateDir = resolve(args.values['state-dir'] ?? process.env.WORKBUDDY_BRIDGE_HOME ?? join(homedir(), '.opencodex', 'workbuddy-connect'))
  stateFile = join(stateDir, 'bridge.json')
}

export function parseRegionChoice(value: string | undefined): RegionChoice {
  const choice = value ?? 'auto'
  if (choice === 'auto' || choice === 'cn' || choice === 'global' || choice === 'both') return choice
  throw new Error('Region must be auto, cn, global, or both')
}

export function signedInRegions(status: Record<Region, { state?: unknown }>): Region[] {
  return (['cn', 'global'] as const).filter(region => status[region]?.state === 'signed-in')
}

export function removalIsBlocked(reports: readonly OpenCodexRemoveReport[]): boolean {
  return reports.some(report => report.action === 'skipped' && (report.reason === 'default_provider' || report.reason === 'not_owned'))
}

function portFromArgs(): number | undefined {
  if (args.values.port === undefined) return undefined
  const port = Number(args.values.port)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Port must be between 1024 and 65535')
  return port
}

async function state(create = false): Promise<State> {
  const requestedPort = portFromArgs()
  try {
    const data = JSON.parse(await readFile(stateFile, 'utf8'))
    if (data.version !== 1 || typeof data.token !== 'string' || data.token.length < 24 || !Number.isInteger(data.port)) throw new Error('Invalid bridge state')
    if (requestedPort !== undefined && requestedPort !== data.port) {
      throw new Error(`Bridge state already uses port ${data.port}; choose that port or remove only this bridge state first`)
    }
    return data
  } catch (error: any) {
    if (error.code !== 'ENOENT' || !create) throw error
    const port = requestedPort ?? 10108
    const data: State = { version: 1, token: randomBytes(32).toString('base64url'), port }
    await mkdir(stateDir, { recursive: true, mode: 0o700 })
    try { await writeFile(stateFile, JSON.stringify(data), { flag: 'wx', mode: 0o600 }) }
    catch (cause: any) { if (cause.code === 'EEXIST') return state(); throw cause }
    return data
  }
}

function storesFor(directory: string): Record<Region, RegionCredentialStore> {
  const client = new WorkBuddyUpstreamClient()
  return Object.fromEntries((['cn', 'global'] as const).map(region => [region, new RegionCredentialStore({
    region, stateDir: directory,
    desktopPath: process.env[region === 'cn' ? 'WORKBUDDY_CN_AUTH_FILE' : 'WORKBUDDY_GLOBAL_AUTH_FILE'],
    refresh: credential => client.refreshToken(credential),
  })])) as Record<Region, RegionCredentialStore>
}

async function selectedInstallRegions(choice: RegionChoice): Promise<Region[]> {
  const stores = storesFor(stateDir)
  const statuses = Object.fromEntries(await Promise.all((['cn', 'global'] as const).map(async region => [region, await stores[region].status()]))) as Record<Region, { state: string }>
  const selected: Region[] = choice === 'auto' ? signedInRegions(statuses) : choice === 'both' ? ['cn', 'global'] : [choice]
  const missing = selected.filter(region => statuses[region].state !== 'signed-in')
  if (missing.length > 0) throw new Error(`No signed-in WorkBuddy desktop account for: ${missing.join(', ')}. Sign in there first, then retry.`)
  if (selected.length === 0) throw new Error('No signed-in WorkBuddy CN or Global desktop account was found. Sign in to one region first.')
  return selected
}

async function assertOpenCodexRunning(url: string): Promise<void> {
  let response: Response
  try { response = await fetch(`${url.replace(/\/$/, '')}/healthz`, { signal: AbortSignal.timeout(3000) }) }
  catch { throw new Error(`OpenCodex is not running at ${url}. Start OpenCodex first, then retry.`) }
  const body = await response.json().catch(() => undefined) as { service?: unknown } | undefined
  if (!response.ok || body?.service !== 'opencodex') throw new Error(`OpenCodex is not ready at ${url}. Start OpenCodex first, then retry.`)
}

export async function main(): Promise<void> {
  initializeArguments()
  if (command === 'help') {
    console.log('node src/cli.ts <serve|status|accounts|models|install|remove|smoke> [--state-dir PATH] [--port 10108] [--region auto|cn|global|both] [--model ID]')
    return
  }
  if (command === 'accounts') {
    const stores = storesFor(stateDir)
    const regions = await Promise.all((['cn', 'global'] as const).map(async region => {
      const status = await stores[region].status()
      return { region, state: status.state, ...(status.domain === undefined ? {} : { domain: status.domain }), ...(status.expiresAtMs === undefined ? {} : { expiresAtMs: status.expiresAtMs }) }
    }))
    console.log(JSON.stringify({ regions }, null, 2))
    return
  }
  const config = await state(command === 'serve')
  const baseUrl = `http://127.0.0.1:${config.port}`
  const headers = { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' }
  const regionChoice = parseRegionChoice(args.values.region)
  const request = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(`${baseUrl}${path}`, { ...init, headers, signal: AbortSignal.timeout(command === 'smoke' ? 180_000 : 60_000) })
    const body = await response.json().catch(() => undefined) as any
    if (!response.ok) throw new Error(`Bridge HTTP ${response.status}: ${body?.error?.message ?? 'request failed'}`)
    return body
  }
  if (command === 'serve') {
    const stores = storesFor(stateDir)
    const bridge = createBridge({ token: config.token, port: config.port, stores, client: new WorkBuddyUpstreamClient() })
    const url = await bridge.listen()
    await writeJsonAtomic(join(stateDir, 'runtime.json'), { pid: process.pid, url, startedAt: new Date().toISOString() })
    console.log(JSON.stringify({ service: 'opencodex-workbuddy-connect', url, pid: process.pid }))
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void bridge.close().then(() => process.exit(0)) })
    return
  }
  if (command === 'status') {
    console.log(JSON.stringify({ ...(await request('/healthz')), ...(await request('/status')) }, null, 2)); return
  }
  if (command === 'models') {
    const regions: Region[] = regionChoice === 'auto' || regionChoice === 'both' ? ['cn', 'global'] : [regionChoice]
    for (const region of regions) {
      try { console.log(JSON.stringify({ region, ...(await request(`/${region}/v1/models`)) }, null, 2)) }
      catch (error: any) { console.log(JSON.stringify({ region, error: error.message })); process.exitCode = 1 }
    }
    return
  }
  if (command === 'install') {
    const openCodexUrl = args.values['opencodex-url'] ?? 'http://127.0.0.1:10100'
    await assertOpenCodexRunning(openCodexUrl)
    const regions = await selectedInstallRegions(regionChoice)
    const { installOpenCodex } = await import('./install.ts')
    console.log(JSON.stringify(await installOpenCodex({ bridgeUrl: baseUrl, token: config.token, regions, openCodexUrl }), null, 2))
    return
  }
  if (command === 'remove') {
    const regions: Region[] = regionChoice === 'auto' || regionChoice === 'both' ? ['cn', 'global'] : [regionChoice]
    const { removeOpenCodex } = await import('./install.ts')
    const reports = await removeOpenCodex({ bridgeUrl: baseUrl, regions, openCodexUrl: args.values['opencodex-url'] ?? 'http://127.0.0.1:10100' })
    console.log(JSON.stringify(reports, null, 2))
    if (removalIsBlocked(reports)) process.exitCode = 2
    return
  }
  if (command === 'smoke') {
    if ((regionChoice !== 'cn' && regionChoice !== 'global') || !args.values.model) throw new Error('smoke requires --region cn|global --model ID')
    const body = await request(`/${regionChoice}/v1/chat/completions`, {
      method: 'POST', body: JSON.stringify({ model: args.values.model, messages: [{ role: 'user', content: args.values.prompt ?? 'Reply exactly WORKBUDDY_OK.' }], stream: false, max_tokens: 64 }),
    })
    console.log(JSON.stringify({ region: regionChoice, model: args.values.model, text: body.choices?.[0]?.message?.content, finish_reason: body.choices?.[0]?.finish_reason, usage: body.usage }, null, 2))
    return
  }
  throw new Error(`Unknown command: ${command}`)
}

const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href
if (invokedPath === import.meta.url) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
