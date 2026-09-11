import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const target = path.join(root, 'skills/workbuddy-connect/assets/bridge')
const check = process.argv.includes('--check')
const entries = [
  'src', 'tests', 'package.json', 'README.md', 'LICENSE', 'NOTICE.md',
  'scripts/Start-Bridge.ps1', 'scripts/Install.ps1', 'scripts/Uninstall.ps1',
  'Install.cmd', 'Start-Bridge.cmd', 'Uninstall.cmd',
]
async function walk(relative) {
  const stat = await fs.lstat(path.join(root, relative))
  if (stat.isSymbolicLink()) throw new Error(`Refusing symlink: ${relative}`)
  if (!stat.isDirectory()) return [relative.replaceAll('\\', '/')]
  const files = await fs.readdir(path.join(root, relative))
  return (await Promise.all(files.sort().map(name => walk(path.join(relative, name))))).flat()
}
const files = (await Promise.all(entries.map(walk))).flat().sort()
const hashes = {}
for (const relative of files) {
  const original = await fs.readFile(path.join(root, relative))
  hashes[relative] = crypto.createHash('sha256').update(original).digest('hex')
  const destination = path.join(target, relative)
  if (check) {
    const current = await fs.readFile(destination).catch(() => null)
    if (!current?.equals(original)) throw new Error(`Skill runtime is out of date: ${relative}; run npm run build:skill`)
  } else {
    await fs.mkdir(path.dirname(destination), { recursive: true })
    await fs.writeFile(destination, original)
  }
}
const manifest = JSON.stringify({ version: 1, files: hashes }, null, 2) + '\n'
const manifestPath = path.join(target, 'bundle-manifest.json')
if (check) {
  if (await fs.readFile(manifestPath, 'utf8') !== manifest) throw new Error('Skill manifest is out of date')
} else await fs.writeFile(manifestPath, manifest)
console.log(`${check ? 'Verified' : 'Bundled'} ${files.length} runtime files in the self-contained skill.`)
