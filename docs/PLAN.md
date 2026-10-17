# Shared Blu-ray Library: Plan (draft v2)

A web app where friends browse the shared Blu-ray collection with covers, plots and details, and see who owns each disc and who has it right now.

**v2 changes:** the Google Sheet stays the source of truth, login is Google sign-in, and hosting runs on Steffen's Google account. The v1 stack (Next.js + Supabase + Vercel) is now the fallback, in section 8.

## 1. Recommended stack: a Google Apps Script web app

| Layer | Choice |
|---|---|
| Data | The **BluRay inventory** Google Sheet itself, plus two helper tabs the app manages |
| Backend | Google Apps Script attached to the sheet (`doGet` + server functions) |
| Frontend | A single-page app served by Apps Script's HtmlService (plain JS or Alpine.js, Tailwind via CDN) |
| Login | Google sign-in, built in. Deployed as "Execute as: user accessing the web app" |
| Hosting | Google, on Steffen's account, at a `script.google.com/macros/s/…/exec` URL |
| Metadata | TMDB API called from the script (`UrlFetchApp`), cached in a sheet tab |
| Code | Kept in GitHub and pushed to Apps Script with `clasp` (optional, but recommended) |

Cost is **0 €**, with no other accounts or services. There's no database to keep in sync, because every page load reads the sheet directly, so a manual edit shows up on the next refresh.

**Trade-offs, honestly:**
- The URL is a long `script.google.com` link, with no custom domain. A short redirect link can cover that.
- The app runs inside a Google iframe, and the first load takes about 1 to 3 seconds.
- On first use, each friend has to click through Google's "this app isn't verified" screen once. That's normal for private scripts.
- Friends need **edit access to the sheet**, because the app reads and writes as them (see section 4). For a friends' library that's a feature: who can use the app is simply who the sheet is shared with.
- Quotas are far beyond our needs: 20,000 external fetches per day and 30 simultaneous users.

## 2. The sheet as the source of truth

**`Tabellenblatt1` stays exactly as it is** (title, release date, disc type, type, notes, owner, where?) and remains the place to add, edit and remove discs by hand. The app adds two tabs:

| Tab | Purpose | Edited by |
|---|---|---|
| `Metadata` | One row per sheet row: row key, TMDB id(s), poster, plot, runtime, genres, cast, rating, IMDb id, fetched-at timestamp | The app. A human may override a TMDB id to fix a wrong match |
| `Loans` | History log: disc row key, from, to, lent at, returned at, note | The app (append-only) |

- **Current holder = the `where?` column.** When someone lends or returns a disc in the app, the app writes `where?` and appends a row to `Loans`. If someone edits `where?` by hand, the app shows that, and it logs the change the next time it notices it.
- **Row key:** sheet row numbers shift when rows are sorted or inserted, so the app keeps a hidden key column (H, for example `d-0042`) in `Tabellenblatt1` that it fills in automatically. This is the only change to the main tab.
- **Auto-refresh of metadata:** an hourly time trigger, plus an on-change trigger, looks for rows whose title or year changed or that have no metadata yet, and fetches them from TMDB. A manual edit to the sheet gets its poster and plot within minutes, with no action needed.

## 3. What the current data looks like

There are 107 rows and two owners (Steffen and Matthias), and one disc is currently lent out (*Back to the Future Trilogy*, at Matthias).

| `type` | How the app handles it |
|---|---|
| Film | TMDB movie search with title and year |
| Film collection (15 rows) | Members are listed in `notes`. Each one is matched as its own movie, and the box set shows as one disc with several films |
| TV season / TV series box set (8 rows) | TMDB TV search (Lost, The X-Files) and season details |

- **Disc formats:** `disc type` is a comma-separated list (HD / 4K / 3D Blu-ray). It's shown as badges and can be filtered.
- **Duplicates are fine:** the same film owned by both owners (Dune: Part Two, Gladiator, The Matrix), or two editions (Blade Runner 2049), appears as one movie card listing every copy.
- **Rows that need care:** a few titles won't match automatically, such as "Prestige" (TMDB lists it as *The Prestige*), "SAW - US Director's Cut", and "Dune (2021)". Fixing them only takes typing the TMDB id into the `Metadata` tab once. The app will list unmatched rows on an admin screen.

## 4. Login and permissions

- **Google sign-in** comes with the deployment. The app knows each user's email address, which is mapped to a display name (Steffen, Matthias, …) via a small `Users` tab or a script property.
- **Access control is the sheet's sharing settings.** Share the sheet with a friend as an editor, and the friend can use the app.
- **Why "execute as the user":** with "execute as me", Apps Script can't see a visitor's email address unless both people are in the same Google Workspace domain, so the app couldn't tell who's lending what. With "execute as user", it can, at the cost of the editor-access requirement and the one-time verification screen.
- **App-level rules on top:** only the owner, or whoever currently has a disc, can mark it returned, and lending is offered to the owner and the current holder.

## 5. Metadata: TMDB (unchanged recommendation)

IMDb has no free public API. TMDB is free for non-commercial use, has posters and German or English plots, and links to IMDb ids. OMDb's free tier has no posters. An optional free OMDb key can add the IMDb rating. TMDB requires showing its logo and attribution in the app. The API key is stored as a script property, not in the code.

## 6. Core screens (v1)

1. **Library:** poster grid with search and filters (owner, available or lent out, format, type, genre).
2. **Movie / box set detail:** plot, cast, ratings, IMDb link, and each copy with its owner, current location and loan history.
3. **Lend / return** buttons.
4. **My shelf:** what I own, what I've lent out, and what I'm borrowing.
5. **Admin:** unmatched or ambiguous rows, and a "refresh metadata" button.

## 7. Milestones

1. Create the Apps Script project bound to the sheet (Steffen does this once in the browser, and Claude supplies the code), set up `clasp` and the GitHub repo, and get a "hello + your email" page deployed.
2. Add the row keys, the `Metadata` tab, the TMDB matching and the triggers, and show the unmatched-rows report.
3. Build the library grid and detail pages.
4. Add lending: `where?` writes, the `Loans` log, and "My shelf".
5. Polish: mobile layout, the OMDb rating, and a short link.

## 8. Alternatives considered

| Option | Login | Live sheet | Cost | Why not first |
|---|---|---|---|---|
| **Apps Script** (recommended) | Google, built in | Yes, reads the sheet directly | 0 € | Ugly URL and slower first load |
| Firebase Hosting + Firebase Auth (Google) | Google | Needs the browser to call the Sheets API with each user's token, or Cloud Functions (Blaze plan, which needs a credit card) | 0 € on the Spark plan | More moving parts, and the same "unverified app" screen for Sheets access |
| Next.js on Vercel + Google OAuth + a service account | Google | The server reads the sheet, and an Apps Script on-edit hook triggers a refresh | 0 € | Not on Google, so a second account to manage, but the nicest URL and the best performance |

Moving later is cheap: the sheet stays the data, so any of these can replace the Apps Script front end without migrating anything.

## Open questions

- **Language:** English, German, or switchable? (TMDB has both.)
- **Group size and emails:** who should be in the `Users` mapping?
- **GitHub repository:** should Claude create one for the script code (via `clasp`)? Under which account, and with what name?
