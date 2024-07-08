const mediaUrl = '/indeksi.csv'
const baseUrl = 'https://kaatis.party/'
const mediaCount = 100;
const imageExtensions = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'ico', 'tiff', 'tif', 'heic', 'heif', 'avif'];
const videoExtensions = ['mp4', 'webm', 'mov', 'avi', 'mkv', 'flv', 'wmv', 'm4v', '3gp', 'ogv'];
const audioExtensions = ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'wma', 'aiff'];

let mediaOpened = 0;
const globalKeywords = {};
let creatingMedia = false;
let mediaElements = [];

const extractType = (path) => {
    // Get the extension
    let matches = path.match(/.+\.([a-zA-Z0-9]+)$/);
    if (matches === null || matches.length < 2) {
        return 'unknown';
    }

    const extension = matches[1].toLowerCase();

    if (imageExtensions.includes(extension)) {
        return 'image';
    } else if (videoExtensions.includes(extension)) {
        return 'video';
    } else if (audioExtensions.includes(extension)) {
        return 'audio';
    } else {
        return 'unknown';
    }
};

// Function code from here: https://stackoverflow.com/a/14991797 with CC BY-SA 4.0 license
function parseCSV(str) {
    const arr = [];
    let quote = false;  // 'true' means we're inside a quoted field

    // Iterate over each character, keep track of current row and column (of the returned array)
    for (let row = 0, col = 0, c = 0; c < str.length; c++) {
        let cc = str[c], nc = str[c+1];        // Current character, next character
        arr[row] = arr[row] || [];             // Create a new row if necessary
        arr[row][col] = arr[row][col] || '';   // Create a new column (start with empty string) if necessary

        // If the current character is a quotation mark, and we're inside a
        // quoted field, and the next character is also a quotation mark,
        // add a quotation mark to the current column and skip the next character
        if (cc == '"' && quote && nc == '"') { arr[row][col] += cc; ++c; continue; }

        // If it's just one quotation mark, begin/end quoted field
        if (cc == '"') { quote = !quote; continue; }

        // If it's a comma and we're not in a quoted field, move on to the next column
        if (cc == ',' && !quote) { ++col; continue; }

        // If it's a newline (CRLF) and we're not in a quoted field, skip the next character
        // and move on to the next row and move to column 0 of that new row
        if (cc == '\r' && nc == '\n' && !quote) { ++row; col = 0; ++c; continue; }

        // If it's a newline (LF or CR) and we're not in a quoted field,
        // move on to the next row and move to column 0 of that new row
        if (cc == '\n' && !quote) { ++row; col = 0; continue; }
        if (cc == '\r' && !quote) { ++row; col = 0; continue; }

        // Otherwise, append the current character to the current column
        arr[row][col] += cc;
    }
    return arr;
}

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

    // Parse the CSV file
    const csv = parseCSV(response).reverse();

    console.log(csv)

    const media = [];
    csv.forEach((row, index) => {
        // CSV rows: path, username, date
        let [path, creator, modified] = row;

        // console.log({path, creator, modified})

        const type = extractType(path);
        const {name, keywords} = readableFilename(path);
        const url = `${baseUrl}${path}`;

        const currentId = media.length;
        // console.log({currentId, type, name, keywords, url, modified, creator})

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
            creator,
        });
    });

    media.sort((a, b) => new Date(b.modified) - new Date(a.modified))
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
    } else if (item.type === 'video') {
        const mediaVideo = document.createElement('video');
        mediaVideo.src = item.url;
        mediaVideo.controls = playable;
        mediaVideo.autoplay = playable;
        mediaVideo.setAttribute('loading', 'lazy');
        elements.push(mediaVideo);
    } else if (item.type === 'audio') {
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
        // elements.push(mediaTitle);
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

        const medias = getMediaElement(item, false);
        if (medias.length > 0) {
            medias.forEach(element => mediaElement.appendChild(element));
            mediaContainer.appendChild(mediaElement);
        }
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
}).catch((error) => {
    console.error('Error fetching media:', error);
    document.getElementById('loading').innerText = 'Not workingz :(';
});
