import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { parseWorkBuddyAuth, RegionCredentialStore } from '../src/auth.ts'

function desktop(uid: string, domain: string, expiresAt = Date.now() + 3_600_000, enterpriseId?: string): string {
  return JSON.stringify({ auth: { accessToken: `access-${uid}`, refreshToken: `refresh-${uid}`, expiresAt, domain }, account: { uid, ...(enterpriseId === undefined ? {} : { enterpriseId }) } })
}

async function fixture(): Promise<{ root: string, auth: string, state: string }> {
  // Keep test state under the project so it also works in sandboxed Windows CI.
  const root = await mkdtemp(join(process.cwd(), '.test-workbuddy-auth-'))
  return { root, auth: join(root, 'desktop.info'), state: join(root, 'state') }
}

test('parses nested desktop credentials and normalizes second expiry', () => {
  const value = parseWorkBuddyAuth(JSON.stringify({ auth: { accessToken: 'a', refreshToken: 'r', expiresAt: 1_792_128_236, domain: 'www.workbuddy.ai' }, account: { uid: 'u' } }))
  assert.equal(value?.expiresAtMs, 1_792_128_236_000)
  assert.equal(value?.uid, 'u')
  assert.equal(value?.source, 'desktop')
})

test('keeps CN and global cache files separate', async () => {
  const f = await fixture()
  try {
    await writeFile(f.auth, desktop('cn-user', 'www.codebuddy.cn', Date.now() - 1))
    const cn = new RegionCredentialStore({ region: 'cn', desktopPath: f.auth, stateDir: f.state, refresh: async () => ({ accessToken: 'cn-new', expiresInSec: 3600 }) })
    await assert.doesNotReject(() => cn.resolve())
    await writeFile(f.auth, desktop('global-user', 'www.workbuddy.ai', Date.now() - 1))
    const global = new RegionCredentialStore({ region: 'global', desktopPath: f.auth, stateDir: f.state, refresh: async () => ({ accessToken: 'global-new', expiresInSec: 3600 }) })
    await assert.doesNotReject(() => global.resolve())
    assert.notEqual(cn.cacheFile(), global.cacheFile())
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('desktop uid/domain invalidates a cache created for another account', async () => {
  const f = await fixture()
  try {
    await writeFile(f.auth, desktop('alice', 'www.codebuddy.cn', Date.now() - 1))
    const store = new RegionCredentialStore({ region: 'cn', desktopPath: f.auth, stateDir: f.state, refresh: async credential => ({ accessToken: `${credential.uid}-new`, expiresInSec: 3600 }) })
    assert.equal((await store.resolve()).accessToken, 'alice-new')
    await writeFile(f.auth, desktop('bob', 'www.codebuddy.cn'))
    assert.equal((await store.current())?.accessToken, 'access-bob')
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('desktop enterprise invalidates a cache created for a different tenant', async () => {
  const f = await fixture()
  try {
    await writeFile(f.auth, desktop('alice', 'www.codebuddy.cn', Date.now() - 1, 'tenant-a'))
    const store = new RegionCredentialStore({ region: 'cn', desktopPath: f.auth, stateDir: f.state, refresh: async () => ({ accessToken: 'tenant-a-new', expiresInSec: 3600 }) })
    await store.resolve()
    await writeFile(f.auth, desktop('alice', 'www.codebuddy.cn', Date.now() + 3_600_000, 'tenant-b'))
    assert.equal((await store.current())?.accessToken, 'access-alice')
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('desktop logout disables a persisted cache immediately', async () => {
  const f = await fixture()
  try {
    await writeFile(f.auth, desktop('alice', 'www.codebuddy.cn', Date.now() - 1))
    const store = new RegionCredentialStore({ region: 'cn', desktopPath: f.auth, stateDir: f.state, refresh: async () => ({ accessToken: 'new', expiresInSec: 3600 }) })
    await store.resolve()
    await rm(f.auth)
    assert.equal(await store.current(), undefined)
    await assert.rejects(() => store.resolve(), /no matching signed-in desktop account/)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('refresh cache stays private and desktop auth is never modified', async () => {
  const f = await fixture()
  try {
    const original = desktop('alice', 'www.codebuddy.cn', Date.now() - 1)
    await writeFile(f.auth, original)
    const store = new RegionCredentialStore({ region: 'cn', desktopPath: f.auth, stateDir: f.state, refresh: async () => ({ accessToken: 'new', refreshToken: 'new-refresh', expiresInSec: 3600 }) })
    await store.resolve()
    assert.equal(await readFile(f.auth, 'utf8'), original)
    const saved = JSON.parse(await readFile(store.cacheFile(), 'utf8')) as { credential: { accessToken: string } }
    assert.equal(saved.credential.accessToken, 'new')
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

function deferred<T>(): { promise: Promise<T>, resolve(value: T): void } {
  let settle: (value: T) => void = () => {}
  return { promise: new Promise<T>(resolve => { settle = resolve }), resolve: settle }
}

test('account switch during refresh discards the old result and resolves the new desktop account', async () => {
  const f = await fixture()
  try {
    const gate = deferred<{ accessToken: string, expiresInSec: number }>()
    const started = deferred<void>()
    await writeFile(f.auth, desktop('alice', 'www.codebuddy.cn', Date.now() - 1))
    const store = new RegionCredentialStore({ region: 'cn', desktopPath: f.auth, stateDir: f.state, refresh: async () => { started.resolve(); return gate.promise } })
    const pending = store.resolve()
    await started.promise
    await writeFile(f.auth, desktop('bob', 'www.codebuddy.cn'))
    gate.resolve({ accessToken: 'alice-refreshed', expiresInSec: 3600 })
    assert.equal((await pending).accessToken, 'access-bob')
    await assert.rejects(() => readFile(store.cacheFile(), 'utf8'), { code: 'ENOENT' })
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('logout during refresh rejects and never returns the stale credential', async () => {
  const f = await fixture()
  try {
    const gate = deferred<{ accessToken: string, expiresInSec: number }>()
    const started = deferred<void>()
    await writeFile(f.auth, desktop('alice', 'www.codebuddy.cn', Date.now() - 1))
    const store = new RegionCredentialStore({ region: 'cn', desktopPath: f.auth, stateDir: f.state, refresh: async () => { started.resolve(); return gate.promise } })
    const pending = store.resolve()
    await started.promise
    await rm(f.auth)
    gate.resolve({ accessToken: 'alice-refreshed', expiresInSec: 3600 })
    await assert.rejects(() => pending, /no matching signed-in desktop account/)
    await assert.rejects(() => readFile(store.cacheFile(), 'utf8'), { code: 'ENOENT' })
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('status returns account state without access or refresh tokens', async () => {
  const f = await fixture()
  try {
    await writeFile(f.auth, desktop('alice', 'www.codebuddy.cn'))
    const store = new RegionCredentialStore({ region: 'cn', desktopPath: f.auth, stateDir: f.state, refresh: async () => ({ accessToken: 'unused' }) })
    const status = await store.status()
    assert.deepEqual(Object.keys(status).sort(), ['domain', 'expiresAtMs', 'region', 'source', 'state'])
    assert.equal(JSON.stringify(status).includes('access-alice'), false)
    assert.equal(JSON.stringify(status).includes('refresh-alice'), false)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})
