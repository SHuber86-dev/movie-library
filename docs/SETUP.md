# Setting up the Movie Library (about 10 minutes)

All of this happens in your browser, signed in to the Google account that owns the **BluRay inventory** sheet.

## 1. Add the code to the sheet
1. Open the sheet, then go to **Extensions → Apps Script**. Name the project "Movie Library".
2. Click the **⚙ Project Settings** gear and tick **Show "appsscript.json" manifest file in editor**.
3. Back in the **Editor** (`< >` icon):
   - Replace everything in `Code.gs` with [src/Code.gs](../src/Code.gs).
   - Replace everything in `appsscript.json` with [src/appsscript.json](../src/appsscript.json).
   - Click **+ → HTML**, name the file `index` (not `index.html`), and paste in [src/index.html](../src/index.html).
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
   - creates the `Metadata`, `Loans` and `Users` tabs,
   - installs an hourly trigger, an on-change trigger and a 30-minute trigger that keeps the app fast,
   - fetches metadata for the first 40 discs.

   The triggers fetch the rest over the next couple of hours. Run `refreshMetadata` a few times if you don't want to wait.

## 4. Add your friends
In the new **Users** tab, add one row per person: their Google email and their name **exactly as it appears in the owner / where? columns** (for example `Matthias`). Setup already added you as Steffen.

## 5. Publish
1. Click **Deploy → New deployment → ⚙ → Web app**.
2. Set **Execute as: User accessing the web app** and **Who has access: Anyone with Google account**.
3. Click **Deploy** and copy the web app URL. That URL is the app.
4. **Share the sheet** with each friend as an **Editor**, then send them the URL. The first time they open it, they click through the same "unverified app" screen once.

## Fixing wrong or missing matches
Open the **Metadata** tab. Rows with `no match` in the `error` column, or with the wrong poster, can be fixed by hand:
1. Find the film on themoviedb.org. The number in its URL is the id, for example `themoviedb.org/movie/1124` is *The Prestige*.
2. Put `movie:1124` in `tmdb_ids`. For a TV season use `tv:<id>:<season>`, and list several ids, comma-separated, for a box set.
3. Set `manual` to `TRUE`, then clear `data_json` so it refetches on the next run, or run `refreshMetadata` right away.

## Day-to-day
- **Add, edit or remove discs in the sheet as usual.** The app shows changes on reload, and posters and plots for new rows appear within the hour.
- **Lending in the app** updates the `where?` column and logs the change in `Loans`. If you edit `where?` by hand, that's logged too, marked "edited in sheet".
- **After changing the code**, go to **Deploy → Manage deployments → ✎ → Version: New version → Deploy**. The URL stays the same.
