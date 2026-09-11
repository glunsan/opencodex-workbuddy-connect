/**
 * Read WorkBuddy desktop credentials without modifying the desktop app, then
 * keep a region- and account-bound refresh cache inside the bridge state dir.
 */

import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { homedir, release } from 'node:os'
import { basename, join } from 'node:path'
import { readJsonFile, writeJsonAtomic } from './storage.ts'

export type WorkBuddyRegion = 'cn' | 'global'

export interface WorkBuddyCredential {
  accessToken: string
  refreshToken: string
  expiresAtMs: number
  refreshExpiresAtMs?: number
  domain: string
  uid: string
  enterpriseId?: string
  nickname?: string
  /** The active desktop file always anchors use of a cached credential. */
  source: 'desktop' | 'cache'
}

export interface WorkBuddyRefreshOutcome {
  accessToken: string
  refreshToken?: string
  expiresInSec?: number
  domain?: string
}

/** Safe credential summary for local health/status routes; contains no tokens. */
export interface WorkBuddyAuthStatus {
  state: 'signed-in' | 'signed-out'
  region: WorkBuddyRegion
  expiresAtMs?: number
  domain?: string
  nickname?: string
  source?: WorkBuddyCredential['source']
}

export interface RegionCredentialStoreOptions {
  region: WorkBuddyRegion
  /** Overrides platform discovery for this region's desktop credential file. */
  desktopPath?: string
  /** Bridge-owned directory. Credentials are never written beside desktop auth. */
  stateDir: string
  refresh: (credential: WorkBuddyCredential) => Promise<WorkBuddyRefreshOutcome>
  refreshMarginMs?: number
}

interface CacheDocument {
  version: 1
  region: WorkBuddyRegion
  /** Hash of the currently signed-in desktop identity, never a token. */
  desktopAccount: string
  credential: WorkBuddyCredential
}

const DESKTOP_AUTH_RELATIVE_PATH = ['CodeBuddyExtension', 'Data', 'Public', 'auth'] as const
const FILE_BY_REGION: Readonly<Record<WorkBuddyRegion, string>> = {
  cn: 'workbuddy-desktop.info',
  global: 'workbuddy-desktop-ai.info',
}

function isWsl(): boolean {
  return process.platform === 'linux'
    && (process.env.WSL_DISTRO_NAME !== undefined || process.env.WSL_INTEROP !== undefined || release().toLowerCase().includes('microsoft'))
}

function windowsPathForWsl(value: string | undefined): string | undefined {
  const path = value?.trim()
  if (path === undefined || path === '') return undefined
  if (path.startsWith('/')) return path
  const match = /^([a-z]):[\\/](.*)$/iu.exec(path)
  return match === null ? undefined : join('/mnt', match[1]!.toLowerCase(), ...match[2]!.split(/[\\/]+/u))
}

/** Platform candidates for one login region, ordered Local AppData then Roaming. */
export function defaultDesktopAuthCandidates(region: WorkBuddyRegion): string[] {
  const home = homedir()
  const tail = [...DESKTOP_AUTH_RELATIVE_PATH, FILE_BY_REGION[region]]
  if (process.platform === 'darwin') return [join(home, 'Library', 'Application Support', ...tail)]
  if (process.platform === 'win32') {
    return [join(home, 'AppData', 'Local', ...tail), join(home, 'AppData', 'Roaming', ...tail)]
  }
  if (process.platform !== 'linux') return []
  const linux = join(home, '.config', ...tail)
  if (!isWsl()) return [linux]
  const profile = windowsPathForWsl(process.env.USERPROFILE) ?? join('/mnt/c/Users', basename(home))
  const local = windowsPathForWsl(process.env.LOCALAPPDATA) ?? join(profile, 'AppData', 'Local')
  const roaming = windowsPathForWsl(process.env.APPDATA) ?? join(profile, 'AppData', 'Roaming')
  return [join(local, ...tail), join(roaming, ...tail), linux]
}

function expiryToMs(value: unknown): number {
  if (typeof value !== 'number' || value <= 0) return 0
  return value > 1e12 ? value : value * 1000
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Parse either observed WorkBuddy desktop-auth shape; never throws on bad JSON. */
export function parseWorkBuddyAuth(text: string): WorkBuddyCredential | undefined {
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return undefined }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const document = parsed as Record<string, unknown>
  const auth = typeof document.auth === 'object' && document.auth !== null && !Array.isArray(document.auth)
    ? document.auth as Record<string, unknown> : document
  const identity = auth === document ? document
    : typeof document.account === 'object' && document.account !== null && !Array.isArray(document.account)
      ? document.account as Record<string, unknown> : {}
  const accessToken = optionalString(auth.accessToken)
  if (accessToken === undefined) return undefined
  const refreshExpiresAtMs = expiryToMs(auth.refreshExpiresAt)
  const enterpriseId = optionalString(identity.enterpriseId)
  const nickname = optionalString(identity.nickname)
  return {
    accessToken,
    refreshToken: optionalString(auth.refreshToken) ?? '',
    expiresAtMs: expiryToMs(auth.expiresAt),
    ...(refreshExpiresAtMs > 0 ? { refreshExpiresAtMs } : {}),
    domain: optionalString(auth.domain) ?? '',
    uid: optionalString(identity.uid) ?? '',
    ...(enterpriseId === undefined ? {} : { enterpriseId }),
    ...(nickname === undefined ? {} : { nickname }),
    source: 'desktop',
  }
}

/** Region decision shared with the standalone upstream module. */
export function regionOf(domain: string): WorkBuddyRegion {
  const normalized = domain.trim().toLowerCase()
  return normalized === 'workbuddy.ai' || normalized.endsWith('.workbuddy.ai') ? 'global' : 'cn'
}

function accountFingerprint(region: WorkBuddyRegion, credential: WorkBuddyCredential): string | undefined {
  if (credential.uid === '') return undefined
  return createHash('sha256')
    .update(`${region}\u0000${credential.domain.trim().toLowerCase()}\u0000${credential.uid}\u0000${credential.enterpriseId ?? ''}`)
    .digest('hex')
}

function cachePath(stateDir: string, region: WorkBuddyRegion): string {
  return join(stateDir, `workbuddy-${region}-auth.json`)
}

function isCredential(value: unknown): value is WorkBuddyCredential {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.accessToken === 'string' && candidate.accessToken !== ''
    && typeof candidate.refreshToken === 'string'
    && typeof candidate.expiresAtMs === 'number'
    && typeof candidate.domain === 'string'
    && typeof candidate.uid === 'string'
}

/**
 * Region-isolated credential resolver. A desktop credential must exist for
 * every request: deleting/logging out of the desktop file invalidates cache
 * use immediately. Only a matching uid+domain cache can supersede it.
 */
export class RegionCredentialStore {
  private readonly path: string
  private readonly refresh: RegionCredentialStoreOptions['refresh']
  private readonly margin: number
  private readonly desktopPath?: string
  private readonly options: RegionCredentialStoreOptions
  /** A refresh may be shared only by calls anchored to the same desktop account. */
  private inflight: { account: string, promise: Promise<WorkBuddyCredential> } | undefined

  constructor(options: RegionCredentialStoreOptions) {
    this.options = options
    this.path = cachePath(options.stateDir, options.region)
    this.refresh = options.refresh
    this.margin = options.refreshMarginMs ?? 5 * 60_000
    this.desktopPath = options.desktopPath
  }

  cacheFile(): string { return this.path }
  desktopCandidates(): string[] { return this.desktopPath === undefined ? defaultDesktopAuthCandidates(this.options.region) : [this.desktopPath] }

  /** Current credential without refresh. A missing desktop login means signed out. */
  async current(): Promise<WorkBuddyCredential | undefined> {
    return (await this.currentAnchored())?.credential
  }

  async resolve(): Promise<WorkBuddyCredential> {
    const current = await this.currentAnchored()
    if (current === undefined) throw this.signedOutError()
    if (current.credential.expiresAtMs > Date.now() + this.margin) return current.credential
    // Credentials without a uid cannot be safely tied to a durable cache. They
    // still refresh for this call, but are deliberately not shared or persisted.
    if (current.account === undefined) return this.refreshNow(current)
    if (this.inflight?.account === current.account) return this.inflight.promise
    const promise = this.refreshNow(current).finally(() => {
      if (this.inflight?.promise === promise) this.inflight = undefined
    })
    this.inflight = { account: current.account, promise }
    return promise
  }

  /** Read-only status: caller can display account state without receiving tokens. */
  async status(): Promise<WorkBuddyAuthStatus> {
    const current = await this.currentAnchored()
    if (current === undefined) return { state: 'signed-out', region: this.options.region }
    const credential = current.credential
    return {
      state: 'signed-in',
      region: this.options.region,
      expiresAtMs: credential.expiresAtMs,
      ...(credential.domain === '' ? {} : { domain: credential.domain }),
      ...(credential.nickname === undefined ? {} : { nickname: credential.nickname }),
      source: credential.source,
    }
  }

  private signedOutError(): Error {
    return new Error(`workbuddy ${this.options.region}: no matching signed-in desktop account found`)
  }

  private async refreshNow(start: { desktop: WorkBuddyCredential, account?: string, credential: WorkBuddyCredential }): Promise<WorkBuddyCredential> {
    const { credential } = start
    if (credential.refreshToken === '') {
      if (credential.expiresAtMs > Date.now() + 30_000) return credential
      throw new Error(`workbuddy ${this.options.region}: access token expired; sign in again in the desktop app`)
    }
    try {
      const refreshed = await this.refresh(credential)
      const refreshedCredential: WorkBuddyCredential = {
        ...credential,
        accessToken: refreshed.accessToken,
        ...(refreshed.refreshToken === undefined ? {} : { refreshToken: refreshed.refreshToken }),
        expiresAtMs: refreshed.expiresInSec === undefined ? credential.expiresAtMs : Date.now() + refreshed.expiresInSec * 1000,
        source: 'cache',
      }
      const now = await this.currentAnchored()
      // A refresh result belongs exclusively to its initiating desktop identity.
      // On logout or an account/tenant/domain switch, discard it and resolve the
      // current desktop state from scratch; never return or cache the old token.
      if (now === undefined) throw this.signedOutError()
      if (now.account !== start.account) return this.resolve()
      // The desktop identity wins over any stale cached profile details.
      const next: WorkBuddyCredential = {
        ...refreshedCredential,
        domain: now.desktop.domain,
        uid: now.desktop.uid,
        ...(now.desktop.enterpriseId === undefined ? {} : { enterpriseId: now.desktop.enterpriseId }),
        ...(now.desktop.nickname === undefined ? {} : { nickname: now.desktop.nickname }),
      }
      if (start.account !== undefined) {
        await writeJsonAtomic(this.path, { version: 1, region: this.options.region, desktopAccount: start.account, credential: next } satisfies CacheDocument)
      }
      return next
    } catch (error: unknown) {
      // A failed old-account refresh cannot fall back to a token after the
      // desktop account changed or signed out while the request was in flight.
      const now = await this.currentAnchored()
      if (now === undefined) throw this.signedOutError()
      if (now.account !== start.account) return this.resolve()
      if (now.credential.expiresAtMs > Date.now() + 30_000) return now.credential
      throw error
    }
  }

  /** Desktop anchor plus the only cache that is permitted to shadow it. */
  private async currentAnchored(): Promise<{ desktop: WorkBuddyCredential, account?: string, credential: WorkBuddyCredential } | undefined> {
    const desktop = await this.readDesktop()
    if (desktop === undefined || regionOf(desktop.domain) !== this.options.region) return undefined
    const account = accountFingerprint(this.options.region, desktop)
    if (account === undefined) return { desktop, credential: desktop }
    const cached = await this.readCache(account)
    const credential = cached === undefined || cached.expiresAtMs <= desktop.expiresAtMs
      ? desktop
      : { ...cached, source: 'cache' as const }
    return { desktop, account, credential }
  }

  private async readDesktop(): Promise<WorkBuddyCredential | undefined> {
    const { readFile } = await import('node:fs/promises')
    for (const path of this.desktopCandidates()) {
      try { return parseWorkBuddyAuth(await readFile(path, 'utf8')) } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') throw error
      }
    }
    return undefined
  }

  private async readCache(expectedAccount: string): Promise<WorkBuddyCredential | undefined> {
    const value = await readJsonFile(this.path)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
    const document = value as Partial<CacheDocument>
    if (document.version !== 1 || document.region !== this.options.region || document.desktopAccount !== expectedAccount || !isCredential(document.credential)) return undefined
    // The cache document's label is not enough: reject a manually stale or
    // malformed payload whose credential identity does not match that label.
    if (accountFingerprint(this.options.region, document.credential) !== expectedAccount) return undefined
    return document.credential
  }

  /** Diagnostic only; true if any region candidate is a file. */
  async desktopFilePresent(): Promise<boolean> {
    for (const path of this.desktopCandidates()) {
      try { if ((await stat(path)).isFile()) return true } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') throw error
      }
    }
    return false
  }
}
