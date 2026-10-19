# Movie Library

**Movie Library** is a small, private web app where a group of friends browse and share their combined Blu-ray collection.

## What it does

- **Browse the collection:** every disc appears as a poster in a searchable grid. You can filter by owner, format (HD, 4K, 3D), type (film, box set, TV) and whether a disc is available or lent out.
- **See the details:** each movie has its plot, runtime, genres, director, main cast, rating and a link to IMDb. Box sets show every film they contain.
- **Track who has what:** each disc shows who owns it and where it is right now. The owner or current holder can lend it to a friend or mark it returned with one click, and every handover is kept in a history.
- **My shelf:** one view shows what you own, what you've lent out and what you're currently borrowing.

## How it works

- **The Google Sheet is the source of truth.** Discs are added and edited in the familiar spreadsheet, and the app always shows its current state.
- **Movie information comes from TMDB** (The Movie Database). It's fetched automatically for new or changed entries.
- **Friends sign in with their Google account.** Only people the sheet is shared with can use the app.
- **It runs for free:** the page is hosted on GitHub Pages, and a small Google Apps Script on the owner's account reads and writes the sheet. There are no servers to run and no costs.

## Who it's for

It's a non-commercial hobby project for a handful of friends, with no public access, ads or data sharing.
