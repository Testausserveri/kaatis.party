const mediaUrl = 'http://localhost:8000/indexpage.html'
const baseUrl = 'https://kaatis.party'
const mediaCount = 100;
let mediaOpened = 0;
const globalKeywords = {};
let creatingMedia = false;
let mediaElements = [];

const extractType = (url, filename) => {
    const matches = url.match(/([a-z]+)[0-9]*\.[a-z0-9]+$/);
    if (matches === null || matches.length < 2) {
        return 'unknown';
    }

    if (matches[1] === 'unknown') {
        // Patch some known cases

        // Webp images
        if (filename.match(/\.webp$/i)) {
            return 'image';
        }
    }

    return matches[1];
};

const readableFilename = (filename) => {
    // Remove extension and use 
    let matches = filename.match(/(.+)\.[a-zA-Z0-9]+$/);
    if (matches === null || matches.length < 2) {
        // Match without extension
        matches = filename.match(/(.+)$/);
    }

    let keywords = matches[1].match(/([a-zA-Z0-9]+)/g);
    let name;
    if (keywords === null) {
        keywords = [];
        name = matches[1];
    } else {
        name = keywords.join(' ');
    }

    keywords = keywords
        .map(keyword => keyword.toLowerCase())
        .filter((keyword, index) => keyword.length > 1 && keywords.indexOf(keyword) === index);

    return {name, keywords};
}

const getMedia = async () => {
    // Fetch the Apache directory listing and parse it to media object
    const response = await fetch(mediaUrl).then(res => res.text());
    const parser = new DOMParser();
    const root = parser.parseFromString(response, 'text/html').querySelector('body>table');

    const media = [];
    root.querySelectorAll('tr').forEach((row, index) => {
        if (index === 0) return;

        const cells = row.querySelectorAll('td');
        if (cells.length < 5) return;

        const type = extractType(cells[0].querySelector('img').src, cells[1].textContent.trim());
        const {name, keywords} = readableFilename(cells[1].textContent.trim());
        console.log(cells[1].querySelector('a').href)
        const url = baseUrl + (new URL(cells[1].querySelector('a').href).pathname);
        const modified = cells[2].textContent.trim();
        const size = cells[3].textContent.trim();
        let creator = cells[4].textContent.trim();

        if (creator === '') {
            // Null patch for creator
            creator = null;
        }

        const currentId = media.length;
        // console.log({currentId, type, name, keywords, url, modified, size, creator})

        // Add each keyword to the global keywords list
        keywords.forEach(keyword => {
            if (globalKeywords[keyword] === undefined) {
                globalKeywords[keyword] = [];
            }

            globalKeywords[keyword].push(currentId);
        });

        media.push({
            type,
            name,
            keywords,
            url,
            modified,
            size,
            creator,
        });
    });

    return media;
}

const closeMedia = () => {
    if (Date.now() - mediaOpened < 100) {
        // Prevent accidental closing
        return;
    }

    console.log('Closing media')
    document.getElementById('open-card').classList.add('closed');

    document.querySelector('#open-card .media').innerHTML = '';

    mediaOpened = Date.now()
}

const openMedia = (media) => {
    if (Date.now() - mediaOpened < 100) {
        // Prevent accidental opens
        return;
    }

    // Open media in a fixed area in full size card
    console.log('Opening media', media)

    const card = document.getElementById('open-card');
    const mediaRoot = card.querySelector('.media');
    mediaRoot.innerHTML = '';
    getMediaElement(media, true).forEach(element => mediaRoot.appendChild(element));

    card.querySelector('.title').innerText = media.name;
    card.querySelector('.creator').innerText = media.creator;
    card.querySelector('.modified').innerText = media.modified;
    card.querySelector('.size').innerText = media.size;
    card.querySelector('.url').href = media.url;
    
    card.querySelector('.close').addEventListener('click', closeMedia);

    card.classList.remove('closed');

    mediaOpened = Date.now();
}

const getMediaElement = (item, playable) => {
    let elements = [];
    if (item.type === 'image') {
        const mediaImage = document.createElement('img');
        mediaImage.src = item.url;
        mediaImage.alt = item.name;
        mediaImage.setAttribute('loading', 'lazy');
        elements.push(mediaImage);
    } else if (item.type === 'movie' || item.type === 'video') {
        const mediaVideo = document.createElement('video');
        mediaVideo.src = item.url;
        mediaVideo.controls = playable;
        mediaVideo.autoplay = playable;
        mediaVideo.setAttribute('loading', 'lazy');
        elements.push(mediaVideo);
    } else if (item.type === 'sound') {
        // Also add title text
        const mediaPre = document.createElement('p');
        mediaPre.textContent = 'Audio:';
        mediaPre.classList.add('media-audio-pre');
        elements.push(mediaPre);

        const mediaTitle = document.createElement('p');
        mediaTitle.textContent = item.name;
        mediaTitle.classList.add('media-audio-title');
        elements.push(mediaTitle);


        if (playable) {
            // Main element, only add if video is playable
            const mediaAudio = document.createElement('audio');
            mediaAudio.src = item.url;
            mediaAudio.controls = true;
            mediaAudio.autoplay = true;
            mediaAudio.setAttribute('loading', 'lazy');
            mediaAudio.classList.add('media-audio');
            elements.push(mediaAudio);
        }
    } else {
        console.warn('Unknown type', item.type, item)
        const mediaTitle = document.createElement('p');
        mediaTitle.textContent = `Unknown: item.name`;
        elements.push(mediaTitle);
    }

    return elements;
}

const createMediaElements = (media) => {
    if (creatingMedia) return;
    creatingMedia = true;

    console.log(media)
    const mediaContainer = document.getElementById('media-elements');
    media.forEach((item) => {
        const mediaElement = document.createElement('div');
        mediaElement.classList.add('media-item');
        mediaElement.addEventListener('click', () => openMedia(item));

        getMediaElement(item, false).forEach(element => mediaElement.appendChild(element));

        mediaContainer.appendChild(mediaElement);
    });

    creatingMedia = false;
}

const isOnScreen = (element) => {
    const rect = element.getBoundingClientRect();
    const viewHeight = Math.max(document.documentElement.clientHeight, window.innerHeight);
    return !(rect.bottom < 0 || rect.top - viewHeight >= 0);
}

// Attach scroll event to load more media if footer is seen
window.addEventListener('scroll', () => {
    if (isOnScreen(document.getElementById('footer'))) {
        // Load more media
        if (mediaElements.length > 0 && !creatingMedia) {
            createMediaElements(mediaElements.slice(0, mediaCount));
            mediaElements = mediaElements.slice(mediaCount);
        }
    }
});

document.querySelector('#open-card').addEventListener('click', (event) => {
    // Check that the click is not on the open card
    if (event.target.closest('.card-content') === null && document.getElementById('open-card').classList.contains('closed') === false) {
        closeMedia();
    }
});

getMedia().then((media) => {
    document.getElementById('loading').remove();
    document.getElementById('media-elements').classList.remove('loading');
    createMediaElements(media.slice(0, mediaCount));
    mediaElements = media.slice(mediaCount);
});
