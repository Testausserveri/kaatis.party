import assert from 'node:assert/strict'
import test from 'node:test'
import {
  absoluteMediaUrl,
  buildMemeSearchQuery,
  closeMemeResultPool,
  isMemeImageFilename,
  isMemeSearchCommand,
  isMemeSlashCommand,
  mediaFilenameFromUrl,
  mediaFilenamesFromMessages,
  memeSlashCommandDefinition,
  memeSearchOptionName,
  messageToContextText,
  nonNegativeNumber,
  positiveInteger,
  selectMemeSearchResult,
} from '../src/memeCommand.js'

test('isMemeSearchCommand accepts only the Finnish command', () => {
  assert.equal(isMemeSearchCommand('!meemi'), true)
  assert.equal(isMemeSearchCommand(' !meme please'), false)
  assert.equal(isMemeSearchCommand('!upload'), false)
})

test('isMemeSlashCommand matches the configured slash command name', () => {
  assert.equal(isMemeSlashCommand('kaatis'), true)
  assert.equal(isMemeSlashCommand('Kaatis'), true)
  assert.equal(isMemeSlashCommand('meemi'), false)
  assert.equal(isMemeSlashCommand('meme'), false)
  assert.equal(isMemeSlashCommand('meme', 'meme'), true)
})

test('memeSlashCommandDefinition creates a chat input command payload', () => {
  assert.deepEqual(memeSlashCommandDefinition('kaatis'), {
    name: 'kaatis',
    type: 1,
    description: 'Etsi keskusteluun sopiva meemi',
    name_localizations: null,
    description_localizations: null,
    options: [
      {
        name: memeSearchOptionName,
        type: 3,
        description: 'Hae suoraan tällä hakusanalla',
        required: false,
        min_length: 1,
        max_length: 120,
        name_localizations: null,
        description_localizations: null,
      },
    ],
  })
})

test('closeMemeResultPool keeps only results close to the top score', () => {
  const pool = closeMemeResultPool([
    { filename: 'paras.png', score: 0.72 },
    { filename: 'melkein.png', score: 0.691 },
    { filename: 'liian-kaukana.png', score: 0.66 },
    { score: 0.719 },
  ], {
    scoreDelta: 0.03,
    maxPoolSize: 5,
  })

  assert.deepEqual(pool.map((result) => result.filename), ['paras.png', 'melkein.png'])
})

test('selectMemeSearchResult randomly selects from the close result pool', () => {
  const { result, pool, selectedIndex } = selectMemeSearchResult([
    { filename: 'eka.png', score: 0.7 },
    { filename: 'toka.png', score: 0.69 },
    { filename: 'kolmas.png', score: 0.68 },
  ], {
    scoreDelta: 0.03,
    maxPoolSize: 3,
    random: () => 0.6,
  })

  assert.equal(result.filename, 'toka.png')
  assert.equal(pool.length, 3)
  assert.equal(selectedIndex, 1)
})

test('mediaFilenameFromUrl extracts kaatis image filenames only', () => {
  assert.equal(
    mediaFilenameFromUrl({
      publicBaseUrl: 'https://kaatis.party',
      value: 'https://kaatis.party/koira.jpg',
    }),
    'koira.jpg',
  )
  assert.equal(
    mediaFilenameFromUrl({
      publicBaseUrl: 'https://kaatis.party',
      value: 'https://example.com/koira.jpg',
    }),
    '',
  )
})

test('isMemeImageFilename accepts only currently indexed image formats', () => {
  assert.equal(isMemeImageFilename('uusi.PNG'), true)
  assert.equal(isMemeImageFilename('uusi.webp'), true)
  assert.equal(isMemeImageFilename('uusi.mp4'), false)
})

test('mediaFilenamesFromMessages collects unique recent bot result filenames', () => {
  assert.deepEqual(mediaFilenamesFromMessages({
    publicBaseUrl: 'https://kaatis.party',
    messages: [
      { content: 'https://kaatis.party/eka.png' },
      { content: '<https://kaatis.party/eka.png>' },
      { content: 'https://kaatis.party/toka.webp' },
    ],
  }), ['eka.png', 'toka.webp'])
})

test('messageToContextText includes clean content and attachment names', () => {
  const text = messageToContextText({
    cleanContent: '||katso tämä||',
    attachments: new Map([
      ['1', { name: 'hauska-kuva.png' }],
    ]),
  })

  assert.equal(text, 'katso tämä liitteet: hauska-kuva.png')
})

test('buildMemeSearchQuery keeps newest messages most prominent', () => {
  const messages = Array.from({ length: 12 }, (_, index) => ({
    content: `message ${index + 1} ${'x'.repeat(30)}`,
    createdTimestamp: index + 1,
  }))
  const query = buildMemeSearchQuery(messages, {
    limit: 10,
    maxLength: 260,
  })

  assert.ok(query.includes('uusin viesti:'))
  assert.ok(query.includes('message 12'))
  assert.ok(query.includes('message 11'))
  assert.ok(!query.includes('message 2 '))
  assert.ok(query.length <= 260)
})

test('absoluteMediaUrl resolves search payload URLs against the public base', () => {
  assert.equal(
    absoluteMediaUrl({ publicBaseUrl: 'https://kaatis.party', mediaUrl: '/dog.jpg' }),
    'https://kaatis.party/dog.jpg',
  )
})

test('positiveInteger falls back for invalid values', () => {
  assert.equal(positiveInteger('4', 10), 4)
  assert.equal(positiveInteger('0', 10), 10)
  assert.equal(positiveInteger('nope', 10), 10)
})

test('nonNegativeNumber accepts decimals and falls back for invalid values', () => {
  assert.equal(nonNegativeNumber('0.04', 0.1), 0.04)
  assert.equal(nonNegativeNumber('0', 0.1), 0)
  assert.equal(nonNegativeNumber('-1', 0.1), 0.1)
  assert.equal(nonNegativeNumber('nope', 0.1), 0.1)
})
