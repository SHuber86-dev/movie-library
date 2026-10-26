# movie-library

Private Movie Library: a web app for a group of friends to browse their shared Blu-ray collection, with posters and movie details from TMDB, and to track who owns each disc and who has it right now.

The page is hosted on **GitHub Pages** at <https://shuber86-dev.github.io/movie-library/>. Behind it, a small **Google Apps Script** API bound to the "BluRay inventory" Google Sheet reads and writes the sheet. The sheet stays the source of truth, and friends sign in with their Google account.

## Layout

| Path | What it is |
|---|---|
| `src/Code.gs` | API: checks the Google sign-in, reads the sheet, keeps row keys, fetches TMDB metadata, handles lending, requests, "seen by" marks, the wishlist, adding discs and digitally owned titles found on TMDB (digital ones only reach their owner) and removing them |
| `src/appsscript.json` | Manifest (runs as the owner; the script checks every caller's sign-in itself) |
| `web/index.html` | The web page: Google sign-in, poster grid, filters, details, lend and return, requests, seen by, household, wishlist, adding discs or digital titles (with their source) and removing them, disc and digital icons on the cards |
| `web/config.js` | The OAuth Client ID and the Apps Script `/exec` URL the page uses |
| `.github/workflows/pages.yml` | Runs the tests and publishes `web/` to GitHub Pages on every push to `main` |
| `docs/SETUP.md` | Step-by-step install guide |
| `docs/DESCRIPTION.md` | Short description of the app |
| `docs/PLAN.md` | Design and data model |
| `test/` | Node tests for the title and collection parsing |

## Install

The first time, follow [docs/SETUP.md](docs/SETUP.md) and copy and paste the files into the sheet's Apps Script editor.

To push from this repo instead, use [clasp](https://github.com/google/clasp):

```sh
npm install
npx clasp login
cp .clasp.json.example .clasp.json   # then put in your script id (Apps Script → Project Settings → IDs)
npm run push                          # uploads src/ to the Apps Script project
```

After pushing, update the web app deployment (Deploy → Manage deployments → New version) so the URL serves the new code. The page in `web/` is published by GitHub Actions when it lands on `main`.

## Secrets

The TMDB token lives only in the Apps Script **Script Properties** (`TMDB_TOKEN`). Never commit it.

## Tests

```sh
npm test
```
