import { createHash } from 'node:crypto'

const cursorVersion = 1
const cursorModes = new Set(['semantic', 'lexical'])

/**
 * @param {{
 *   query: string,
 *   type?: string,
 *   excludedFilenames?: Iterable<string>
 * }} options
 */
export const searchContextFingerprint = ({
  query,
  type = '',
  excludedFilenames = [],
}) => createHash('sha256')
  .update(JSON.stringify([
    query,
    type,
    [...new Set(excludedFilenames)].sort(),
  ]))
  .digest('base64url')

/**
 * @param {{
 *   fingerprint: string,
 *   offset: number,
 *   mode: 'semantic' | 'lexical'
 * }} options
 */
export const encodeSearchCursor = ({ fingerprint, offset, mode }) => Buffer
  .from(JSON.stringify([cursorVersion, fingerprint, offset, mode]))
  .toString('base64url')

/**
 * @param {{ value: string, fingerprint: string, maxOffset: number }} options
 * @returns {{ offset: number, mode: 'semantic' | 'lexical' }}
 */
export const decodeSearchCursor = ({ value, fingerprint, maxOffset }) => {
  try {
    if (typeof value !== 'string' || value.length === 0 || value.length > 1024) {
      throw new Error('invalid_cursor')
    }
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    if (
      !Array.isArray(parsed)
      || parsed.length !== 4
      || parsed[0] !== cursorVersion
      || parsed[1] !== fingerprint
      || !Number.isInteger(parsed[2])
      || parsed[2] <= 0
      || parsed[2] >= maxOffset
      || !cursorModes.has(parsed[3])
    ) {
      throw new Error('invalid_cursor')
    }
    return {
      offset: parsed[2],
      mode: /** @type {'semantic' | 'lexical'} */ (parsed[3]),
    }
  } catch {
    throw new Error('invalid_cursor')
  }
}
