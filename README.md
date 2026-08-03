# kaatis.party

Kaatiksen media arkisto tallentaa Discordiin lähetetyt kuvat, videot ja äänitiedostot. Selain näyttää median justified galleriana. Haku yhdistää SQLite FTS5 osumat ja Qdrantin semanttiset Gemini embedding osumat.

## Rakenne

| Osa | Vastuu |
| --- | --- |
| `apps/web` | React ja TypeScript käyttöliittymä |
| `apps/api` | Fastify API, tiedostot, SQLite, esikatselut ja Qdrant |
| `apps/bot` | Discord tapahtumat ja `/kaatis` komento |
| `packages/contracts` | Jaetut API tyypit |
| `src/search` | Gemini ja Qdrant domain logiikka |
| `legacy/icons` | Vanhan Apache listauksen alkuperäiset tiedostotyyppi ikonit |
| `public` | Alkuperäiset mediatiedostot |
| `data/kaatis.sqlite` | Median metadata ja pysyvät työjonot |
| `data/thumbs` | Sisältöosoitteiset WebP ja WebM esikatselut |
| `data/qdrant` | Qdrantin pysyvä tallennus |

SQLite on metadatan lähde. Qdrant sisältää vain hakua varten tarvittavat vektorit ja payload tiedot. Mediaa ei kopioida Qdrantiin.

## Palvelut

Compose käynnistää kuusi palvelua.

1. `init` valmistelee kirjoitettavien hakemistojen omistajuudet.
2. `edge` palvelee selainbuildin, esikatselut ja alkuperäiset tiedostot Caddyllä.
3. `legacy` palvelee old.kaatis.party Apache tyylisen tiedostolistauksen.
4. `api` omistaa kaikki kirjoitukset mediahakemistoon, SQLiteen ja Qdrantiin.
5. `bot` välittää Discord tapahtumat sisäiselle APIlle.
6. `qdrant` suorittaa vektorihaun.

Caddyt avaavat vain localhost portit. Tuotannon Nginx välittää `kaatis.party` osoitteeseen `127.0.0.1:8089` ja `old.kaatis.party` osoitteeseen `127.0.0.1:8189`.

## Kehitys

Asenna riippuvuudet.

```sh
npm install
```

Käynnistä käyttöliittymä.

```sh
npm run dev
```

Käynnistä API.

```sh
npm run api:start
```

Käynnistä Discord botti.

```sh
npm run bot:start
```

## Ympäristö

Kopioi `.env.example` tiedostoksi `.env` ja täytä salaisuudet.

| Muuttuja | Tarkoitus |
| --- | --- |
| `DISCORD_BOT_TOKEN` | Discord botin tunniste |
| `MEME_CHANNEL_ID` | Kanava, jonka liitteet arkistoidaan |
| `DISCORD_GUILD_ID` | Slash komennon guild |
| `GEMINI_API_KEY` | Hakukyselyt ja embeddingit |
| `SEARCH_INTERNAL_TOKEN` | Botin ja APIn jaettu salaisuus |
| `PUBLIC_BASE_URL` | Julkinen osoite, oletus `https://kaatis.party` |
| `MEDIA_DB_PATH` | SQLite polku, oletus `data/kaatis.sqlite` |
| `UPLOAD_DIR` | Alkuperäisten tiedostojen polku, oletus `public` |
| `PREVIEW_ROOT` | Esikatselujen polku, oletus `data/thumbs` |
| `QDRANT_URL` | Qdrantin sisäinen osoite |
| `SEARCH_MAX_RESULTS` | Haun suurin sivutettava tulosmäärä, oletus `1000` |
| `HTTP_PORT` | Caddyn localhost portti, oletus `8089` |
| `LEGACY_HTTP_PORT` | Legacy Caddyn localhost portti, oletus `8189` |

Sisäinen upload hyväksyy vain HTTPS osoitteita Discordin CDN hosteilta. Tiedoston enimmäiskoko on oletuksena 256 megatavua.

## Esikatselut

Kuvista luodaan WebP versiot leveyksillä 320, 640 ja 1280 pikseliä. GIF tiedostosta käytetään ensimmäistä kuvaa galleriassa.

Videosta luodaan samat WebP kuvat sekä lyhyt 480 pikseliä leveä mykistetty WebM. Selain lataa liikkuvan esikatselun vasta laatan lähestyessä ruutua.

Nykyinen arkisto lisätään työjonoon tällä komennolla.

```sh
docker compose run --rm api npm run media:backfill
```

Työjono on SQLitessä. Keskeytynyt ajo jatkuu seuraavalla API käynnistyksellä.

Esikatselujen backfill ei lähetä vanhoja medioita uudelleen Geminille. Videoiden semanttinen backfill käyttää erillistä Gemini Batch ajoa.

Jos `public/` hakemistossa on mediatiedostoja ilman SQLite riviä, ne voi
palauttaa Qdrantin metadatasta ilman uusia embedding kutsuja.

```sh
docker compose run --rm api npm run media:reconcile -- --dry-run
docker compose run --rm api npm run media:reconcile
```

Komento lisää vain puuttuvat rivit ja jonottaa niille `preview_only` työt.

```sh
docker compose run --rm api npm run search:index:video-batch -- submit
docker compose run --rm api npm run search:index:video-batch -- status
docker compose run --rm api npm run search:index:video-batch -- import
```

## Haku

FTS5 hakee tarkat otsikko, tiedostonimi ja tekijäosumat. Gemini muuntaa kyselyn vektoriksi ja Qdrant hakee merkitykseltään sopivat kuvat sekä videoiden kuva ja ääniosumat.

Tulokset yhdistetään painotetulla reciprocal rank fusion menetelmällä. FTS5 paino on `1.25`. Kuvien ja videoiden semanttisten listojen paino on `1.0`. Jos Gemini tai Qdrant ei vastaa, API palauttaa FTS5 tulokset kentällä `degraded: true`.

Hakukyselyn embedding tallennetaan pysyvästi Qdrantiin. Sama kysely ei kuluta Geminiä uudelleen.

Hakutulokset palautetaan enintään 80 tuloksen sivuina. Selain lataa seuraavan
sivun automaattisesti ja käyttää API:n palauttamaa kyselyyn sidottua cursoria.

## Discord

`/kaatis` muodostaa viimeisistä viesteistä lyhyen hakusanan Geminillä ja hakee sopivan median. `/kaatis hakusana:<teksti>` käyttää annettua hakua suoraan.

Uusi liite lähetetään APIlle Discord CDN osoitteena. API lataa tiedoston atomisesti, kirjoittaa metadatan ja jonottaa esikatselun sekä embeddingin. Discord viestin poisto poistaa alkuperäisen tiedoston, SQLite rivin, esikatselun ja Qdrant pisteet.

## Legacy listaus

`old.kaatis.party` näyttää SQLiteen tallennetut kuvat, videot ja äänet vanhan Apache hakemistolistauksen muodossa. Taulukon Description sarake näyttää tekijän. Tiedostonimi, päivämäärä, koko ja kuvaus ovat lajiteltavissa Apache tyylisillä otsikkolinkeillä.

Legacy palvelu ei lue CSV tai `.htaccess` metadataa. Muut kuin nykyisen järjestelmän mediaformaatit palauttavat `404`.

## Tuotanto

Rakenna ja käynnistä pino.

```sh
docker compose up -d --build
```

Ensimmäisessä käyttöönotossa tee SQLite varmuuskopio ennen skeemapäivitystä. Esikatselujen backfill voidaan ajaa vanhan palvelun ollessa käynnissä. Lopullinen vaihto tarvitsee lyhyen huoltokatkon, koska kirjoitusvastuu siirtyy botilta APIlle.

Jos vanhassa asennuksessa on keskeneräisiä Gemini Batch ajoja JSON tiedostossa SQLite tietokannan vieressä, siirrä ne SQLiteen ennen uuden APIn käynnistämistä.

```sh
docker compose run --rm api npm run media:migrate-batches
```
