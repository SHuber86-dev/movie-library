# Setting up the Movie Library (about 15 minutes)

All of this happens in your browser, signed in to the Google account that owns the **BluRay inventory** sheet.

The app has two parts: the **page** at `https://shuber86-dev.github.io/movie-library/`, published from `web/` by GitHub Actions, and a small **Apps Script API** bound to the sheet, which the page talks to.

## 1. Add the code to the sheet
1. Open the sheet, then go to **Extensions → Apps Script**. Name the project "Movie Library".
2. Click the **⚙ Project Settings** gear and tick **Show "appsscript.json" manifest file in editor**.
3. Back in the **Editor** (`< >` icon):
   - Replace everything in `Code.gs` with [src/Code.gs](../src/Code.gs).
   - Replace everything in `appsscript.json` with [src/appsscript.json](../src/appsscript.json).
   - If there is still an `index.html` file from the old version, delete it (⋮ → Delete).
4. Click **💾 Save**.

## 2. Add your TMDB key (keep it out of chat)
1. Create a free account at themoviedb.org, then go to **Settings → API** and request an API key with the type "Personal". Copy the **API Read Access Token**, which is the long one.
2. In Apps Script, open **⚙ Project Settings → Script Properties → Add script property**:
   - `TMDB_TOKEN` = the token
   - `LANGUAGE` = `en-US` or `de-DE`, for the language of the plots and titles

## 3. Run setup once
1. In the Editor, pick `setup` in the function dropdown and click **Run**.
2. Google asks for permission. Click **Advanced → Go to Movie Library (unsafe)**. That's expected for your own, unpublished script.
3. Setup:
   - adds a hidden `id` column to your inventory tab,
   - creates the `Metadata`, `Loans`, `Users`, `Household`, `Seen`, `Requests` and `Wishlist` tabs,
   - installs an hourly trigger, an on-change trigger and a 30-minute trigger that keeps the app fast,
   - fetches metadata for the first 40 discs.

   The triggers fetch the rest over the next couple of hours. Run `refreshMetadata` a few times if you don't want to wait.

## 4. Google sign-in (OAuth client)
In [Google Cloud Console](https://console.cloud.google.com/) → **Google Auth Platform**:
1. **Clients → Create client**, type **Web application**. Under **Authorized JavaScript origins** add exactly `https://shuber86-dev.github.io` (no path, no trailing slash). Redirect URIs stay empty.
2. Copy the **Client ID**. It goes in two places: `CLIENT_ID` near the top of `Code.gs`, and `clientId` in [web/config.js](../web/config.js).
3. **Audience:** leave the app in **Testing** and add yourself and each friend under **Test users**. Only test users can sign in.

## 5. Add your friends
1. In the new **Users** tab, add one row per person: their Google email and their name **exactly as it appears in the owner / where? columns** (for example `Matthias`). Setup already added you as Steffen.
2. A person can use the app if their email is in the Users tab or the sheet is shared with them. Since the API writes to the sheet as you, friends no longer need edit access to the sheet.

## 6. Publish the API
1. Click **Deploy → New deployment → ⚙ → Web app**.
2. Set **Execute as: Me** and **Who has access: Anyone**. "Anyone" is needed so the page can reach it; the script itself only answers people who signed in with Google and have access.
3. Click **Deploy** and copy the **Web app URL** (it ends in `/exec`).
4. On GitHub, open [web/config.js](../web/config.js), click ✎, paste the URL as `apiUrl`, and commit to `main`. The **Publish site** action puts the page online within a minute or two.
5. Send your friends `https://shuber86-dev.github.io/movie-library/`. They sign in with Google; the first time, Google shows an "unverified app" notice, which is expected for an app in Testing.

## Fixing wrong or missing matches
Open the **Metadata** tab. Rows with `no match` in the `error` column, or with the wrong poster, can be fixed by hand:
1. Find the film on themoviedb.org. The number in its URL is the id, for example `themoviedb.org/movie/1124` is *The Prestige*.
2. Put `movie:1124` in `tmdb_ids`. For a TV season use `tv:<id>:<season>`, and list several ids, comma-separated, for a box set.
3. Set `manual` to `TRUE`, then clear `data_json` so it refetches on the next run, or run `refreshMetadata` right away.

## Day-to-day
- **Add, edit or remove discs in the sheet as usual.** The app shows changes on reload, and posters and plots for new rows appear within the hour.
- **Lending in the app** updates the `where?` column and logs the change in `Loans`. If you edit `where?` by hand, that's logged too, marked "edited in sheet".
- **Seen by:** each person can add their household (kids, a partner) under **Household** in the app, then tick who has seen a movie in its details. This is stored in the `Household` and `Seen` tabs, which the app creates on first use.
- **Requests:** anyone can request a disc they don't have (an owner can ask for a lent-out disc back), with an optional note. **Requests** in the header lists what you've been asked to bring, grouped by person, and what you've asked others for. A request closes when the disc is lent to the person who asked, or when it's cancelled or declined. Requests are stored in the `Requests` tab.
- **Wishlist:** one list everyone shares, separate from the library. Switch between **Library** and **Wishlist** at the top; the wishlist is a poster grid you can filter by movie or series and by who added it, and sort by date, title or year. Its search box also searches TMDB for movies and series to add (pasting an IMDb link or `tt…` id works too); anyone can remove a title, for example once someone has bought it. Titles already in the library are marked. The list is stored in the `Wishlist` tab, which the app creates on first use.
- **After changing `Code.gs`**, go to **Deploy → Manage deployments → ✎ → Version: New version → Deploy**. The URL stays the same, so `config.js` needs no change.
- **After changing the page** (`web/`), merging to `main` republishes it automatically.
