# kaatis 🥳

a meme archive service that takes submissions from Discord

## features

Liven up your community!

- Host a **Discord bot** that monitors the meme channel of your guild. 🤖💥

- The Discord bot is **multilingual**, speaking both English and Finnish. 📡🌏

- Memes sent to your meme channel are **saved to disk**. 🗃️✅

- Deleting a meme's message in Discord **automatically removes** the archived file, keeping the catalog in sync — even for memes uploaded before the bot was last restarted. 🗑️♻️

- The names of the saved files are **intelligently deducted** from message content or left as-is. The names are also **automatically** sanitized and truncated. 🥶🤤

- Archived memes can be viewed from a minimalist **Apache file listing**. How dank! 🚀🙌


## installation

Prerequisites: Docker, modern Node runtime

1. Install the dependencies of the bot: `npm install`.

2. Rename `.example.env` to `.env` and fill in the fields. You can set the language of the bot by setting the environment variable `LANGUAGE` to either `english` or `finnish`. Upload directory (`UPLOAD_DIR`), htaccess path (`HTACCESS_PATH`) and index path (`INDEX_PATH`) are also configurable.
Note: By default, all images by bots and webhooks are ignored. However, webhooks can be allowlisted in a comma-separated list as `ALLOWED_WEBHOOK_IDS`. 

   > The index (`indeksi.csv`) records the Discord message ID of each upload. This is what lets the bot delete the right file when a message is deleted, so uploads made before this file existed cannot be auto-deleted.

3. Run the bot and the Apache web server in different Docker containers: `docker compose -f docker-compose.yml up`.
