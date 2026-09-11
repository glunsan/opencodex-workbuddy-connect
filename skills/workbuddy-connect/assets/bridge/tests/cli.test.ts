import assert from 'node:assert/strict'
import test from 'node:test'
import { parseRegionChoice, removalIsBlocked, signedInRegions } from '../src/cli.ts'

test('auto selection uses only regions with a read-only signed-in status', () => {
  assert.deepEqual(signedInRegions({
    cn: { state: 'signed-in' },
    global: { state: 'signed-out' },
  }), ['cn'])
  assert.deepEqual(signedInRegions({
    cn: { state: 'signed-out' },
    global: { state: 'signed-in' },
  }), ['global'])
  assert.deepEqual(signedInRegions({
    cn: { state: 'signed-out' },
    global: { state: 'signed-out' },
  }), [])
})

test('region choices support explicit one, both, and auto only', () => {
  assert.equal(parseRegionChoice(undefined), 'auto')
  assert.equal(parseRegionChoice('both'), 'both')
  assert.throws(() => parseRegionChoice('all'), /auto, cn, global, or both/)
})

test('uninstall does not continue after ownership or default protection skips removal', () => {
  assert.equal(removalIsBlocked([{ provider: 'workbuddy-cn', region: 'cn', action: 'skipped', reason: 'not_found' }]), false)
  assert.equal(removalIsBlocked([{ provider: 'workbuddy-cn', region: 'cn', action: 'skipped', reason: 'not_owned' }]), true)
  assert.equal(removalIsBlocked([{ provider: 'workbuddy-cn', region: 'cn', action: 'skipped', reason: 'default_provider' }]), true)
})
