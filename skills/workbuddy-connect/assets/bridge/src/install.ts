/**
 * OpenCodex provider registration for the loopback WorkBuddy bridge.
 *
 * This module deliberately uses OpenCodex's management API instead of editing
 * config.json. POST /api/providers updates the running process, persists the
 * change, and refreshes its catalog as one supported operation.
 */

import { lstat, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

export type OpenCodexRegion = 'cn' | 'global'

export interface OpenCodexInstallOptions {
  bridgeUrl: string
  token: string
  regions?: readonly OpenCodexRegion[]
  /** Defaults to the local OpenCodex management listener. */
  openCodexUrl?: string
  /** Test or portable override; production defaults to OpenCodex's config.json. */
  openCodexConfigPath?: string
}

export interface OpenCodexRemoveOptions {
  bridgeUrl?: string
  regions?: readonly OpenCodexRegion[]
  /** Defaults to the local OpenCodex management listener. */
  openCodexUrl?: string
  /** Test or portable override; production defaults to OpenCodex's config.json. */
  openCodexConfigPath?: string
}

export interface OpenCodexInstallReport {
  provider: string
  region: OpenCodexRegion
  action: 'installed' | 'updated' | 'unchanged'
  models: number
}

export interface OpenCodexRemoveReport {
  provider: string
  region: OpenCodexRegion
  action: 'removed' | 'skipped'
  reason?: 'not_found' | 'not_owned' | 'default_provider'
}

type JsonRecord = Record<string, unknown>

interface OpenCodexProviderSummary {
  name?: unknown
  adapter?: unknown
  baseUrl?: unknown
}

interface BridgeModel {
  id: string
  contextWindow?: number
  inputModalities: string[]
  reasoningEfforts?: string[]
  defaultReasoningEffort?: string
}

const DEFAULT_OPEN_CODEX_URL = 'http://127.0.0.1:10100'
const DEFAULT_REGIONS: readonly OpenCodexRegion[] = ['cn', 'global']
const ADMIN_TOKEN_FILE = 'admin-api-token'
const SUPPORTED_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
const REQUEST_TIMEOUT_MS = 30_000

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function regionsFor(value: readonly OpenCodexRegion[] | undefined): OpenCodexRegion[] {
  const regions = value === undefined ? [...DEFAULT_REGIONS] : [...new Set(value)]
  if (regions.length === 0 || regions.some(region => region !== 'cn' && region !== 'global')) {
    throw new Error('regions must contain cn and/or global')
  }
  return regions
}

function loopbackBaseUrl(value: string, label: string): URL {
  let parsed: URL
  try { parsed = new URL(value) } catch { throw new Error(`${label} must be an absolute HTTP loopback URL`) }
  const hostname = parsed.hostname.toLowerCase()
  const loopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]'
  if (parsed.protocol !== 'http:' || !loopback || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${label} must be an absolute HTTP loopback URL`)
  }
  return parsed
}

function normalizedUrl(value: string): string {
  const url = new URL(value)
  url.pathname = url.pathname.replace(/\/+$/, '') || '/'
  return url.toString().replace(/\/$/, '')
}

function bridgeRegionUrl(bridgeUrl: string, region: OpenCodexRegion): string {
  const bridge = loopbackBaseUrl(bridgeUrl, 'bridgeUrl')
  if (bridge.pathname !== '/' && bridge.pathname !== '') throw new Error('bridgeUrl must not include a path')
  return `${normalizedUrl(bridge.toString())}/${region}/v1`
}

function providerName(region: OpenCodexRegion): string {
  return `workbuddy-${region}`
}

function safePositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function modalitiesFor(row: JsonRecord): string[] {
  const provided = row.input_modalities
  if (Array.isArray(provided)) {
    const normalized = provided.filter((value): value is string => value === 'text' || value === 'image' || value === 'audio')
    if (normalized.length > 0) return [...new Set(normalized)]
  }
  return row.supports_vision === true ? ['text', 'image'] : ['text']
}

function reasoningFor(row: JsonRecord): Pick<BridgeModel, 'reasoningEfforts' | 'defaultReasoningEffort'> {
  if (!isRecord(row.reasoning)) return {}
  const rawEfforts = row.reasoning.supportedEfforts
  const advertised = Array.isArray(rawEfforts)
    ? new Set(rawEfforts.filter((value): value is string => typeof value === 'string' && (SUPPORTED_EFFORTS as readonly string[]).includes(value)))
    : new Set<string>()
  const reasoningEfforts = SUPPORTED_EFFORTS.filter(effort => advertised.has(effort))
  const rawDefault = row.reasoning.defaultEffort
  const defaultReasoningEffort = typeof rawDefault === 'string' && reasoningEfforts.includes(rawDefault)
    ? rawDefault
    : undefined
  return reasoningEfforts.length === 0 ? {} : { reasoningEfforts, ...(defaultReasoningEffort === undefined ? {} : { defaultReasoningEffort }) }
}

function bridgeModels(body: unknown): BridgeModel[] {
  if (!isRecord(body) || !Array.isArray(body.data)) throw new Error('WorkBuddy bridge returned an invalid model catalog')
  const seen = new Set<string>()
  const models: BridgeModel[] = []
  for (const raw of body.data) {
    if (!isRecord(raw) || typeof raw.id !== 'string' || raw.id.trim() === '' || seen.has(raw.id)) continue
    seen.add(raw.id)
    models.push({
      id: raw.id,
      contextWindow: safePositiveInteger(raw.context_window) ?? safePositiveInteger(raw.context_length),
      inputModalities: modalitiesFor(raw),
      ...reasoningFor(raw),
    })
  }
  if (models.length === 0) throw new Error('WorkBuddy bridge returned no usable models')
  return models
}

function metadataFor(models: readonly BridgeModel[]): Pick<JsonRecord, 'models' | 'modelContextWindows' | 'modelInputModalities' | 'modelReasoningEfforts' | 'modelDefaultReasoningEfforts'> {
  const context: Record<string, number> = {}
  const modalities: Record<string, string[]> = {}
  const efforts: Record<string, string[]> = {}
  const defaults: Record<string, string> = {}
  for (const model of models) {
    if (model.contextWindow !== undefined) context[model.id] = model.contextWindow
    modalities[model.id] = model.inputModalities
    if (model.reasoningEfforts !== undefined) efforts[model.id] = model.reasoningEfforts
    if (model.defaultReasoningEffort !== undefined) defaults[model.id] = model.defaultReasoningEffort
  }
  return {
    models: models.map(model => model.id),
    modelContextWindows: context,
    modelInputModalities: modalities,
    modelReasoningEfforts: efforts,
    modelDefaultReasoningEfforts: defaults,
  }
}

/** OpenCodex's documented home override, accepted only as an absolute path. */
function openCodexHome(): string {
  const configured = process.env.OPENCODEX_HOME?.trim()
  return configured !== undefined && configured !== '' && isAbsolute(configured)
    ? configured
    : join(homedir(), '.opencodex')
}

function adminTokenPath(): string {
  return join(openCodexHome(), ADMIN_TOKEN_FILE)
}

async function readAdminToken(): Promise<string> {
  const fromEnvironment = process.env.OPENCODEX_ADMIN_AUTH_TOKEN?.trim()
  if (fromEnvironment) return fromEnvironment
  const path = adminTokenPath()
  try {
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512) throw new Error('invalid')
    const token = (await readFile(path, 'utf8')).trim()
    if (/^ocx_admin_[A-Za-z0-9_-]{43}$/.test(token)) return token
  } catch {
    // The public error below deliberately does not expose the local secret path.
  }
  throw new Error('OpenCodex management token is unavailable')
}

function defaultConfigPath(): string {
  return join(openCodexHome(), 'config.json')
}

function readCurrentProvider(name: string, configPath = defaultConfigPath()): Promise<JsonRecord | undefined> {
  return readFile(configPath, 'utf8').then(text => {
    const parsed: unknown = JSON.parse(text)
    if (!isRecord(parsed) || !isRecord(parsed.providers) || !isRecord(parsed.providers[name])) return undefined
    return structuredClone(parsed.providers[name])
  }).catch(() => undefined)
}

async function readDefaultProvider(configPath = defaultConfigPath()): Promise<string | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(configPath, 'utf8'))
    return isRecord(parsed) && typeof parsed.defaultProvider === 'string' ? parsed.defaultProvider : undefined
  } catch { return undefined }
}

function matchingProvider(summary: OpenCodexProviderSummary | undefined, baseUrl: string): boolean {
  return summary?.adapter === 'openai-chat'
    && typeof summary.baseUrl === 'string'
    && normalizedUrl(summary.baseUrl) === normalizedUrl(baseUrl)
}

async function requestJson(baseUrl: string, path: string, token: string, init: RequestInit = {}): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(`${normalizedUrl(baseUrl)}${path}`, {
      ...init,
      headers: { 'X-OpenCodex-API-Key': token, ...(init.headers ?? {}) },
      signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch {
    throw new Error('OpenCodex management API is unavailable')
  }
  if (!response.ok) throw new Error(`OpenCodex management API rejected the request (HTTP ${response.status})`)
  return response.status === 204 ? undefined : response.json().catch(() => undefined)
}

/** Fetch bridge discovery with the same bounded wait as management requests. */
async function fetchBridgeModels(url: string, token: string, region: OpenCodexRegion): Promise<BridgeModel[]> {
  let response: Response
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch {
    throw new Error(`WorkBuddy ${region} model discovery failed`)
  }
  if (!response.ok) throw new Error(`WorkBuddy ${region} model discovery failed (HTTP ${response.status})`)
  return bridgeModels(await response.json().catch(() => undefined))
}

async function listedProviders(openCodexUrl: string, adminToken: string): Promise<OpenCodexProviderSummary[]> {
  const payload = await requestJson(openCodexUrl, '/api/providers', adminToken)
  if (!Array.isArray(payload)) throw new Error('OpenCodex management API returned an invalid provider list')
  return payload.filter(isRecord)
}

function providerFrom(existing: JsonRecord | undefined, baseUrl: string, token: string, models: readonly BridgeModel[]): JsonRecord {
  const metadata = metadataFor(models)
  const modelIds = metadata.models as string[]
  const retainedDefault = typeof existing?.defaultModel === 'string' && modelIds.includes(existing.defaultModel)
    ? existing.defaultModel
    : modelIds[0]
  return {
    ...(existing ?? {}),
    adapter: 'openai-chat',
    baseUrl,
    authMode: 'key',
    apiKey: token,
    allowPrivateNetwork: true,
    liveModels: true,
    defaultModel: retainedDefault,
    ...metadata,
  }
}

/**
 * Register one provider per selected WorkBuddy region without changing OpenCodex's default route.
 * The bridge catalog is fetched first, so an unavailable region cannot leave a half-formed entry.
 */
export async function installOpenCodex(options: OpenCodexInstallOptions): Promise<OpenCodexInstallReport[]> {
  if (options.token.trim().length < 24) throw new Error('Bridge token must contain at least 24 characters')
  const regions = regionsFor(options.regions)
  const openCodexUrl = normalizedUrl(loopbackBaseUrl(options.openCodexUrl ?? DEFAULT_OPEN_CODEX_URL, 'openCodexUrl').toString())
  const adminToken = await readAdminToken()
  const bridgeCatalogs = await Promise.all(regions.map(async region => {
    return [region, await fetchBridgeModels(`${bridgeRegionUrl(options.bridgeUrl, region)}/models`, options.token, region)] as const
  }))
  const catalogs = new Map<OpenCodexRegion, BridgeModel[]>(bridgeCatalogs)
  const providers = await listedProviders(openCodexUrl, adminToken)
  const reports: OpenCodexInstallReport[] = []
  // Record an attempted write before sending it. A management connection can
  // fail after the remote process persisted the provider, so recording only
  // successful responses would strand partial state.
  const rollback: Array<{ name: string, baseUrl: string, previous?: JsonRecord }> = []

  try {
    for (const region of regions) {
      const name = providerName(region)
      const baseUrl = bridgeRegionUrl(options.bridgeUrl, region)
      const summary = providers.find(provider => provider.name === name)
      if (summary !== undefined && !matchingProvider(summary, baseUrl)) {
        throw new Error(`${name} already belongs to another provider; refusing to overwrite it`)
      }
      const previous = summary === undefined ? undefined : await readCurrentProvider(name, options.openCodexConfigPath)
      if (summary !== undefined && previous === undefined) {
        throw new Error(`${name} could not be backed up safely; refusing to update it`)
      }
      const next = providerFrom(previous, baseUrl, options.token, catalogs.get(region)!)
      if (previous !== undefined && isDeepStrictEqual(previous, next)) {
        reports.push({ provider: name, region, action: 'unchanged', models: (next.models as unknown[]).length })
        continue
      }
      rollback.push({ name, baseUrl, previous })
      await requestJson(openCodexUrl, '/api/providers', adminToken, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, provider: next }),
      })
      reports.push({ provider: name, region, action: previous === undefined ? 'installed' : 'updated', models: (next.models as unknown[]).length })
    }
    return reports
  } catch (error) {
    for (const item of rollback.reverse()) {
      try {
        const current = (await listedProviders(openCodexUrl, adminToken)).find(provider => provider.name === item.name)
        if (!matchingProvider(current, item.baseUrl)) continue
        if (item.previous === undefined) {
          // Use the explicit/portable config path used by this transaction.
          // Never delete a provider if we cannot prove it is not the default.
          const defaultProvider = await readDefaultProvider(options.openCodexConfigPath)
          if (defaultProvider === undefined || defaultProvider === item.name) continue
          await requestJson(openCodexUrl, `/api/providers?name=${encodeURIComponent(item.name)}`, adminToken, { method: 'DELETE' })
        } else {
          await requestJson(openCodexUrl, '/api/providers', adminToken, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: item.name, provider: item.previous }),
          })
        }
      } catch {
        // Preserve the original failure; the caller gets no secret-bearing error detail.
      }
    }
    throw error
  }
}

/** Remove only bridge-shaped WorkBuddy providers and never change the current default provider. */
export async function removeOpenCodex(options: OpenCodexRemoveOptions = {}): Promise<OpenCodexRemoveReport[]> {
  const regions = regionsFor(options.regions)
  const openCodexUrl = normalizedUrl(loopbackBaseUrl(options.openCodexUrl ?? DEFAULT_OPEN_CODEX_URL, 'openCodexUrl').toString())
  const adminToken = await readAdminToken()
  const providers = await listedProviders(openCodexUrl, adminToken)
  const defaultProvider = await readDefaultProvider(options.openCodexConfigPath)
  if (defaultProvider === undefined) throw new Error('OpenCodex default provider could not be confirmed')
  const reports: OpenCodexRemoveReport[] = []

  for (const region of regions) {
    const name = providerName(region)
    const summary = providers.find(provider => provider.name === name)
    if (summary === undefined) {
      reports.push({ provider: name, region, action: 'skipped', reason: 'not_found' })
      continue
    }
    const expectedBaseUrl = options.bridgeUrl === undefined ? undefined : bridgeRegionUrl(options.bridgeUrl, region)
    const ownLoopbackShape = typeof summary.baseUrl === 'string'
      && (() => {
        try {
          const parsed = loopbackBaseUrl(summary.baseUrl, 'provider base URL')
          return parsed.pathname.replace(/\/+$/, '') === `/${region}/v1`
        } catch { return false }
      })()
    if (!(expectedBaseUrl === undefined
      ? summary.adapter === 'openai-chat' && ownLoopbackShape
      : matchingProvider(summary, expectedBaseUrl))) {
      reports.push({ provider: name, region, action: 'skipped', reason: 'not_owned' })
      continue
    }
    if (defaultProvider === name) {
      reports.push({ provider: name, region, action: 'skipped', reason: 'default_provider' })
      continue
    }
    await requestJson(openCodexUrl, `/api/providers?name=${encodeURIComponent(name)}`, adminToken, { method: 'DELETE' })
    reports.push({ provider: name, region, action: 'removed' })
  }
  return reports
}
