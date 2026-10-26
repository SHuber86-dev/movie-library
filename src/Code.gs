/**
 * Movie Library: Google Apps Script bound to the "BluRay inventory" sheet. It serves a small JSON API
 * (doPost) for the page hosted on GitHub Pages, which signs people in with Google.
 *
 * The inventory tab stays the source of truth. The script adds:
 *   - a hidden key column ("id") in the inventory tab, so rows can be sorted safely
 *   - "Metadata": TMDB data cached per disc (edit tmdb_ids + set manual=TRUE to fix a match)
 *   - "Loans":    append-only lending history
 *   - "Users":    email -> display name mapping for sign-in
 *   - "Household": the people each user marks movies for (their kids, a partner), as plain names
 *   - "Seen":      who has seen which movie, one row per person and movie
 *   - "Requests":  requests to borrow a disc (or to get it back), with their status
 *   - "Wishlist":  movies and series people want, shared by everyone and separate from the library
 *   - a "source" column in the inventory tab, for digitally owned titles ("Digital" in the disc type column)
 *   - a "link" column in the inventory tab, for an optional streaming URL of a digital title
 *
 * Script properties: TMDB_TOKEN (TMDB "API Read Access Token"), LANGUAGE (e.g. en-US, de-DE).
 */

var INVENTORY_SHEET = 'Tabellenblatt1';
var METADATA_SHEET = 'Metadata';
var LOANS_SHEET = 'Loans';
var USERS_SHEET = 'Users';
var KEY_HEADER = 'id';
var METADATA_HEADERS = ['id', 'title_seen', 'year_seen', 'tmdb_ids', 'manual', 'data_json', 'fetched_at', 'where_seen', 'error'];
var LOANS_HEADERS = ['id', 'title', 'from', 'to', 'at', 'by', 'note'];
var USERS_HEADERS = ['email', 'name'];
var HOUSEHOLD_SHEET = 'Household';
var HOUSEHOLD_HEADERS = ['email', 'name'];
var SEEN_SHEET = 'Seen';
var SEEN_HEADERS = ['movie', 'title', 'email', 'person', 'at'];
var REQUESTS_SHEET = 'Requests';
var REQUESTS_HEADERS = ['id', 'disc', 'title', 'by', 'note', 'at', 'status', 'closed_at', 'closed_by'];
var WISHLIST_SHEET = 'Wishlist';
var WISHLIST_HEADERS = ['ref', 'title', 'year', 'poster', 'imdb_id', 'by', 'at'];
var MAX_WISHES = 500;
var DISC_FORMATS = ['HD Blu Ray', '4k Blu Ray', '3D Blu Ray'];
var DIGITAL = 'Digital'; // the disc type of a digitally owned title; only its owner ever sees it
var DIGITAL_SOURCES = ['Netflix', 'Amazon Prime Video', 'Apple TV', 'Disney+', 'Google Play / YouTube', 'Sky / WOW', 'Rakuten TV', 'Paramount+'];
var SOURCE_HEADER = 'source';
var MAX_SOURCE = 40;
var LINK_HEADER = 'link'; // an optional streaming URL of a digital title, opened instead of the platform searches
var MAX_LINK = 500;
var SEARCH_RESULTS = 12;
var SEARCH_CACHE_SECONDS = 21600; // TMDB search answers are cached for 6 hours
var MAX_NAME = 40;
var MAX_SEEN_CHANGES = 200;
var MAX_NOTE = 200;
var MAX_FETCHES_PER_RUN = 40;
var DATA_VERSION = 4;     // bump when buildData_ adds fields, so older cached rows are fetched again (2: trailers, 3: genre ids, 4: German titles)
var CACHE_KEY = 'library';
var CACHE_SECONDS = 3600; // safety net; lending and sheet changes clear the cache right away
var WARM_MINUTES = 30;    // warmLibraryCache refills the cache well before it expires
var CACHE_CHUNK = 90000;  // CacheService values are limited to 100 KB each; the cached JSON is kept to ASCII, so characters are bytes
var REV_KEY = 'rev';         // script property: goes up on every change, so a page can tell an older answer from a newer one
var LIB_REV_KEY = 'libRev';  // script property: goes up when the shared library changes; the cached copy is tagged with it
var REFRESH_AGAIN_KEY = 'refreshAgain';
var REFRESH_ROUNDS = 3;
var DENIED_SECONDS = 60;

// ---------- Web app (JSON API for the page on GitHub Pages) ----------

// The OAuth client the page signs in with. ID tokens for any other client are refused.
var CLIENT_ID = '1037650089841-ob1jsnl3mdtgiicenup02ckc80tsmfsi.apps.googleusercontent.com';
var ACCESS_SECONDS = 600; // how long the list of people with access is cached

/** Health check, so opening the /exec URL in a browser shows that the API is up. */
function doGet() {
  return json_({ ok: true, app: 'movie-library' });
}

/**
 * Every request is a POST with a text/plain JSON body (no CORS preflight):
 *   { action: 'library', token: <Google ID token>, have }  -> { unchanged: true, rev } when have is still the newest rev
 *   { action: 'lend' | 'return', token, key, to, seenWhere }
 *   { action: 'seen', token, changes: [{ movie, title, person, seen: true | false }, ...], reply: 'personal' }
 *                                                  -> with reply 'personal', only { rev, seen, household }
 *   { action: 'household', token, names: [...] }
 *   { action: 'request', token, key, note }
 *   { action: 'closeRequest', token, id, how: 'cancel' | 'decline' }
 *   { action: 'search', token, q }                 -> TMDB movies and series, not the library
 *   { action: 'wish' | 'unwish', token, ref }      ref like "movie:603" or "tv:1396"
 *   { action: 'addDisc', token, ref, formats: [...], season, notes, unwish } -> a new disc owned by the signed-in user
 *   { action: 'addDisc', token, ref, digital: true, sources: [...], other, link, season, notes, unwish } -> a digital title instead
 *   { action: 'setLink', token, key, link }       -> sets or clears the streaming link of the owner's digital title
 *   { action: 'watch', token, ref }                 -> { link, providers: [...] }, where TMDB says the title streams
 *   { action: 'findLink', token, key }            -> looks up and saves the streaming link of the owner's digital title
 *   { action: 'removeDisc', token, key, seenWhere } -> deletes the owner's disc from the inventory tab
 * Answers { ok: true, data: <library> } or { ok: false, code: 'signin' | 'denied' | 'error', error }.
 * Every library answer carries rev, so the page can drop an answer that is older than what it shows.
 */
function doPost(e) {
  var req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, code: 'error', error: 'Bad request.' });
  }
  try {
    var email = verifyIdToken_(req.token);
    if (!hasAccess_(email)) {
      return json_({ ok: false, code: 'denied', error: email + ' has no access to this library. Ask the owner to share the sheet with you.' });
    }
    var user = currentUser_(email);
    if (req.action === 'library') return json_({ ok: true, data: getLibrary_(user, req.have) });
    if (req.action === 'lend') return json_({ ok: true, data: lendDisc(req.key, req.to, req.seenWhere, user) });
    if (req.action === 'return') return json_({ ok: true, data: returnDisc(req.key, req.seenWhere, user) });
    if (req.action === 'seen') return json_({ ok: true, data: markSeen(req.changes || [req], user, req.reply) }); // [req]: pages from before batching
    if (req.action === 'household') return json_({ ok: true, data: setHousehold(req.names, user) });
    if (req.action === 'request') return json_({ ok: true, data: requestDisc(req.key, req.note, user) });
    if (req.action === 'closeRequest') return json_({ ok: true, data: closeRequest(req.id, req.how, user) });
    if (req.action === 'search') return json_({ ok: true, data: searchTitles(req.q) });
    if (req.action === 'wish') return json_({ ok: true, data: addWish(req.ref, user) });
    if (req.action === 'unwish') return json_({ ok: true, data: removeWish(req.ref, user) });
    if (req.action === 'addDisc') return json_({ ok: true, data: addDisc(req, user) });
    if (req.action === 'setLink') return json_({ ok: true, data: setLink(req.key, req.link, user) });
    if (req.action === 'watch') return json_({ ok: true, data: watchProviders(req.ref) });
    if (req.action === 'findLink') return json_({ ok: true, data: findLink(req.key, user) });
    if (req.action === 'removeDisc') return json_({ ok: true, data: removeDisc(req.key, req.seenWhere, user) });
    return json_({ ok: false, code: 'error', error: 'Unknown action.' });
  } catch (err) {
    return json_({ ok: false, code: err.code || 'error', error: String(err.message || err) });
  }
}

function json_(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}

// ---------- Sign-in ----------

/** Checks a Google ID token with Google and returns its email. Verified tokens are cached until they expire. */
function verifyIdToken_(token) {
  if (!token) throw signInError_('Please sign in.');
  var cache = CacheService.getScriptCache();
  var key = 'tok:' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token));
  var hit = cache.get(key);
  if (hit) return hit;
  var res = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(token), { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw signInError_('Your sign-in has expired. Please sign in again.');
  var info = JSON.parse(res.getContentText());
  var email = checkTokenInfo(info, CLIENT_ID, Date.now());
  var ttl = Math.min(21600, Math.floor(+info.exp - Date.now() / 1000) - 60);
  if (ttl > 0) cache.put(key, email, ttl);
  return email;
}

/** Validates Google's tokeninfo answer: our client, issued by Google, a verified email, not expired. */
function checkTokenInfo(info, clientId, nowMs) {
  if (!info || info.aud !== clientId) throw signInError_('This sign-in is for a different app.');
  if (info.iss !== 'accounts.google.com' && info.iss !== 'https://accounts.google.com') throw signInError_('Sign-in not issued by Google.');
  if (String(info.email_verified) !== 'true' || !info.email) throw signInError_('Your Google email is not verified.');
  if (!(+info.exp * 1000 > nowMs)) throw signInError_('Your sign-in has expired. Please sign in again.');
  return String(info.email).toLowerCase();
}

function signInError_(message) {
  var e = new Error(message);
  e.code = 'signin';
  return e;
}

/**
 * People the sheet is shared with, plus everyone in the Users tab. A miss rereads the list, so new shares work at once;
 * a refused email is remembered for a minute, so it doesn't reread the sharing list on every call.
 */
function hasAccess_(email) {
  var cache = CacheService.getScriptCache();
  var cached = cache.get('access');
  if (cached && JSON.parse(cached).indexOf(email) >= 0) return true;
  if (cache.get('denied:' + email)) return false;
  var list = accessList_();
  cache.put('access', JSON.stringify(list), ACCESS_SECONDS);
  var ok = list.indexOf(email) >= 0;
  if (!ok) cache.put('denied:' + email, '1', DENIED_SECONDS);
  return ok;
}

function accessList_() {
  var emails = Object.keys(usersByEmail_(true));
  try {
    var ss = SpreadsheetApp.getActive();
    ss.getEditors().concat(ss.getViewers()).forEach(function (u) { emails.push(u.getEmail()); });
  } catch (e) {
    // Without the sharing list, the Users tab alone decides.
  }
  return emails.map(function (x) { return String(x || '').trim().toLowerCase(); }).filter(Boolean);
}

/** The Users tab as { email: name }, cached like the access list. fresh rereads the tab. */
function usersByEmail_(fresh) {
  var cache = CacheService.getScriptCache();
  var hit = fresh ? null : cache.get('users');
  if (hit) return JSON.parse(hit);
  var users = {};
  readTable_(sheet_(USERS_SHEET, USERS_HEADERS)).rows.forEach(function (u) {
    var email = String(u.email || '').trim().toLowerCase();
    if (email && !(email in users)) users[email] = String(u.name || '');
  });
  cache.put('users', JSON.stringify(users), ACCESS_SECONDS);
  return users;
}

/**
 * Everything the page needs in one call. The shared part is cached; the user is looked up per call.
 * have is the rev of the copy the page already has: if nothing changed since, the answer says so instead.
 */
function getLibrary_(user, have) {
  var revs = revs_(); // read first, so the data below is at least as new as the rev it is sent with
  if (have && +have === revs.rev) return { unchanged: true, rev: revs.rev };
  var shared = readLibraryCache_(revs.lib);
  if (!shared) {
    shared = buildLibrary_();
    writeLibraryCache_(shared, revs.lib);
  }
  var mine = personalData_(user);
  return { rev: revs.rev, user: user, people: shared.people, categories: shared.categories, discs: visibleDiscs(shared.discs, user.name), household: mine.household, seen: mine.seen, wishlist: readWishlist_() };
}

/** Only the signed-in user's household and seen marks, for the answer to a tick. */
function personalAnswer_(user) {
  var rev = revs_().rev;
  var mine = personalData_(user);
  return { rev: rev, household: mine.household, seen: mine.seen };
}

// ---------- Changes ----------
// Every change runs under the script lock and then raises the rev, even when it fails halfway. The page uses the rev
// to drop answers older than what it shows, and the cached library is only used while its tag matches libRev.

function revs_() {
  var p = PropertiesService.getScriptProperties().getProperties();
  return { rev: +p[REV_KEY] || 0, lib: +p[LIB_REV_KEY] || 0 };
}

/** shared: the change is to the cached library (discs, loans, requests), not only to someone's marks or the wishlist. Callers hold the lock. */
function bumpRev_(shared) {
  var now = revs_();
  var next = {};
  next[REV_KEY] = String(now.rev + 1);
  if (shared) next[LIB_REV_KEY] = String(now.lib + 1);
  PropertiesService.getScriptProperties().setProperties(next);
  if (shared) clearLibraryCache_();
}

function write_(shared, fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    return fn();
  } finally {
    try { bumpRev_(shared); } finally { lock.releaseLock(); }
  }
}

/** Deletes sheet rows by number, one call per run of neighbouring rows, bottom first so the numbers stay right. */
function deleteRows_(sh, rowIndexes) {
  var rows = rowIndexes.slice().sort(function (a, b) { return b - a; });
  for (var i = 0; i < rows.length;) {
    var j = i;
    while (j + 1 < rows.length && rows[j + 1] === rows[j] - 1) j++;
    sh.deleteRows(rows[j], j - i + 1);
    i = j + 1;
  }
}

/** Appends rows in one call. Unlike appendRow, a range can't reach past the grid, so the grid grows first when needed. */
function appendRows_(sh, rows) {
  if (!rows.length) return;
  var first = sh.getLastRow() + 1;
  var short = first + rows.length - 1 - sh.getMaxRows();
  if (short > 0) sh.insertRowsAfter(sh.getMaxRows(), short);
  sh.getRange(first, 1, rows.length, rows[0].length).setValues(rows);
}

// ---------- Wishlist ----------
// One list for everyone: any signed-in person can search TMDB, add a movie or series, and remove one
// (for example once someone has bought it). It is kept apart from the inventory tab, so it never shows up in the library.

/** Searches TMDB for movies and series. An IMDb id or link (tt1234567) is looked up directly. */
function searchTitles(q) {
  q = String(q || '').replace(/\s+/g, ' ').trim().slice(0, 100);
  if (q.length < 2) return [];
  var lang = PropertiesService.getScriptProperties().getProperty('LANGUAGE') || 'en-US';
  var cache = CacheService.getScriptCache();
  var key = 'search:' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, lang + '|' + q.toLowerCase()));
  var hit = cache.get(key);
  if (hit) return JSON.parse(hit);
  var imdb = parseImdbId(q);
  var results;
  if (imdb) {
    var found = tmdb_('/find/' + imdb, { external_source: 'imdb_id' });
    results = (found.movie_results || []).map(function (r) { r.media_type = 'movie'; return r; })
      .concat((found.tv_results || []).map(function (r) { r.media_type = 'tv'; return r; }));
  } else {
    results = tmdb_('/search/multi', { query: q, include_adult: 'false' }).results || [];
  }
  var out = searchResults(results);
  try { cache.put(key, JSON.stringify(out), SEARCH_CACHE_SECONDS); } catch (e) {}
  return out;
}

/** Adds a title to the wishlist. Title, year and poster come from TMDB, not from the page. */
function addWish(ref, user) {
  ref = checkWishRef(ref);
  var info = wishDetails_(ref); // before the lock: it calls TMDB
  write_(false, function () {
    var sh = sheet_(WISHLIST_SHEET, WISHLIST_HEADERS);
    var rows = readTable_(sh).rows;
    if (!rows.some(function (r) { return r.ref === ref; })) {
      if (rows.length >= MAX_WISHES) throw new Error('The wishlist is full. Remove a few titles first.');
      sh.appendRow([ref, cleanNote(info.title), info.year, info.poster, info.imdbId, user.name, new Date()]);
    }
  });
  return getLibrary_(user);
}

function removeWish(ref, user) {
  ref = checkWishRef(ref);
  write_(false, function () { removeWishRows_(ref); });
  return getLibrary_(user);
}

/** Callers hold the lock. */
function removeWishRows_(ref) {
  var sh = sheet_(WISHLIST_SHEET, WISHLIST_HEADERS);
  var remove = [];
  readTable_(sh).rows.forEach(function (r, i) { if (r.ref === ref) remove.push(i + 2); });
  deleteRows_(sh, remove);
}

function wishDetails_(ref) {
  var p = ref.split(':');
  var t = p[0] === 'tv' ? tmdb_('/tv/' + p[1], { append_to_response: 'external_ids' }) : tmdb_('/movie/' + p[1], {});
  return {
    title: t.title || t.name || '',
    year: (t.release_date || t.first_air_date || '').slice(0, 4),
    poster: t.poster_path || '',
    imdbId: (p[0] === 'tv' ? t.external_ids && t.external_ids.imdb_id : t.imdb_id) || ''
  };
}

/** The wishlist, newest first. */
function readWishlist_() {
  return readTable_(sheet_(WISHLIST_SHEET, WISHLIST_HEADERS)).rows.filter(function (r) { return r.ref; }).map(function (r) {
    var p = String(r.ref).split(':');
    return {
      ref: String(r.ref), kind: p[0], tmdbId: +p[1], title: String(r.title), year: String(r.year || ''), poster: String(r.poster || ''),
      imdbId: String(r.imdb_id || ''), by: String(r.by || ''), at: r.at instanceof Date ? r.at.toISOString() : String(r.at || '')
    };
  }).reverse();
}

// ---------- Adding discs ----------
// A disc found on TMDB is added as a new row of the inventory tab, owned by and at the person who adds it, so it
// looks just like a row typed in by hand. Its Metadata row is written at once with the chosen TMDB id (manual=TRUE),
// so the poster shows straight away and the hourly match never replaces the person's pick.
// A digitally owned title is a row like any other, with "Digital" as its disc type and where it is in "source".

function addDisc(input, user) {
  var row = discRow(input);
  var tmdbRef = row.season ? row.ref + ':' + row.season : row.ref;
  var data;
  try {
    data = buildData_(null, [tmdbRef]); // before the lock: it calls TMDB
  } catch (e) {
    if (row.season && /TMDB 404/.test(e.message)) throw new Error('TMDB has no season ' + row.season + ' of this series.');
    throw e;
  }
  var item = data.items[0];
  var title = row.season ? item.title.slice(0, item.title.lastIndexOf(' – ')) + ' – Season ' + row.season : item.title;
  write_(true, function () {
    ensureKeys(); // makes sure the key column exists
    if (row.sources.length) ensureColumn_(SOURCE_HEADER);
    if (row.link) ensureColumn_(LINK_HEADER);
    var inv = readInventory_();
    var values = [];
    for (var c = 0; c < inv.sheet.getLastColumn(); c++) values.push('');
    var set = function (col, v) { if (col >= 0) values[col] = v; };
    set(inv.cols.title, cleanNote(title));
    set(inv.cols.year, item.year);
    set(inv.cols.disc, row.formats.join(', '));
    set(inv.cols.type, row.type);
    set(inv.cols.notes, row.notes);
    set(inv.cols.source, row.sources.join(', '));
    set(inv.cols.link, row.link);
    set(inv.cols.owner, user.name);
    set(inv.cols.where, user.name);
    inv.sheet.appendRow(values);
    ensureKeys(); // gives the new row its key
    var added = readInventory_().rows.filter(function (r) { return r.title; }).pop();
    sheet_(METADATA_SHEET, METADATA_HEADERS).appendRow([added.key, added.title, added.yearRaw, tmdbRef, true, JSON.stringify(data), new Date(), user.name, '']);
    if (input.unwish) removeWishRows_(row.ref);
  });
  return getLibrary_(user);
}

// ---------- Removing discs ----------
// Only the owner can remove a disc, and only while it is at their place, so nobody loses track of a lent-out disc.
// Its row leaves the inventory tab; its Metadata row stays, so the key is never handed to a new disc. The Loans tab
// gets a last "removed" line as a record, and open requests for the disc are closed.

/** Sets (or, when empty, clears) the streaming link of the signed-in user's own digital title. */
function setLink(key, link, user) {
  link = cleanLink(link);
  write_(true, function () {
    if (link) ensureColumn_(LINK_HEADER);
    var inv = readInventory_();
    var row = inv.rows.filter(function (r) { return r.key === key && r.title && canSee_(r, user); })[0];
    if (!row || !row.digital) throw new Error('Digital title not found. Reload the page.');
    if (user.name !== row.owner) throw new Error('Only ' + row.owner + ' can change this link.');
    if (inv.cols.link >= 0) inv.sheet.getRange(row.rowIndex, inv.cols.link + 1).setValue(link);
  });
  return getLibrary_(user);
}

function removeDisc(key, seenWhere, user) {
  write_(true, function () {
    var inv = readInventory_();
    var row = inv.rows.filter(function (r) { return r.key === key && r.title && canSee_(r, user); })[0];
    if (!row) throw new Error('Disc not found. Reload the page.');
    var holder = row.where || row.owner;
    if (seenWhere && seenWhere !== holder) {
      throw new Error(row.title + ' is now at ' + holder + '. The page has been refreshed, please try again.');
    }
    if (user.name !== row.owner) throw new Error('Only ' + row.owner + ' can remove this disc.');
    if (holder !== row.owner) throw new Error(row.title + ' is at ' + holder + '. Mark it returned before removing it.');
    inv.sheet.deleteRow(row.rowIndex);
    sheet_(LOANS_SHEET, LOANS_HEADERS).appendRow([key, row.title, holder, '', new Date(), user.name, 'removed from library']);
    var rsh = sheet_(REQUESTS_SHEET, REQUESTS_HEADERS);
    readTable_(rsh).rows.forEach(function (r, i) {
      if (r.disc === key && r.status === 'open') setRequestStatus_(rsh, i + 2, 'removed', user.name);
    });
  });
  return getLibrary_(user);
}

// ---------- Seen ----------
// Movies are keyed like the page groups them: "movie:<tmdb id>", or "disc:<row key>" for TV seasons and
// discs without movie data. Each user marks themselves and their own household; nobody else sees those marks.

/** The signed-in user's household names and { movie: [people who saw it] }. */
function personalData_(user) {
  var household = readHousehold_(user);
  var seen = {};
  readTable_(sheet_(SEEN_SHEET, SEEN_HEADERS)).rows.forEach(function (r) {
    if (String(r.email).toLowerCase() !== user.email || !r.movie) return;
    (seen[r.movie] = seen[r.movie] || []).push(String(r.person));
  });
  return { household: household, seen: seen };
}

function readHousehold_(user) {
  return readTable_(sheet_(HOUSEHOLD_SHEET, HOUSEHOLD_HEADERS)).rows.filter(function (r) {
    return String(r.email).toLowerCase() === user.email && r.name;
  }).map(function (r) { return String(r.name); });
}

/**
 * Applies a batch of ticks and unticks from the page. Each change says what the mark should be, not "toggle",
 * so the page can safely send a batch again if it never saw the answer. Changes for people who are no longer
 * in the household are skipped; the last change for the same movie and person wins.
 * With reply 'personal' the answer is only the user's marks and household, not the whole library.
 */
function markSeen(changes, user, reply) {
  if (!Array.isArray(changes) || changes.length > MAX_SEEN_CHANGES) throw new Error('Bad seen list.');
  write_(false, function () {
    var allowed = [user.name].concat(readHousehold_(user));
    var wanted = {};
    changes.forEach(function (c) {
      if (!c || !/^(movie|disc):[\w-]+$/.test(String(c.movie || '')) || allowed.indexOf(c.person) < 0) return;
      wanted[c.movie + '\n' + c.person] = c;
    });
    var sh = sheet_(SEEN_SHEET, SEEN_HEADERS);
    var existing = {};
    readTable_(sh).rows.forEach(function (r, i) {
      if (String(r.email).toLowerCase() !== user.email) return;
      var k = r.movie + '\n' + r.person;
      (existing[k] = existing[k] || []).push(i + 2);
    });
    var remove = [];
    var add = [];
    Object.keys(wanted).forEach(function (k) {
      var c = wanted[k];
      if (c.seen && !existing[k]) add.push([c.movie, String(c.title || '').slice(0, 200), user.email, c.person, new Date()]);
      if (!c.seen && existing[k]) remove = remove.concat(existing[k]);
    });
    deleteRows_(sh, remove);
    appendRows_(sh, add);
  });
  return reply === 'personal' ? personalAnswer_(user) : getLibrary_(user);
}

/** Replaces the user's household list. Marks for removed names stay in the sheet and come back if the name is added again. */
function setHousehold(names, user) {
  var clean = cleanHousehold(names, user.name);
  write_(false, function () {
    var sh = sheet_(HOUSEHOLD_SHEET, HOUSEHOLD_HEADERS);
    var remove = [];
    readTable_(sh).rows.forEach(function (r, i) { if (String(r.email).toLowerCase() === user.email) remove.push(i + 2); });
    deleteRows_(sh, remove);
    appendRows_(sh, clean.map(function (n) { return [user.email, n]; }));
  });
  return getLibrary_(user);
}

/**
 * A disc without movie data has its marks under "disc:<key>". Once it is matched to movies, the marks move to
 * "movie:<tmdb id>", where the page now looks. They stay under the disc key too while the disc also holds a series.
 * moves: [{ from: 'disc:d-0012', to: ['movie:603'], keep: false }]. Callers hold the lock.
 */
function moveSeen_(moves) {
  if (!moves.length) return;
  var sh = sheet_(SEEN_SHEET, SEEN_HEADERS);
  var rows = readTable_(sh).rows;
  var have = {};
  var mark = function (movie, r) { return movie + '\n' + String(r.email).toLowerCase() + '\n' + r.person; };
  rows.forEach(function (r) { have[mark(r.movie, r)] = true; });
  var add = [];
  var remove = [];
  moves.forEach(function (m) {
    rows.forEach(function (r, i) {
      if (r.movie !== m.from) return;
      m.to.forEach(function (to) {
        if (have[mark(to, r)]) return;
        have[mark(to, r)] = true;
        add.push([to, r.title, r.email, r.person, r.at]);
      });
      if (!m.keep) remove.push(i + 2);
    });
  });
  deleteRows_(sh, remove);
  appendRows_(sh, add);
}

/** The keys the page files marks under for a disc with this TMDB data (see seenKey in the page). */
function movieSeenKeys(data) {
  var items = (data && data.items) || [];
  return items.filter(function (i) { return i.kind === 'movie'; }).map(function (i) { return 'movie:' + i.tmdbId; });
}

function hasSeries(data) {
  return ((data && data.items) || []).some(function (i) { return i.kind !== 'movie'; });
}

function buildLibrary_() {
  var inv = readInventory_();
  var meta = readMetadata_();
  var loans = groupBy_(readTable_(sheet_(LOANS_SHEET, LOANS_HEADERS)).rows, 'id');
  var requests = groupBy_(readTable_(sheet_(REQUESTS_SHEET, REQUESTS_HEADERS)).rows.filter(function (q) { return q.status === 'open'; }), 'disc');
  var people = {};
  readTable_(sheet_(USERS_SHEET, USERS_HEADERS)).rows.forEach(function (u) { if (u.name) people[u.name] = true; });

  var discs = inv.rows.filter(function (r) { return r.title; }).map(function (r) {
    if (r.owner && !r.digital) people[r.owner] = true;
    if (r.where && !r.digital) people[r.where] = true;
    var m = meta[r.key];
    var where = r.where || r.owner;
    return {
      key: r.key,
      title: r.title,
      years: r.years,
      formats: r.formats,
      digital: r.digital,
      sources: r.sources,
      link: r.link,
      type: r.type,
      notes: r.notes,
      owner: r.owner,
      where: where,
      // A request by whoever has the disc now was met by a hand edit of "where?".
      requests: (requests[r.key] || []).filter(function (q) { return q.by !== where; }).map(function (q) {
        return { id: q.id, by: q.by, note: q.note, at: q.at instanceof Date ? q.at.toISOString() : String(q.at) };
      }),
      meta: m && m.data_json ? withCategories_(JSON.parse(m.data_json)) : null,
      history: (loans[r.key] || []).map(function (l) {
        return { from: l.from, to: l.to, at: l.at instanceof Date ? l.at.toISOString() : String(l.at), by: l.by, note: l.note };
      })
    };
  });

  return { people: Object.keys(people).sort(), categories: CATEGORY_ORDER.concat([OTHER_CATEGORY]), discs: discs };
}

/** Rows grouped by one field, { value: [rows in sheet order] }, so a lookup per disc doesn't scan the whole tab. */
function groupBy_(rows, field) {
  var out = {};
  rows.forEach(function (r) {
    var k = String(r[field]);
    (out[k] = out[k] || []).push(r);
  });
  return out;
}

/** Everyone sees every disc; a digital title only reaches its owner, since it can't be lent. */
function visibleDiscs(discs, name) {
  return discs.filter(function (d) { return !d.digital || d.owner === name; });
}

/** For actions by key: someone else's digital title is treated as if it didn't exist. */
function canSee_(row, user) {
  return !row.digital || row.owner === user.name;
}

// ---------- Genre categories ----------

// TMDB genres grouped into a few coarse categories for the "By genre" view, in display order.
// Keyed by TMDB genre id, so they work whatever LANGUAGE the genre names come in. Movie and TV ids share one list.
var GENRE_CATEGORIES = {
  'Action & Adventure': [28, 12, 10752, 37, 10759, 10768], // Action, Adventure, War, Western; TV: Action & Adventure, War & Politics
  'Sci-Fi & Fantasy': [878, 14, 10765],                     // Science Fiction, Fantasy; TV: Sci-Fi & Fantasy
  'Comedy': [35],
  'Crime & Thriller': [80, 53, 9648],                       // Crime, Thriller, Mystery
  'Horror': [27],
  'Drama': [18, 36, 10402, 10770, 10766],                   // Drama, History, Music, TV Movie; TV: Soap
  'Romance': [10749],
  'Family & Animation': [10751, 16, 10762],                 // Family, Animation; TV: Kids
  'Documentary': [99, 10763, 10764, 10767]                  // Documentary; TV: News, Reality, Talk
};
var CATEGORY_ORDER = Object.keys(GENRE_CATEGORIES);
var OTHER_CATEGORY = 'Other';

// English TMDB genre names, for rows cached before genre ids were stored.
var GENRE_IDS_BY_NAME = {
  'Action': 28, 'Adventure': 12, 'Animation': 16, 'Comedy': 35, 'Crime': 80, 'Documentary': 99, 'Drama': 18,
  'Family': 10751, 'Fantasy': 14, 'History': 36, 'Horror': 27, 'Music': 10402, 'Mystery': 9648, 'Romance': 10749,
  'Science Fiction': 878, 'TV Movie': 10770, 'Thriller': 53, 'War': 10752, 'Western': 37, 'Action & Adventure': 10759,
  'Kids': 10762, 'News': 10763, 'Reality': 10764, 'Sci-Fi & Fantasy': 10765, 'Soap': 10766, 'Talk': 10767, 'War & Politics': 10768
};

/** The categories one TMDB item belongs to, in display order; "Other" when none match. */
function genreCategories(item) {
  var ids = item.genreIds || (item.genres || []).map(function (n) { return GENRE_IDS_BY_NAME[n]; });
  var cats = CATEGORY_ORDER.filter(function (c) {
    return GENRE_CATEGORIES[c].some(function (id) { return ids.indexOf(id) >= 0; });
  });
  return cats.length ? cats : [OTHER_CATEGORY];
}

function withCategories_(data) {
  (data.items || []).forEach(function (i) { i.categories = genreCategories(i); });
  return data;
}

// ---------- Cache ----------

// The cached copy is tagged with the libRev it was built at. A copy built while a change landed carries the older
// tag, so it is never used once the change has raised libRev.

function readLibraryCache_(rev) {
  var cache = CacheService.getScriptCache();
  var head = cache.getAll([CACHE_KEY + ':n', CACHE_KEY + ':rev']);
  var count = head[CACHE_KEY + ':n'];
  if (!count || head[CACHE_KEY + ':rev'] !== String(rev)) return null;
  var keys = [];
  for (var i = 0; i < +count; i++) keys.push(CACHE_KEY + ':' + i);
  var parts = cache.getAll(keys);
  var json = '';
  for (var j = 0; j < keys.length; j++) {
    if (parts[keys[j]] == null) return null;
    json += parts[keys[j]];
  }
  return JSON.parse(json);
}

function writeLibraryCache_(data, rev) {
  var json = asciiJson(data);
  var values = {};
  var n = 0;
  for (var i = 0; i < json.length; i += CACHE_CHUNK) values[CACHE_KEY + ':' + n++] = json.slice(i, i + CACHE_CHUNK);
  values[CACHE_KEY + ':n'] = String(n);
  values[CACHE_KEY + ':rev'] = String(rev);
  try {
    CacheService.getScriptCache().putAll(values, CACHE_SECONDS);
  } catch (e) {
    // Caching is only a speed-up; the page still works without it.
  }
}

function clearLibraryCache_() {
  CacheService.getScriptCache().remove(CACHE_KEY + ':n');
}

/** JSON with every non-ASCII character written as \uXXXX, so its length in characters is its size in bytes. */
function asciiJson(data) {
  return JSON.stringify(data).replace(/[\u007f-￿]/g, function (c) {
    return '\\u' + ('000' + c.charCodeAt(0).toString(16)).slice(-4);
  });
}

/** seenWhere is where the page showed the disc; if the sheet now says otherwise, nothing is written. */
function lendDisc(key, toName, seenWhere, user) {
  return changeHolder_(key, toName, 'lent', seenWhere, user);
}

function returnDisc(key, seenWhere, user) {
  return changeHolder_(key, null, 'returned', seenWhere, user);
}

function changeHolder_(key, toName, note, seenWhere, user) {
  write_(true, function () {
    var inv = readInventory_();
    var row = inv.rows.filter(function (r) { return r.key === key && canSee_(r, user); })[0];
    if (!row) throw new Error('Disc not found. Reload the page.');
    if (row.digital) throw new Error(row.title + ' is digital and can\'t be lent.');
    var holder = row.where || row.owner;
    if (seenWhere && seenWhere !== holder) {
      throw new Error(row.title + ' is now at ' + holder + '. The page has been refreshed, please try again.');
    }
    if (user.name !== row.owner && user.name !== holder) {
      throw new Error('Only ' + row.owner + ' or ' + holder + ' can change where this disc is.');
    }
    var target = toName || row.owner;
    if (target === holder) return;
    inv.sheet.getRange(row.rowIndex, inv.cols.where + 1).setValue(target);
    sheet_(LOANS_SHEET, LOANS_HEADERS).appendRow([key, row.title, holder, target, new Date(), user.name, note]);
    setWhereSeen_(key, target);
    fulfilRequests_(key, target, user.name);
  });
  return getLibrary_(user);
}

// ---------- Requests ----------
// Anyone who doesn't have a disc can ask for it. The request is for whoever has the disc, so it follows the disc
// when it moves; an owner asking for a lent-out disc is asking for it back. It closes when the disc reaches the
// person who asked, when they cancel it, or when the holder declines it. Everyone sees the open requests.

function requestDisc(key, note, user) {
  write_(true, function () {
    var row = readInventory_().rows.filter(function (r) { return r.key === key && canSee_(r, user); })[0];
    if (!row) throw new Error('Disc not found. Reload the page.');
    if (row.digital) throw new Error(row.title + ' is digital and can\'t be lent.');
    if ((row.where || row.owner) === user.name) throw new Error('You already have ' + row.title + '.');
    var sh = sheet_(REQUESTS_SHEET, REQUESTS_HEADERS);
    var rows = readTable_(sh).rows;
    var asked = rows.some(function (r) { return r.disc === key && r.by === user.name && r.status === 'open'; });
    if (!asked) sh.appendRow([nextRequestId(rows), key, row.title, user.name, cleanNote(note), new Date(), 'open', '', '']);
  });
  return getLibrary_(user);
}

/** "r-" and one more than the highest number in use, so an id is never handed out twice, even after rows were deleted by hand. */
function nextRequestId(rows) {
  var max = 0;
  rows.forEach(function (r) { var m = /^r-(\d+)$/.exec(String(r.id)); if (m) max = Math.max(max, +m[1]); });
  return 'r-' + (max + 1);
}

/** how: 'cancel' (by the person who asked) or 'decline' (by whoever has the disc). */
function closeRequest(id, how, user) {
  if (how !== 'cancel' && how !== 'decline') throw new Error('Unknown action.');
  write_(true, function () {
    var sh = sheet_(REQUESTS_SHEET, REQUESTS_HEADERS);
    var rows = readTable_(sh).rows;
    var i = -1;
    for (var j = 0; j < rows.length; j++) if (rows[j].id === id) { i = j; break; }
    if (i < 0) throw new Error('Request not found. Reload the page.');
    var r = rows[i];
    if (r.status === 'open') {
      if (how === 'cancel' && r.by !== user.name) throw new Error('Only ' + r.by + ' can cancel this request.');
      if (how === 'decline') {
        var disc = readInventory_().rows.filter(function (d) { return d.key === r.disc; })[0];
        var holder = disc ? disc.where || disc.owner : '';
        if (holder !== user.name) throw new Error('Only ' + holder + ', who has the disc, can decline this request.');
      }
      setRequestStatus_(sh, i + 2, how === 'cancel' ? 'cancelled' : 'declined', user.name);
    }
  });
  return getLibrary_(user);
}

/** Closes the open requests for a disc by the person it just reached. Callers hold the lock. */
function fulfilRequests_(key, to, by) {
  var sh = sheet_(REQUESTS_SHEET, REQUESTS_HEADERS);
  readTable_(sh).rows.forEach(function (r, i) {
    if (r.disc === key && r.by === to && r.status === 'open') setRequestStatus_(sh, i + 2, 'done', by);
  });
}

function setRequestStatus_(sh, rowIndex, status, by) {
  sh.getRange(rowIndex, REQUESTS_HEADERS.indexOf('status') + 1, 1, 3).setValues([[status, new Date(), by]]);
}

/** The signed-in person's display name comes from the Users tab. */
function currentUser_(email) {
  var users = usersByEmail_();
  return { email: email, name: email in users ? users[email] : (email.split('@')[0] || 'guest') };
}

// ---------- Inventory ----------

function readInventory_() {
  var sh = SpreadsheetApp.getActive().getSheetByName(INVENTORY_SHEET);
  var values = sh.getDataRange().getValues();
  var headers = values[0].map(function (h) { return String(h).trim().toLowerCase(); });
  var cols = {
    title: headers.indexOf('title'),
    year: headers.indexOf('release date'),
    disc: headers.indexOf('disc type'),
    type: headers.indexOf('type'),
    notes: headers.indexOf('notes'),
    owner: headers.indexOf('owner'),
    where: headers.indexOf('where?'),
    key: headers.indexOf(KEY_HEADER),
    source: headers.indexOf(SOURCE_HEADER),
    link: headers.indexOf(LINK_HEADER)
  };
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var v = values[i];
    var formats = splitList(String(v[cols.disc]));
    rows.push({
      rowIndex: i + 1,
      key: cols.key >= 0 ? String(v[cols.key]) : '',
      title: String(v[cols.title]).trim(),
      yearRaw: String(v[cols.year]).trim(),
      years: parseYears(String(v[cols.year])),
      formats: formats,
      digital: isDigital(formats),
      sources: cols.source >= 0 ? splitList(String(v[cols.source])) : [],
      link: cols.link >= 0 ? String(v[cols.link]).trim() : '',
      type: String(v[cols.type]).trim(),
      notes: String(v[cols.notes]).trim(),
      owner: String(v[cols.owner]).trim(),
      where: String(v[cols.where]).trim()
    });
  }
  return { sheet: sh, cols: cols, rows: rows };
}

/** Gives every inventory row a stable key in the "id" column (added after the last header). */
function ensureKeys() {
  var sh = SpreadsheetApp.getActive().getSheetByName(INVENTORY_SHEET);
  var lastCol = sh.getLastColumn();
  var headers = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim().toLowerCase(); });
  var keyCol = headers.indexOf(KEY_HEADER) + 1;
  if (keyCol === 0) {
    keyCol = lastCol + 1;
    sh.getRange(1, keyCol).setValue(KEY_HEADER);
    sh.hideColumns(keyCol);
  }
  var n = sh.getLastRow() - 1;
  if (n < 1) return;
  var titles = sh.getRange(2, 1, n, 1).getValues();
  var keys = sh.getRange(2, keyCol, n, 1).getValues();
  // Metadata keeps the keys of deleted rows, so a new disc never inherits a deleted disc's key and history.
  var used = keys.map(function (k) { return k[0]; }).concat(Object.keys(readMetadata_()));
  var max = 0;
  used.forEach(function (k) { var m = /^d-(\d+)$/.exec(k); if (m) max = Math.max(max, +m[1]); });
  var changed = false;
  for (var i = 0; i < n; i++) {
    if (titles[i][0] && !keys[i][0]) { keys[i][0] = 'd-' + ('000' + (++max)).slice(-4); changed = true; }
  }
  if (changed) sh.getRange(2, keyCol, n, 1).setValues(keys);
}

/** Adds a header ("source" or "link") after the last column the first time a digital title needs it. */
function ensureColumn_(header) {
  var sh = SpreadsheetApp.getActive().getSheetByName(INVENTORY_SHEET);
  var lastCol = sh.getLastColumn();
  var headers = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim().toLowerCase(); });
  if (headers.indexOf(header) < 0) sh.getRange(1, lastCol + 1).setValue(header);
}

// ---------- Metadata ----------

/**
 * Fetches TMDB data for new or changed rows and logs manual "where?" edits. Run by triggers, also on every sheet edit.
 * Only one run works at a time: a run that starts meanwhile leaves a note and stops, and the working run goes round
 * again, so a burst of edits doesn't queue up runs that hold the lock the app needs.
 */
function refreshMetadata() {
  CacheService.getScriptCache().removeAll(['access', 'users']); // the Users tab may have just been edited
  var props = PropertiesService.getScriptProperties();
  var gate = LockService.getDocumentLock();
  if (!gate.tryLock(0)) {
    props.setProperty(REFRESH_AGAIN_KEY, '1');
    return;
  }
  try {
    for (var round = 0; round < REFRESH_ROUNDS; round++) {
      props.deleteProperty(REFRESH_AGAIN_KEY);
      var todo = syncWhere_(); // raises the revs, since the sheet may have been edited by hand
      var moves = fetchMetadata_(todo);
      if (todo.length) write_(true, function () { moveSeen_(moves); });
      if (!props.getProperty(REFRESH_AGAIN_KEY)) break;
    }
  } finally {
    gate.releaseLock();
  }
  warmLibraryCache(); // new metadata and logged edits are in the sheet now
}

/** Rebuilds the cached library from the sheet. Runs on a timer so visitors rarely hit a cold cache. */
function warmLibraryCache() {
  var rev = revs_().lib; // read first: if a change lands during the build, this copy carries the older tag
  writeLibraryCache_(buildLibrary_(), rev);
}

/**
 * Logs manual "where?" edits and adds Metadata rows for new discs. Holds the same lock as lending,
 * so overlapping runs and lends never log a move twice. Returns the rows that need TMDB data.
 */
function syncWhere_() {
  return write_(true, function () {
    ensureKeys();
    var inv = readInventory_();
    var msh = sheet_(METADATA_SHEET, METADATA_HEADERS);
    var byKey = {};
    readTable_(msh).rows.forEach(function (r, i) { byKey[r.id] = { row: r, rowIndex: i + 2 }; });
    var todo = [];
    inv.rows.forEach(function (d) {
      if (!d.key || !d.title) return;
      var entry = byKey[d.key];
      var where = d.where || d.owner;
      if (!entry) {
        msh.appendRow([d.key, '', '', '', false, '', '', where, '']);
        entry = byKey[d.key] = { row: { id: d.key, where_seen: where }, rowIndex: msh.getLastRow() };
      } else if (entry.row.where_seen !== where) {
        if (entry.row.where_seen) {
          sheet_(LOANS_SHEET, LOANS_HEADERS).appendRow([d.key, d.title, entry.row.where_seen, where, new Date(), '', 'edited in sheet']);
          fulfilRequests_(d.key, where, '');
        }
        msh.getRange(entry.rowIndex, 8).setValue(where);
      }
      if (isStale_(entry.row, d)) todo.push({ disc: d, meta: entry.row, rowIndex: entry.rowIndex });
    });
    return todo;
  });
}

/**
 * Fills in TMDB data for up to MAX_FETCHES_PER_RUN rows; the next run picks up the rest. refreshMetadata makes sure
 * only one run fetches at a time. Returns the seen marks to move for discs that just got their first movie data.
 */
function fetchMetadata_(todo) {
  var msh = sheet_(METADATA_SHEET, METADATA_HEADERS);
  var moves = [];
  todo.slice(0, MAX_FETCHES_PER_RUN).forEach(function (t) {
    var d = t.disc;
    var manual = isManual_(t.meta);
    try {
      var ids = manual && t.meta.tmdb_ids ? splitList(t.meta.tmdb_ids) : matchDisc_(d);
      var data = buildData_(d, ids);
      // Columns A-G only: where_seen (H) belongs to syncWhere_ and lending, which may have changed it meanwhile.
      msh.getRange(t.rowIndex, 1, 1, 7).setValues([[d.key, d.title, d.yearRaw, ids.join(', '), manual, JSON.stringify(data), new Date()]]);
      msh.getRange(t.rowIndex, 9).setValue(ids.length ? '' : 'no match');
      var to = movieSeenKeys(data);
      if (to.length && !movieSeenKeys(parseData_(t.meta.data_json)).length) moves.push({ from: 'disc:' + d.key, to: to, keep: hasSeries(data) });
    } catch (e) {
      msh.getRange(t.rowIndex, 9).setValue(String(e.message || e));
    }
  });
  return moves;
}

function parseData_(json) {
  try { return JSON.parse(json); } catch (e) { return null; }
}

function isManual_(m) {
  return m.manual === true || String(m.manual).toUpperCase() === 'TRUE';
}

/** The sheet turns a title like "1917" into a number, so compare as strings. */
function isStale_(m, d) {
  return !m.data_json || dataVersion_(m.data_json) !== DATA_VERSION ||
    (!isManual_(m) && (String(m.title_seen) !== d.title || String(m.year_seen) !== d.yearRaw));
}

function dataVersion_(json) {
  try { return JSON.parse(json).v || 1; } catch (e) { return 0; }
}

function setWhereSeen_(key, where) {
  var msh = sheet_(METADATA_SHEET, METADATA_HEADERS);
  var ids = msh.getRange(1, 1, msh.getLastRow(), 1).getValues();
  for (var i = 1; i < ids.length; i++) {
    if (ids[i][0] === key) { msh.getRange(i + 1, 8).setValue(where); return; }
  }
}

function readMetadata_() {
  var out = {};
  readTable_(sheet_(METADATA_SHEET, METADATA_HEADERS)).rows.forEach(function (r) { out[r.id] = r; });
  return out;
}

/** Returns TMDB refs like "movie:603" or "tv:4607:1" for one inventory row. */
function matchDisc_(d) {
  var type = d.type.toLowerCase();
  if (type.indexOf('tv') === 0) {
    var s = parseSeason(d.title);
    var tv = searchTmdb_('tv', s.show, null);
    if (!tv) return [];
    return [s.season ? 'tv:' + tv + ':' + s.season : 'tv:' + tv];
  }
  if (type.indexOf('collection') >= 0) {
    var items = parseCollectionItems(d.notes);
    var years = items.length === d.years.length ? d.years : [];
    var refs = [];
    items.forEach(function (item, i) {
      var id = searchTmdb_('movie', item, years[i]);
      if (!id && item.indexOf(': ') > 0) id = searchTmdb_('movie', item.split(': ').slice(1).join(': '), years[i]);
      if (id) refs.push('movie:' + id);
    });
    return refs;
  }
  var id = searchTmdb_('movie', cleanTitle(d.title), d.years[0]);
  return id ? ['movie:' + id] : [];
}

function searchTmdb_(kind, query, year) {
  var params = { query: query, include_adult: 'false' };
  if (year) params[kind === 'tv' ? 'first_air_date_year' : 'primary_release_year'] = year;
  var res = tmdb_('/search/' + kind, params).results || [];
  if (!res.length && year) res = tmdb_('/search/' + kind, { query: query }).results || [];
  if (!res.length) return null;
  var q = normalize(query);
  var exact = res.filter(function (r) { return normalize(r.title || r.name) === q || normalize(r.original_title || r.original_name) === q; })[0];
  return (exact || res[0]).id;
}

function buildData_(d, refs) {
  var items = refs.map(function (ref) {
    var p = ref.split(':');
    if (p[0] === 'tv') return tvDetails_(+p[1], p[2] ? +p[2] : null);
    return movieDetails_(+p[1]);
  });
  return { v: DATA_VERSION, items: items };
}

function movieDetails_(id) {
  var m = tmdb_('/movie/' + id, { append_to_response: 'credits,videos,translations', include_video_language: videoLanguages_() });
  return {
    kind: 'movie',
    tmdbId: id,
    imdbId: m.imdb_id || '',
    title: m.title,
    germanTitle: germanTitle(m.translations, 'title', m.title),
    year: (m.release_date || '').slice(0, 4),
    overview: m.overview,
    runtime: m.runtime,
    genres: (m.genres || []).map(function (g) { return g.name; }),
    genreIds: (m.genres || []).map(function (g) { return g.id; }),
    rating: m.vote_average ? Math.round(m.vote_average * 10) / 10 : null,
    poster: m.poster_path || '',
    backdrop: m.backdrop_path || '',
    directors: ((m.credits && m.credits.crew) || []).filter(function (c) { return c.job === 'Director'; }).map(function (c) { return c.name; }),
    cast: ((m.credits && m.credits.cast) || []).slice(0, 6).map(function (c) { return c.name; }),
    trailer: pickTrailer((m.videos && m.videos.results) || [])
  };
}

function tvDetails_(id, season) {
  var t = tmdb_('/tv/' + id, { append_to_response: 'external_ids,credits,videos,translations', include_video_language: videoLanguages_() });
  var s = season ? tmdb_('/tv/' + id + '/season/' + season, {}) : null;
  var de = germanTitle(t.translations, 'name', t.name);
  return {
    kind: 'tv',
    tmdbId: id,
    imdbId: (t.external_ids && t.external_ids.imdb_id) || '',
    title: t.name + (s ? ' – ' + s.name : ''),
    germanTitle: de ? de + (s ? ' – ' + s.name : '') : '',
    year: ((s && s.air_date) || t.first_air_date || '').slice(0, 4),
    overview: (s && s.overview) || t.overview,
    runtime: (t.episode_run_time || [])[0] || null,
    episodes: s ? (s.episodes || []).length : t.number_of_episodes,
    genres: (t.genres || []).map(function (g) { return g.name; }),
    genreIds: (t.genres || []).map(function (g) { return g.id; }),
    rating: t.vote_average ? Math.round(t.vote_average * 10) / 10 : null,
    poster: (s && s.poster_path) || t.poster_path || '',
    backdrop: t.backdrop_path || '',
    directors: (t.created_by || []).map(function (c) { return c.name; }),
    cast: ((t.credits && t.credits.cast) || []).slice(0, 6).map(function (c) { return c.name; }),
    trailer: pickTrailer((t.videos && t.videos.results) || [])
  };
}

/**
 * The German title from TMDB's translations (Germany first, then Austria or Switzerland),
 * or '' when there is none or it is the same as the title the page already shows.
 */
function germanTitle(translations, field, shown) {
  var de = ((translations && translations.translations) || []).filter(function (t) {
    return t.iso_639_1 === 'de' && t.data && String(t.data[field] || '').trim();
  });
  de.sort(function (a, b) { return (a.iso_3166_1 === 'DE' ? 0 : 1) - (b.iso_3166_1 === 'DE' ? 0 : 1); });
  var title = de.length ? String(de[0].data[field]).trim() : '';
  var same = function (x) { return String(x || '').toLowerCase().replace(/[\s\p{P}]+/gu, ''); };
  return title && same(title) !== same(shown) ? title : '';
}

/** Videos in the app language first, then English and untagged ones. */
function videoLanguages_() {
  var lang = (PropertiesService.getScriptProperties().getProperty('LANGUAGE') || 'en-US').split('-')[0];
  return lang === 'en' ? 'en,null' : lang + ',en,null';
}

function tmdb_(path, params) {
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty('TMDB_TOKEN');
  if (!token) throw new Error('Set the TMDB_TOKEN script property first.');
  params.language = props.getProperty('LANGUAGE') || 'en-US';
  var qs = Object.keys(params).map(function (k) { return k + '=' + encodeURIComponent(params[k]); }).join('&');
  var res = UrlFetchApp.fetch('https://api.themoviedb.org/3' + path + '?' + qs, {
    headers: { Authorization: 'Bearer ' + token, accept: 'application/json' },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) throw new Error('TMDB ' + res.getResponseCode() + ' for ' + path);
  return JSON.parse(res.getContentText());
}

// ---------- Where to watch ----------
// TMDB lists which services offer a title in a region (from JustWatch), but no links to the title on each service:
// only one TMDB page per region. Asked live when a digital title is opened, and cached for a few hours.

function watchProviders(ref) {
  ref = checkWishRef(ref);
  var region = PropertiesService.getScriptProperties().getProperty('REGION') || 'DE';
  var cache = CacheService.getScriptCache();
  var hit = cache.get('watch:' + region + ':' + ref);
  if (hit) return JSON.parse(hit);
  var p = ref.split(':');
  var out = parseProviders(tmdb_('/' + p[0] + '/' + p[1] + '/watch/providers', {}), region);
  cache.put('watch:' + region + ':' + ref, JSON.stringify(out), 6 * 3600);
  return out;
}

/** The region's TMDB watch page and every service offering the title there (subscription, purchase, rental or free). */
function parseProviders(json, region) {
  var r = (json && json.results && json.results[region]) || {};
  var names = [];
  ['flatrate', 'buy', 'rent', 'ads', 'free'].forEach(function (kind) {
    (r[kind] || []).forEach(function (x) { if (x.provider_name && names.indexOf(x.provider_name) < 0) names.push(x.provider_name); });
  });
  return { link: /^https:\/\//.test(r.link || '') ? r.link : '', providers: names };
}

// ---------- Streaming links ----------
// The Streaming Availability API (RapidAPI, key in the RAPIDAPI_KEY script property) knows the address of a title on
// most services; Apple's iTunes search covers titles bought on Apple TV. A found link is saved in the "link" column,
// so it is looked up once; a link pasted by hand is never replaced. A miss is remembered for a day.

var SA_SERVICES = { 'Netflix': 'netflix', 'Amazon Prime Video': 'prime', 'Apple TV': 'apple', 'Disney+': 'disney', 'Sky / WOW': 'wow', 'Paramount+': 'paramount' };

function findLink(key, user) {
  var row = readInventory_().rows.filter(function (r) { return r.key === key && r.title && r.digital && r.owner === user.name; })[0];
  if (!row) throw new Error('Digital title not found. Reload the page.');
  var cache = CacheService.getScriptCache();
  if (row.link || cache.get('nolink:' + key)) return { link: row.link };
  var found = lookupLink_(row, readMetadata_()[key]);
  if (!found.link && !found.failed) cache.put('nolink:' + key, '1', 24 * 3600); // a failed call is tried again next time
  return { link: found.link ? saveFoundLink_(key, found.link) : '' };
}

/**
 * Run from the editor (or on a timer) to look up the links of all digital titles that have none yet, a few seconds
 * apart so the APIs don't refuse; it stops before the Apps Script time limit, so run it again until it says done.
 */
function fillLinks() {
  var started = Date.now();
  var meta = readMetadata_();
  var todo = readInventory_().rows.filter(function (r) { return r.title && r.digital && !r.link; });
  var found = 0, failed = 0, done = 0;
  for (var i = 0; i < todo.length && Date.now() - started < 4.5 * 60000; i++, done++) {
    var hit = lookupLink_(todo[i], meta[todo[i].key]);
    if (hit.link) { saveFoundLink_(todo[i].key, hit.link); found++; }
    if (hit.failed) failed++;
    Utilities.sleep(3000);
  }
  console.log('Links found: ' + found + ' of ' + done + ' checked' + (failed ? ', ' + failed + ' failed calls' : '') +
    (done < todo.length ? '. ' + (todo.length - done) + ' left, run fillLinks again.' : '. Done.'));
}

/** Saves a found link unless one was pasted meanwhile; returns the link the row now has. */
function saveFoundLink_(key, link) {
  write_(true, function () {
    ensureColumn_(LINK_HEADER);
    var inv = readInventory_();
    var now = inv.rows.filter(function (r) { return r.key === key; })[0];
    if (now && !now.link) inv.sheet.getRange(now.rowIndex, inv.cols.link + 1).setValue(link); // a pasted link wins
    else if (now) link = now.link;
  });
  return link;
}

/** { link, failed }: failed when a call errored (e.g. a rate limit), so a miss isn't remembered. */
function lookupLink_(row, m) {
  var ref = m && String(m.tmdb_ids || '').split(',')[0].trim();
  if (!ref) return { link: '', failed: false };
  var p = ref.split(':'); // "movie:603" or "tv:1396:2"
  var props = PropertiesService.getScriptProperties();
  var country = (props.getProperty('REGION') || 'DE').toLowerCase();
  var apiKey = props.getProperty('RAPIDAPI_KEY');
  var link = '';
  var failed = false;
  var get = function (url, headers) {
    try {
      var res = UrlFetchApp.fetch(url, { headers: headers || {}, muteHttpExceptions: true });
      if (res.getResponseCode() === 200) return JSON.parse(res.getContentText());
      if (res.getResponseCode() !== 404) throw new Error('HTTP ' + res.getResponseCode());
    } catch (e) {
      failed = true;
      console.warn('Streaming link for ' + row.title + ': ' + e.message + ' from ' + url.split('?')[0]);
    }
    return null;
  };
  if (apiKey && row.sources.some(function (s) { return SA_SERVICES[s]; })) {
    var show = get('https://streaming-availability.p.rapidapi.com/shows/' + p[0] + '/' + p[1] + '?country=' + country,
      { 'X-RapidAPI-Key': apiKey, 'X-RapidAPI-Host': 'streaming-availability.p.rapidapi.com' });
    link = pickStreamLink(show, country, row.sources);
  }
  if (!link && row.sources.indexOf('Apple TV') >= 0) {
    // The German store often knows a film only by its German title, so that is tried too.
    var tv = p[0] === 'tv';
    var item = {};
    try { item = JSON.parse(m.data_json).items[0] || {}; } catch (e) {}
    var titles = [parseSeason(row.title).show || row.title, (item.germanTitle || '').replace(/ – .*$/, '')].filter(function (t, i, a) { return t && a.indexOf(t) === i; });
    for (var i = 0; i < titles.length && !link; i++) {
      var found = get('https://itunes.apple.com/search?country=' + country + '&media=' + (tv ? 'tvShow&entity=tvSeason' : 'movie&entity=movie') +
        '&limit=10&term=' + encodeURIComponent(titles[i]));
      link = localLink(pickItunesLink(found && found.results, tv, row.yearRaw), country);
    }
  }
  return { link: link, failed: failed && !link };
}

/** The address of the title on the first owned source that offers it, from a Streaming Availability show. */
function pickStreamLink(show, country, sources) {
  var options = (show && show.streamingOptions && show.streamingOptions[country]) || [];
  for (var i = 0; i < sources.length; i++) {
    var hit = options.filter(function (o) { return o.service && o.service.id === SA_SERVICES[sources[i]] && /^https:\/\//.test(o.link || ''); })[0];
    if (hit) return localLink(hit.link, country);
  }
  return '';
}

/** Apple's links carry a store country (often "us", or none, which also means the US store): use the region's store. */
function localLink(url, country) {
  var m = /^(https:\/\/(?:tv|itunes)\.apple\.com)(?:\/[a-z]{2}(?=\/))?(\/.*)$/i.exec(url);
  return m ? m[1] + '/' + country + m[2] : url;
}

/** An iTunes search hit for the title from the same year (give or take one, for later releases); the first without a year. */
function pickItunesLink(results, tv, year) {
  results = (results || []).filter(function (x) { return /^https:\/\//.test(tv ? x.collectionViewUrl || '' : x.trackViewUrl || ''); });
  var y = String(year || '').slice(0, 4);
  var hit = y ? results.filter(function (x) { return Math.abs(+String(x.releaseDate || '').slice(0, 4) - y) <= 1; })[0] : results[0];
  return hit ? (tv ? hit.collectionViewUrl : hit.trackViewUrl) : '';
}

// ---------- Setup ----------

/** Run once from the editor: creates the helper tabs, keys and triggers, then fetches metadata. */
function setup() {
  ensureKeys();
  sheet_(METADATA_SHEET, METADATA_HEADERS);
  sheet_(LOANS_SHEET, LOANS_HEADERS);
  sheet_(HOUSEHOLD_SHEET, HOUSEHOLD_HEADERS);
  sheet_(SEEN_SHEET, SEEN_HEADERS);
  sheet_(REQUESTS_SHEET, REQUESTS_HEADERS);
  sheet_(WISHLIST_SHEET, WISHLIST_HEADERS);
  var users = sheet_(USERS_SHEET, USERS_HEADERS);
  if (users.getLastRow() < 2) users.appendRow([Session.getEffectiveUser().getEmail(), 'Steffen']);
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('refreshMetadata').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('refreshMetadata').forSpreadsheet(SpreadsheetApp.getActive()).onChange().create();
  ScriptApp.newTrigger('warmLibraryCache').timeBased().everyMinutes(WARM_MINUTES).create();
  refreshMetadata();
}

// ---------- Helpers ----------

function sheet_(name, headers) {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(headers);
    sh.setFrozenRows(1);
  }
  return sh;
}

function readTable_(sh) {
  var values = sh.getDataRange().getValues();
  var headers = values[0].map(String);
  return {
    rows: values.slice(1).map(function (v) {
      var o = {};
      headers.forEach(function (h, i) { o[h] = v[i]; });
      return o;
    })
  };
}

// Pure parsing helpers (no Apps Script services, so they can be tested with Node).

function splitList(s) {
  return String(s || '').split(/\s*[,\n]\s*/).map(function (x) { return x.trim(); }).filter(Boolean);
}

function parseYears(s) {
  var range = /^(\d{4})\s*[–-]\s*(\d{4})$/.exec(String(s).trim());
  if (range) return [+range[1]];
  return (String(s).match(/\d{4}/g) || []).map(Number);
}

function cleanTitle(t) {
  return String(t)
    .replace(/\s*\((\d{4}|remastered|extended)\)\s*$/i, '')
    .replace(/\s+-\s+.*$/, '')
    .trim();
}

function parseSeason(t) {
  var m = /^(.*?)\s*[–-]\s*Season\s+(\d+)/i.exec(t);
  if (m) return { show: m[1].trim(), season: +m[2] };
  return { show: String(t).replace(/\s*\(.*?\)\s*/g, ' ').replace(/\s+Seasons?\s+[\d–-]+.*$/i, '').trim(), season: null };
}

/** Trims household names, drops blanks, duplicates and the user's own name, and limits their length. */
function cleanHousehold(names, self) {
  if (!Array.isArray(names)) throw new Error('Bad household list.');
  var out = [];
  names.forEach(function (n) {
    n = String(n == null ? '' : n).replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
    if (n && n !== self && out.indexOf(n) < 0) out.push(n);
  });
  if (out.length > 20) throw new Error('A household can have at most 20 people.');
  return out;
}

/** Trims a request note to one short line. A leading = + - or @ is kept as text, not run as a formula. */
function cleanNote(note) {
  var s = String(note == null ? '' : note).replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

/** "5-Disc Special Edition. Batman Begins, The Dark Knight" -> ["Batman Begins", "The Dark Knight"] */
function parseCollectionItems(notes) {
  var text = String(notes || '').replace(/\n/g, ', ');
  var parts = text.split(/\.\s+/);
  var list = parts[parts.length - 1];
  var items = splitList(list).map(function (x) { return x.replace(/\s*\((extended|remastered)\)\s*$/i, '').trim(); });
  // "the Chamber of Secrets" style continuations reuse the first item's prefix ("Harry Potter and")
  var prefix = items.length && / and the /i.test(items[0]) ? items[0].replace(/ and the .*$/i, ' and') : null;
  return items.map(function (x) { return prefix && /^the /.test(x) ? prefix + ' ' + x : x; });
}

/** Picks the best YouTube video id from TMDB's videos list: official trailer, then any trailer, then a teaser. */
function pickTrailer(videos) {
  var yt = (videos || []).filter(function (v) { return v.site === 'YouTube' && v.key; });
  var rank = function (v) { return (v.type === 'Trailer' ? 0 : v.type === 'Teaser' ? 2 : 4) + (v.official ? 0 : 1); };
  yt = yt.filter(function (v) { return rank(v) < 4; }).sort(function (a, b) { return rank(a) - rank(b); });
  return yt.length ? yt[0].key : '';
}

/** Only movies and series from a TMDB search, in TMDB's order, trimmed to what the page shows. */
function searchResults(results) {
  return (results || []).filter(function (r) { return (r.media_type === 'movie' || r.media_type === 'tv') && r.id; })
    .slice(0, SEARCH_RESULTS).map(function (r) {
      return {
        ref: r.media_type + ':' + r.id,
        kind: r.media_type,
        tmdbId: r.id,
        title: r.title || r.name || '',
        year: (r.release_date || r.first_air_date || '').slice(0, 4),
        poster: r.poster_path || '',
        overview: String(r.overview || '').slice(0, 300)
      };
    });
}

/** "tt0133093", or an IMDb link containing it -> "tt0133093"; anything else -> null. */
function parseImdbId(q) {
  var m = /\b(tt\d{7,10})\b/.exec(String(q || ''));
  return m ? m[1] : null;
}

/**
 * Checks what the page sends for a new disc: a TMDB movie or series, at least one known disc format (or, for a
 * digital title, at least one source), and for a series an optional season (none means a box set of the whole
 * series). Returns the cleaned row parts.
 */
function discRow(input) {
  input = input || {};
  var ref = checkWishRef(input.ref);
  var tv = ref.indexOf('tv:') === 0;
  var formats = [];
  var sources = [];
  var link = '';
  if (input.digital) {
    formats = [DIGITAL];
    sources = cleanSources(input.sources, input.other);
    link = cleanLink(input.link);
    if (!sources.length) throw new Error('Pick at least one source.');
  } else {
    formats = DISC_FORMATS.filter(function (f) { return (input.formats || []).indexOf(f) >= 0; });
    if (!formats.length) throw new Error('Pick at least one disc format.');
  }
  var season = null;
  if (input.season != null && String(input.season).trim() !== '') {
    if (!tv || !/^\d{1,2}$/.test(String(input.season).trim()) || +input.season < 1) throw new Error('Unknown season.');
    season = +input.season;
  }
  return { ref: ref, formats: formats, sources: sources, link: link, season: season, type: tv ? (season ? 'TV season' : 'TV series box set') : 'Film', notes: cleanNote(input.notes) };
}

/** Known sources in list order, then an "Other" one typed by hand (commas would split it, so they go). */
function cleanSources(list, other) {
  var out = DIGITAL_SOURCES.filter(function (s) { return (Array.isArray(list) ? list : []).indexOf(s) >= 0; });
  var typed = cleanNote(String(other == null ? '' : other).replace(/[,\n]/g, ' ')).slice(0, MAX_SOURCE).trim();
  if (typed && out.indexOf(typed) < 0) out.push(typed);
  return out;
}

/** An optional streaming URL: empty, or a single http(s) address the page can safely open in a new tab. */
function cleanLink(link) {
  var url = String(link == null ? '' : link).trim();
  if (!url) return '';
  if (url.length > MAX_LINK || !/^https?:\/\/[^\s/?#]+\.[^\s]*$/i.test(url)) throw new Error('The streaming link must be a web address starting with https://');
  return url;
}

/** A row whose disc type says "Digital" (any case) is a digital title. */
function isDigital(formats) {
  return (formats || []).some(function (f) { return String(f).trim().toLowerCase() === DIGITAL.toLowerCase(); });
}

function checkWishRef(ref) {
  if (!/^(movie|tv):\d{1,10}$/.test(String(ref || ''))) throw new Error('Unknown title.');
  return String(ref);
}

function normalize(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

if (typeof module !== 'undefined') {
  module.exports = { checkTokenInfo: checkTokenInfo, pickTrailer: pickTrailer, germanTitle: germanTitle, splitList: splitList, parseYears: parseYears, cleanTitle: cleanTitle, parseSeason: parseSeason, parseCollectionItems: parseCollectionItems, cleanHousehold: cleanHousehold, cleanNote: cleanNote, genreCategories: genreCategories, searchResults: searchResults, parseImdbId: parseImdbId, checkWishRef: checkWishRef, discRow: discRow, cleanSources: cleanSources, cleanLink: cleanLink, parseProviders: parseProviders, pickStreamLink: pickStreamLink, pickItunesLink: pickItunesLink, localLink: localLink, isDigital: isDigital, visibleDiscs: visibleDiscs, nextRequestId: nextRequestId, movieSeenKeys: movieSeenKeys, hasSeries: hasSeries, asciiJson: asciiJson };
}
