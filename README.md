# movie-library

Private Movie Library: a web app for a group of friends to browse their shared Blu-ray collection, with posters and movie details from TMDB, and to track who owns each disc and who has it right now.

It runs as a **Google Apps Script web app** bound to the "BluRay inventory" Google Sheet. The sheet stays the source of truth, and friends sign in with their Google account.

## Layout

| Path | What it is |
|---|---|
| `src/Code.gs` | Server: reads the sheet, keeps row keys, fetches TMDB metadata, handles lending |
| `src/index.html` | The web page: poster grid, filters, details, lend and return |
| `src/appsscript.json` | Manifest (runs as the signed-in user, open to Google accounts) |
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

After pushing, update the web app deployment (Deploy → Manage deployments → New version) so the URL serves the new code.

## Secrets

The TMDB token lives only in the Apps Script **Script Properties** (`TMDB_TOKEN`). Never commit it.

## Tests

```sh
npm test
```
