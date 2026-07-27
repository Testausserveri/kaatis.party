const mediaUrl = '/api/media'
const searchUrl = '/api/search'
const similarUrl = '/api/similar'
const baseUrl = '/'
const mediaCount = 100
const imageExtensions = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'ico', 'tiff', 'tif', 'heic', 'heif', 'avif']
const videoExtensions = ['mp4', 'webm', 'mov', 'avi', 'mkv', 'flv', 'wmv', 'm4v', '3gp', 'ogv']
const audioExtensions = ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'wma', 'aiff']

let mediaOpened = 0
let creatingMedia = false
let allMedia = []
let queuedMedia = []
let searchAbortController = null
let searchDebounce = null
let openedMedia = null

const extractType = (filename) => {
  const matches = filename.match(/.+\.([a-zA-Z0-9]+)$/)
  if (matches === null || matches.length < 2) return 'unknown'

  const extension = matches[1].toLowerCase()

  if (imageExtensions.includes(extension)) return 'image'
  if (videoExtensions.includes(extension)) return 'video'
  if (audioExtensions.includes(extension)) return 'audio'
  return 'unknown'
}

const readableFilename = (filename) => {
  let matches = filename.match(/(.+)\.[a-zA-Z0-9]+$/)
  if (matches === null || matches.length < 2) matches = filename.match(/(.+)$/)

  const [, filenameStem] = matches
  let keywords = filenameStem.match(/([a-zA-Z0-9]+)/g)
  let name
  if (keywords === null) {
    keywords = []
    name = filenameStem
  } else {
    name = keywords.join(' ')
  }

  keywords = keywords
    .map((keyword) => keyword.toLowerCase())
    .filter((keyword, index) => keyword.length > 1 && keywords.indexOf(keyword) === index)

  return { name, keywords }
}

const getMedia = async () => {
  const response = await fetch(mediaUrl)
  const body = await response.json()
  if (!response.ok) throw new Error(body.message || body.error || 'Media unavailable')

  const media = (body.results || []).map((item) => {
    const fallback = readableFilename(item.filename)
    return {
      ...item,
      type: item.type || extractType(item.filename),
      name: item.name || fallback.name,
      keywords: item.keywords || fallback.keywords,
      url: item.url || `${baseUrl}${item.filename}`,
    }
  })

  media.sort((a, b) => new Date(b.modified) - new Date(a.modified))
  return media
}

const closeMedia = () => {
  if (Date.now() - mediaOpened < 100) return

  document.getElementById('open-card').classList.add('closed')
  document.querySelector('#open-card .media').innerHTML = ''
  mediaOpened = Date.now()
}

const getMediaElement = (item, playable) => {
  const elements = []
  if (item.type === 'image') {
    const mediaImage = document.createElement('img')
    mediaImage.src = item.url
    mediaImage.alt = item.name
    mediaImage.setAttribute('loading', 'lazy')
    elements.push(mediaImage)
  } else if (item.type === 'video') {
    const mediaVideo = document.createElement('video')
    mediaVideo.src = item.url
    mediaVideo.controls = playable
    mediaVideo.autoplay = playable
    mediaVideo.setAttribute('loading', 'lazy')
    elements.push(mediaVideo)
  } else if (item.type === 'audio') {
    const mediaPre = document.createElement('p')
    mediaPre.textContent = 'Audio:'
    mediaPre.classList.add('media-audio-pre')
    elements.push(mediaPre)

    const mediaTitle = document.createElement('p')
    mediaTitle.textContent = item.name
    mediaTitle.classList.add('media-audio-title')
    elements.push(mediaTitle)

    if (playable) {
      const mediaAudio = document.createElement('audio')
      mediaAudio.src = item.url
      mediaAudio.controls = true
      mediaAudio.autoplay = true
      mediaAudio.setAttribute('loading', 'lazy')
      mediaAudio.classList.add('media-audio')
      elements.push(mediaAudio)
    }
  }

  return elements
}

const openMedia = (media) => {
  if (Date.now() - mediaOpened < 100) return

  const card = document.getElementById('open-card')
  const mediaRoot = card.querySelector('.media')
  openedMedia = media
  mediaRoot.innerHTML = ''
  getMediaElement(media, true).forEach((element) => mediaRoot.appendChild(element))

  card.querySelector('.title').innerText = media.name
  card.querySelector('.creator').innerText = media.creator || ''
  card.querySelector('.modified').innerText = media.modified || ''
  card.querySelector('.url').href = media.url
  card.querySelector('.similar').hidden = media.type !== 'image'
  card.classList.remove('closed')

  mediaOpened = Date.now()
}

const isOnScreen = (element) => {
  const rect = element.getBoundingClientRect()
  const viewHeight = Math.max(document.documentElement.clientHeight, window.innerHeight)
  return !(rect.bottom < 0 || rect.top - viewHeight >= 0)
}

const createMediaElements = (media) => {
  if (creatingMedia) return
  creatingMedia = true

  const mediaContainer = document.getElementById('media-elements')
  media.forEach((item, index) => {
    const mediaElement = document.createElement('div')
    mediaElement.dataset.loaded = false
    mediaElement.dataset.index = index
    mediaElement.classList.add('media-item')
    mediaElement.addEventListener('click', () => openMedia(item))

    const info = document.createElement('div')
    info.classList.add('media-search-info')
    const scoreText = typeof item.score === 'number' ? ` score ${item.score.toFixed(2)}` : ''
    info.innerText = `${item.name} by ${item.creator || ''} on ${item.modified || ''}${scoreText}`
    mediaElement.appendChild(info)

    mediaContainer.appendChild(mediaElement)

    new IntersectionObserver((entries, observer) => {
      entries.forEach((entry) => {
        if (entry.intersectionRatio > 0) {
          setTimeout(() => {
            if (!isOnScreen(mediaElement) || mediaElement.dataset.loaded === 'true') return

            const medias = getMediaElement(item, false)
            medias.forEach((element) => mediaElement.appendChild(element))
            mediaElement.dataset.loaded = true
            info.classList.add('invisible')
            observer.disconnect()
          }, 200)
        }
      })
    }).observe(mediaElement)
  })

  creatingMedia = false
}

const loadMoreMedia = () => {
  if (queuedMedia.length === 0 || creatingMedia) return
  createMediaElements(queuedMedia.slice(0, mediaCount))
  queuedMedia = queuedMedia.slice(mediaCount)
}

const showMessage = (message) => {
  const loading = document.getElementById('loading')
  if (loading) loading.innerText = message
}

const renderMedia = (media) => {
  const mediaContainer = document.getElementById('media-elements')
  mediaContainer.innerHTML = ''
  queuedMedia = media

  if (media.length === 0) {
    showMessage('No results')
    return
  }

  const loading = document.getElementById('loading')
  if (loading) loading.innerText = ''
  loadMoreMedia()
}

const searchResultsToMedia = (results) => {
  const mediaByFilename = new Map(allMedia.map((item) => [item.filename, item]))

  return results.map((result) => {
    const current = mediaByFilename.get(result.filename) || {}
    return {
      ...current,
      filename: result.filename,
      type: result.type || current.type || extractType(result.filename),
      name: result.name || current.name || result.filename,
      creator: result.creator || current.creator || '',
      modified: result.modified || current.modified || '',
      url: result.url || current.url || `${baseUrl}${result.filename}`,
      score: result.score,
      similarityScore: result.similarityScore,
      matchedModality: result.matchedModality,
      matchStartSeconds: result.matchStartSeconds,
      matchEndSeconds: result.matchEndSeconds,
    }
  })
}

const runSearch = async () => {
  const input = document.getElementById('search-input')
  const clearButton = document.getElementById('search-clear')
  const query = input.value.trim()
  clearButton.hidden = query.length === 0

  if (searchAbortController) searchAbortController.abort()

  if (!query) {
    renderMedia(allMedia)
    return
  }

  if (query.length < 2) {
    document.getElementById('media-elements').innerHTML = ''
    queuedMedia = []
    showMessage('Type at least 2 characters')
    return
  }

  searchAbortController = new AbortController()
  showMessage('Searching...')

  try {
    const params = new URLSearchParams({ q: query, limit: '40' })
    const response = await fetch(`${searchUrl}?${params.toString()}`, {
      signal: searchAbortController.signal,
    })
    const body = await response.json()
    if (!response.ok) throw new Error(body.message || body.error || 'Search unavailable')

    renderMedia(searchResultsToMedia(body.results || []))
  } catch (e) {
    if (e.name === 'AbortError') return
    showMessage('Search unavailable')
  }
}

const runSimilar = async (media) => {
  if (!media?.filename) return

  if (searchAbortController) searchAbortController.abort()
  searchAbortController = new AbortController()
  closeMedia()
  document.getElementById('search-input').value = ''
  showMessage('Finding similar...')

  try {
    const params = new URLSearchParams({ filename: media.filename, limit: '40' })
    const response = await fetch(`${similarUrl}?${params.toString()}`, {
      signal: searchAbortController.signal,
    })
    const body = await response.json()
    if (!response.ok) throw new Error(body.message || body.error || 'Similar unavailable')

    renderMedia(searchResultsToMedia(body.results || []))
  } catch (e) {
    if (e.name === 'AbortError') return
    showMessage('Similar unavailable')
  }
}

const queueSearch = () => {
  clearTimeout(searchDebounce)
  searchDebounce = setTimeout(runSearch, 300)
}

window.addEventListener('scroll', () => {
  if (isOnScreen(document.getElementById('footer'))) loadMoreMedia()
})

document.querySelector('#open-card').addEventListener('click', (event) => {
  const cardIsOpen = !document.getElementById('open-card').classList.contains('closed')
  if (event.target.closest('.card-content') === null && cardIsOpen) closeMedia()
})

document.querySelector('#open-card .close').addEventListener('click', closeMedia)
document.querySelector('#open-card .similar').addEventListener('click', () => runSimilar(openedMedia))

document.getElementById('search-form').addEventListener('submit', (event) => {
  event.preventDefault()
  runSearch()
})

document.getElementById('search-input').addEventListener('input', queueSearch)

document.getElementById('search-clear').addEventListener('click', () => {
  document.getElementById('search-input').value = ''
  runSearch()
})

getMedia().then((media) => {
  allMedia = media
  document.getElementById('loading').innerText = ''
  document.getElementById('media-elements').classList.remove('loading')
  renderMedia(allMedia)
}).catch((error) => {
  console.error('Error fetching media:', error)
  showMessage('Not workingz :(')
})
