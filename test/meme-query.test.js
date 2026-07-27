import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildGeminiMemeQueryPrompt,
  generateMemeSearchQuery,
  messagesForGeminiQuery,
  sanitizeGeneratedQuery,
} from '../src/memeQuery.js'

test('messagesForGeminiQuery orders messages newest first', () => {
  const messages = messagesForGeminiQuery([
    { content: 'old', createdTimestamp: 1, author: { username: 'a' } },
    { content: 'new', createdTimestamp: 2, author: { username: 'b' } },
  ])

  assert.equal(messages[0].content, 'new')
  assert.equal(messages[0].newest, true)
  assert.equal(messages[1].content, 'old')
})

test('buildGeminiMemeQueryPrompt tells Gemini to extract the actual subject', () => {
  const prompt = buildGeminiMemeQueryPrompt([
    {
      index: 1,
      newest: true,
      content: 'no entä esinkosta löytyykö memejä',
    },
  ])

  assert.ok(prompt.includes('Poimi viesteistä paras hakusana'))
  assert.ok(prompt.includes('Uusin viesti painaa eniten'))
  assert.ok(prompt.includes('löytyykö vaikka eemilistä meemejä -> eemil'))
  assert.ok(prompt.includes('github.com/ndycode/codex-multi-auth -> codex'))
  assert.ok(prompt.includes('||emacs fanaatikot, siitäs saitte|| -> emacs'))
  assert.ok(prompt.includes('Palauta 1-5 sanan hakukysely'))
})

test('sanitizeGeneratedQuery removes wrappers and limits length', () => {
  assert.equal(sanitizeGeneratedQuery('"eemil"'), 'eemil')
  assert.equal(sanitizeGeneratedQuery('```text\nr-kioski\n```'), 'r-kioski')
  assert.equal(
    sanitizeGeneratedQuery('github.com/ndycode/codex-multi-auth'),
    'github.com/ndycode/codex-multi-auth',
  )
  assert.equal(sanitizeGeneratedQuery('x'.repeat(200), { maxLength: 10 }), 'xxxxxxxxxx')
})

test('generateMemeSearchQuery returns Gemini text as the search query', async () => {
  let request
  const ai = {
    models: {
      generateContent: async (params) => {
        request = params
        return { text: 'esinko' }
      },
    },
  }
  const result = await generateMemeSearchQuery({
    ai,
    model: 'gemini-test',
    messages: [
      {
        content: 'no entä esinkosta löytyykö memejä',
        createdTimestamp: 1,
        author: { username: 'mikael' },
      },
    ],
    fallbackQuery: 'uusin viesti: no entä esinkosta löytyykö memejä',
    limit: 1,
  })

  assert.equal(result.query, 'esinko')
  assert.equal(result.source, 'gemini')
  assert.equal(result.rawText, 'esinko')
  assert.equal(request.model, 'gemini-test')
  assert.equal('temperature' in request.config, false)
  assert.equal(request.config.responseMimeType, 'text/plain')
})
