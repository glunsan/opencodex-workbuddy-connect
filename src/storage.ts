/** Small dependency-free JSON storage helpers for the local bridge. */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'

/** Read JSON, returning undefined only when the file does not exist or is invalid. */
export async function readJsonFile(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return undefined
    if (error instanceof SyntaxError) return undefined
    throw error
  }
}

/**
 * Atomically replace a private JSON file. The temporary file is in the target
 * directory, so rename is atomic on normal local filesystems.
 */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const directory = dirname(path)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = join(directory, `.${randomBytes(12).toString('hex')}.tmp`)
  const content = `${JSON.stringify(value, null, 2)}\n`
  try {
    await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true }).catch(() => {})
  }
}
