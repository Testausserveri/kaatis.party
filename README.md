# kaatis 🥳

a meme archive service that takes submissions from Discord

## features

Liven up your community!

- Host a **Discord bot** that monitors the meme channel of your guild. 🤖💥

- The Discord bot speaks **Finnish**. 📡

- Memes sent to your meme channel are **saved to disk**. 🗃️✅

- Deleting a meme's message in Discord **automatically removes** the archived file, keeping the catalog in sync — even for memes uploaded before the bot was last restarted. 🗑️♻️

- The names of the saved files are **intelligently deducted** from message content or left as-is. The names are also **automatically** sanitized and truncated. 🥶🤤

- Archived memes can be viewed from a minimalist **Apache file listing**. How dank! 🚀🙌

- Images can be indexed into a self-hosted **Qdrant** vector database and searched semantically with **Gemini Embedding 2**. The indexer reads the existing files in place and stores only vectors plus metadata; it does not copy the media library.

- `/kaatis` works in any channel: it reads that channel's latest messages, searches for a fitting indexed image, and replies with its public URL so Discord renders it as an image. `!meemi` still works as a text-command fallback.
- `/kaatis hakusana:<teksti>` searches directly with that query.
- New image uploads are indexed immediately through the internal search service.
- Deleting an uploaded Discord message also removes the image from the search index.


## installation

Prerequisites: Docker, modern Node runtime

1. Install the dependencies of the bot: `npm install`.

2. Rename `.example.env` to `.env` and fill in the fields. Upload directory (`UPLOAD_DIR`), htaccess path (`HTACCESS_PATH`) and index path (`INDEX_PATH`) are also configurable.
Note: By default, all images by bots and webhooks are ignored. However, webhooks can be allowlisted in a comma-separated list as `ALLOWED_WEBHOOK_IDS`. 

   > The index (`indeksi.csv`) records the Discord message ID of each upload. This is what lets the bot delete the right file when a message is deleted, so uploads made before this file existed cannot be auto-deleted.

3. Run the bot and the Apache web server in different Docker containers: `docker compose -f docker-compose.yml up`.

## semantic image search

Semantic search indexes current images only. Videos, audio and PDFs stay out of
scope until the cost and UX are worth it.

1. Add `GEMINI_API_KEY` to `.env`.

2. Start Qdrant and the search API:

   ```sh
   docker compose up -d qdrant search
   ```

3. Index the current media directory from the server that has the real files.
   In production, run this inside Docker so the indexer uses the same modern
   Node runtime as the search service:

   ```sh
   docker compose run --rm search npm run search:index
   ```

   For a cheap smoke test before the full backfill:

   ```sh
   docker compose run --rm -e SEARCH_INDEX_LIMIT=25 -e SEARCH_DELETE_STALE=false search npm run search:index
   ```

4. The media Apache container proxies `/api/search` to the internal search
   service through `apache-vhost.conf`, so host Apache can keep forwarding all
   kaatis traffic to the media container.

Useful knobs:

- `PUBLIC_BASE_URL`, default: `https://kaatis.party`
- `DISCORD_GUILD_ID`, default: derived from `MEME_CHANNEL_ID`
- `DISCORD_REGISTER_SLASH_COMMANDS`, default: `true`
- `MEME_SEARCH_URL`, default: `http://search:3000/api/search`
- `MEME_INDEX_URL`, default: `http://search:3000/api/index`
- `MEME_CONTEXT_LIMIT`, default: `10`
- `MEME_FETCH_LIMIT`, default: `12`
- `MEME_QUERY_MAX_LENGTH`, default: `480`
- `MEME_SEARCH_LIMIT`, default: `6`
- `MEME_RANDOM_POOL_LIMIT`, default: `4`
- `MEME_RANDOM_SCORE_DELTA`, default: `0.035`
- `MEME_SEARCH_LOG_CONTEXT`, default: `true`
- `GEMINI_QUERY_MODEL`, default: `gemini-3.5-flash-lite`
- `SEARCH_INTERNAL_TOKEN`, optional shared secret. When set, only requests with this token may bypass query cache.
- `QDRANT_URL`, default in Docker: `http://qdrant:6333`
- `QDRANT_COLLECTION`, default: `kaatis_images`
- `QDRANT_QUERY_CACHE_COLLECTION`, default: `kaatis_images_query_cache`
- `GEMINI_EMBED_MODEL`, default: `gemini-embedding-2`
- `GEMINI_EMBED_DIMS`, default: `768`
- `SEARCH_EMBEDDING_INPUT_VERSION`, default: `image-metadata-v2`
- `SEARCH_HOST_PORT`, default: `3095`
- `SEARCH_MIN_QUERY_LENGTH`, default: `2`
- `SEARCH_MIN_SCORE`, default: `0.4`
- `SEARCH_PERSIST_QUERY_CACHE`, default: `true`
- `SEARCH_QUERY_CACHE_MAX_ENTRIES`, default: `1000`
- `SEARCH_QUERY_CACHE_TTL_MS`, default: `0` / no expiry
- `SEARCH_RATE_LIMIT_WINDOW_MS`, default: `60000`
- `SEARCH_RATE_LIMIT_MAX`, default: `60`
- `SEARCH_GLOBAL_RATE_LIMIT_MAX`, default: `300`
- `SEARCH_INDEX_CONCURRENCY`, default: `2`
- `SEARCH_INDEX_LIMIT`, default: unset / full index
- `SEARCH_INDEX_MATCH`, default: unset / all files. Accepts comma-separated filename substrings for targeted reindexing.
- `SEARCH_DELETE_STALE`, default: `true`

The Discord meme command sends `cache=0` with `SEARCH_INTERNAL_TOKEN`, because
each query contains live channel context. New image uploads use the same token
to request immediate indexing from the internal search service. Public searches
cannot bypass the query cache and are rate-limited by the search service.
