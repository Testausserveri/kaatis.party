import fs from 'fs'
import path from 'path'

// kiitti hegez
export const alphanum = (s) => s.normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-zA-Z0-9_*+=()\.-]/g, '-')
  .split('-')
  .filter((x) => x !== '')
  .join('-')

export const isPictureOrVideo = (a) => (a && a.width && a.height)

export const separateExtension = (fullName) => {
  const extension = fullName.split('.').pop()

  return [
    fullName.slice(0, -(extension.length + 1)),
    extension,
  ]
}

export function* possibleNames(fullFilename) {
  yield fullFilename

  const [name, extension] = separateExtension(fullFilename)

  // eslint-disable-next-line no-plusplus
  for (let i = 1; true; ++i) {
    yield `${name}_${i}.${extension}`
  }
}

// Could be done more effectively with a database
export const findAvailableFilename = async (folder, fullFilename) => {
  for (const filename of possibleNames(fullFilename)) {
    if (!fs.existsSync(path.join(folder, filename))) return filename
  }
}

export const currentTimestamp = () => new Date().toISOString().replace('T', ' ').replace('Z', '0000000000')
