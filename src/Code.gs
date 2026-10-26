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
var CACHE_CHUNK = 90000;  // CacheService values are limited to 100 KB each

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
 *   { action: 'library' | 'lend' | 'return', token: <Google ID token>, key, to, seenWhere }
 *   { action: 'seen', token, changes: [{ movie, title, person, seen: true | false }, ...] }
 *   { action: 'household', token, names: [...] }
 *   { action: 'request', token, key, note }
 *   { action: 'closeRequest', token, id, how: 'cancel' | 'decline' }
 *   { action: 'search', token, q }                 -> TMDB movies and series, not the library
 *   { action: 'wish' | 'unwish', token, ref }      ref like "movie:603" or "tv:1396"
 *   { action: 'addDisc', token, ref, formats: [...], season, notes, unwish } -> a new disc owned by the signed-in user
 *   { action: 'removeDisc', token, key, seenWhere } -> deletes the owner's disc from the inventory tab
 * Answers { ok: true, data: <library> } or { ok: false, code: 'signin' | 'denied' | 'error', error }.
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
    if (req.action === 'library') return json_({ ok: true, data: getLibrary_(user) });
    if (req.action === 'lend') return json_({ ok: true, data: lendDisc(req.key, req.to, req.seenWhere, user) });
    if (req.action === 'return') return json_({ ok: true, data: returnDisc(req.key, req.seenWhere, user) });
    if (req.action === 'seen') return json_({ ok: true, data: markSeen(req.changes || [req], user) }); // [req]: pages from before batching
    if (req.action === 'household') return json_({ ok: true, data: setHousehold(req.names, user) });
    if (req.action === 'request') return json_({ ok: true, data: requestDisc(req.key, req.note, user) });
    if (req.action === 'closeRequest') return json_({ ok: true, data: closeRequest(req.id, req.how, user) });
    if (req.action === 'search') return json_({ ok: true, data: searchTitles(req.q) });
    if (req.action === 'wish') return json_({ ok: true, data: addWish(req.ref, user) });
    if (req.action === 'unwish') return json_({ ok: true, data: removeWish(req.ref, user) });
    if (req.action === 'addDisc') return json_({ ok: true, data: addDisc(req, user) });
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

/** People the sheet is shared with, plus everyone in the Users tab. A miss rereads the list, so new shares work at once. */
function hasAccess_(email) {
  var cache = CacheService.getScriptCache();
  var cached = cache.get('access');
  if (cached && JSON.parse(cached).indexOf(email) >= 0) return true;
  var list = accessList_();
  cache.put('access', JSON.stringify(list), ACCESS_SECONDS);
  return list.indexOf(email) >= 0;
}

function accessList_() {
  var emails = readTable_(sheet_(USERS_SHEET, USERS_HEADERS)).rows.map(function (u) { return u.email; });
  try {
    var ss = SpreadsheetApp.getActive();
    ss.getEditors().concat(ss.getViewers()).forEach(function (u) { emails.push(u.getEmail()); });
  } catch (e) {
    // Without the sharing list, the Users tab alone decides.
  }
  return emails.map(function (x) { return String(x || '').trim().toLowerCase(); }).filter(Boolean);
}

/** Everything the page needs in one call. The shared part is cached; the user is looked up per call. */
function getLibrary_(user) {
  var shared = readLibraryCache_();
  if (!shared) {
    shared = buildLibrary_();
    writeLibraryCache_(shared);
  }
  var mine = personalData_(user);
  return { user: user, people: shared.people, categories: shared.categories, discs: shared.discs, household: mine.household, seen: mine.seen, wishlist: readWishlist_() };
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
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = sheet_(WISHLIST_SHEET, WISHLIST_HEADERS);
    var rows = readTable_(sh).rows;
    if (!rows.some(function (r) { return r.ref === ref; })) {
      if (rows.length >= MAX_WISHES) throw new Error('The wishlist is full. Remove a few titles first.');
      sh.appendRow([ref, cleanNote(info.title), info.year, info.poster, info.imdbId, user.name, new Date()]);
    }
    return getLibrary_(user);
  } finally {
    lock.releaseLock();
  }
}

function removeWish(ref, user) {
  ref = checkWishRef(ref);
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = sheet_(WISHLIST_SHEET, WISHLIST_HEADERS);
    var rows = readTable_(sh).rows;
    for (var i = rows.length - 1; i >= 0; i--) if (rows[i].ref === ref) sh.deleteRow(i + 2);
    return getLibrary_(user);
  } finally {
    lock.releaseLock();
  }
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
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    ensureKeys(); // makes sure the key column exists
    var inv = readInventory_();
    var values = [];
    for (var c = 0; c < inv.sheet.getLastColumn(); c++) values.push('');
    var set = function (col, v) { if (col >= 0) values[col] = v; };
    set(inv.cols.title, cleanNote(title));
    set(inv.cols.year, item.year);
    set(inv.cols.disc, row.formats.join(', '));
    set(inv.cols.type, row.type);
    set(inv.cols.notes, row.notes);
    set(inv.cols.owner, user.name);
    set(inv.cols.where, user.name);
    inv.sheet.appendRow(values);
    ensureKeys(); // gives the new row its key
    var added = readInventory_().rows.filter(function (r) { return r.title; }).pop();
    sheet_(METADATA_SHEET, METADATA_HEADERS).appendRow([added.key, added.title, added.yearRaw, tmdbRef, true, JSON.stringify(data), new Date(), user.name, '']);
    if (input.unwish) {
      var wsh = sheet_(WISHLIST_SHEET, WISHLIST_HEADERS);
      var wishes = readTable_(wsh).rows;
      for (var i = wishes.length - 1; i >= 0; i--) if (wishes[i].ref === row.ref) wsh.deleteRow(i + 2);
    }
    clearLibraryCache_();
    return getLibrary_(user);
  } finally {
    lock.releaseLock();
  }
}

// ---------- Removing discs ----------
// Only the owner can remove a disc, and only while it is at their place, so nobody loses track of a lent-out disc.
// Its row leaves the inventory tab; its Metadata row stays, so the key is never handed to a new disc. The Loans tab
// gets a last "removed" line as a record, and open requests for the disc are closed.

function removeDisc(key, seenWhere, user) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var inv = readInventory_();
    var row = inv.rows.filter(function (r) { return r.key === key && r.title; })[0];
    if (!row) throw new Error('Disc not found. Reload the page.');
    var holder = row.where || row.owner;
    if (seenWhere && seenWhere !== holder) {
      clearLibraryCache_();
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
    clearLibraryCache_();
    return getLibrary_(user);
  } finally {
    lock.releaseLock();
  }
}

// ---------- Seen ----------
// Movies are keyed like the page groups them: "movie:<tmdb id>", or "disc:<row key>" for TV seasons and
// discs without movie data. Each user marks themselves and their own household; nobody else sees those marks.

/** The signed-in user's household names and { movie: [people who saw it] }. */
function personalData_(user) {
  var household = readTable_(sheet_(HOUSEHOLD_SHEET, HOUSEHOLD_HEADERS)).rows.filter(function (r) {
    return String(r.email).toLowerCase() === user.email && r.name;
  }).map(function (r) { return String(r.name); });
  var seen = {};
  readTable_(sheet_(SEEN_SHEET, SEEN_HEADERS)).rows.forEach(function (r) {
    if (String(r.email).toLowerCase() !== user.email || !r.movie) return;
    (seen[r.movie] = seen[r.movie] || []).push(String(r.person));
  });
  return { household: household, seen: seen };
}

/**
 * Applies a batch of ticks and unticks from the page. Each change says what the mark should be, not "toggle",
 * so the page can safely send a batch again if it never saw the answer. Changes for people who are no longer
 * in the household are skipped; the last change for the same movie and person wins.
 */
function markSeen(changes, user) {
  if (!Array.isArray(changes) || changes.length > MAX_SEEN_CHANGES) throw new Error('Bad seen list.');
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var allowed = [user.name].concat(personalData_(user).household);
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
    remove.sort(function (a, b) { return b - a; }).forEach(function (row) { sh.deleteRow(row); });
    add.forEach(function (row) { sh.appendRow(row); });
    return getLibrary_(user);
  } finally {
    lock.releaseLock();
  }
}

/** Replaces the user's household list. Marks for removed names stay in the sheet and come back if the name is added again. */
function setHousehold(names, user) {
  var clean = cleanHousehold(names, user.name);
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = sheet_(HOUSEHOLD_SHEET, HOUSEHOLD_HEADERS);
    var rows = readTable_(sh).rows;
    for (var i = rows.length - 1; i >= 0; i--) {
      if (String(rows[i].email).toLowerCase() === user.email) sh.deleteRow(i + 2);
    }
    clean.forEach(function (n) { sh.appendRow([user.email, n]); });
    return getLibrary_(user);
  } finally {
    lock.releaseLock();
  }
}

function buildLibrary_() {
  var inv = readInventory_();
  var meta = readMetadata_();
  var loans = readTable_(sheet_(LOANS_SHEET, LOANS_HEADERS)).rows;
  var requests = readTable_(sheet_(REQUESTS_SHEET, REQUESTS_HEADERS)).rows.filter(function (q) { return q.status === 'open'; });
  var people = {};
  readTable_(sheet_(USERS_SHEET, USERS_HEADERS)).rows.forEach(function (u) { if (u.name) people[u.name] = true; });

  var discs = inv.rows.filter(function (r) { return r.title; }).map(function (r) {
    if (r.owner) people[r.owner] = true;
    if (r.where) people[r.where] = true;
    var m = meta[r.key];
    var where = r.where || r.owner;
    return {
      key: r.key,
      title: r.title,
      years: r.years,
      formats: r.formats,
      type: r.type,
      notes: r.notes,
      owner: r.owner,
      where: where,
      // A request by whoever has the disc now was met by a hand edit of "where?".
      requests: requests.filter(function (q) { return q.disc === r.key && q.by !== where; }).map(function (q) {
        return { id: q.id, by: q.by, note: q.note, at: q.at instanceof Date ? q.at.toISOString() : String(q.at) };
      }),
      meta: m && m.data_json ? withCategories_(JSON.parse(m.data_json)) : null,
      history: loans.filter(function (l) { return l.id === r.key; }).map(function (l) {
        return { from: l.from, to: l.to, at: l.at instanceof Date ? l.at.toISOString() : String(l.at), by: l.by, note: l.note };
      })
    };
  });

  return { people: Object.keys(people).sort(), categories: CATEGORY_ORDER.concat([OTHER_CATEGORY]), discs: discs };
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

function readLibraryCache_() {
  var cache = CacheService.getScriptCache();
  var count = cache.get(CACHE_KEY + ':n');
  if (!count) return null;
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

function writeLibraryCache_(data) {
  var json = JSON.stringify(data);
  var values = {};
  var n = 0;
  for (var i = 0; i < json.length; i += CACHE_CHUNK) values[CACHE_KEY + ':' + n++] = json.slice(i, i + CACHE_CHUNK);
  values[CACHE_KEY + ':n'] = String(n);
  try {
    CacheService.getScriptCache().putAll(values, CACHE_SECONDS);
  } catch (e) {
    // Caching is only a speed-up; the page still works without it.
  }
}

function clearLibraryCache_() {
  CacheService.getScriptCache().remove(CACHE_KEY + ':n');
}

/** seenWhere is where the page showed the disc; if the sheet now says otherwise, nothing is written. */
function lendDisc(key, toName, seenWhere, user) {
  return changeHolder_(key, toName, 'lent', seenWhere, user);
}

function returnDisc(key, seenWhere, user) {
  return changeHolder_(key, null, 'returned', seenWhere, user);
}

function changeHolder_(key, toName, note, seenWhere, user) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var inv = readInventory_();
    var row = inv.rows.filter(function (r) { return r.key === key; })[0];
    if (!row) throw new Error('Disc not found. Reload the page.');
    var holder = row.where || row.owner;
    if (seenWhere && seenWhere !== holder) {
      clearLibraryCache_();
      throw new Error(row.title + ' is now at ' + holder + '. The page has been refreshed, please try again.');
    }
    if (user.name !== row.owner && user.name !== holder) {
      throw new Error('Only ' + row.owner + ' or ' + holder + ' can change where this disc is.');
    }
    var target = toName || row.owner;
    if (target === holder) return getLibrary_(user);
    inv.sheet.getRange(row.rowIndex, inv.cols.where + 1).setValue(target);
    sheet_(LOANS_SHEET, LOANS_HEADERS).appendRow([key, row.title, holder, target, new Date(), user.name, note]);
    setWhereSeen_(key, target);
    fulfilRequests_(key, target, user.name);
    clearLibraryCache_();
    return getLibrary_(user);
  } finally {
    lock.releaseLock();
  }
}

// ---------- Requests ----------
// Anyone who doesn't have a disc can ask for it. The request is for whoever has the disc, so it follows the disc
// when it moves; an owner asking for a lent-out disc is asking for it back. It closes when the disc reaches the
// person who asked, when they cancel it, or when the holder declines it. Everyone sees the open requests.

function requestDisc(key, note, user) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var row = readInventory_().rows.filter(function (r) { return r.key === key; })[0];
    if (!row) throw new Error('Disc not found. Reload the page.');
    if ((row.where || row.owner) === user.name) throw new Error('You already have ' + row.title + '.');
    var sh = sheet_(REQUESTS_SHEET, REQUESTS_HEADERS);
    var rows = readTable_(sh).rows;
    var asked = rows.some(function (r) { return r.disc === key && r.by === user.name && r.status === 'open'; });
    if (!asked) sh.appendRow(['r-' + (rows.length + 1), key, row.title, user.name, cleanNote(note), new Date(), 'open', '', '']);
    clearLibraryCache_();
    return getLibrary_(user);
  } finally {
    lock.releaseLock();
  }
}

/** how: 'cancel' (by the person who asked) or 'decline' (by whoever has the disc). */
function closeRequest(id, how, user) {
  if (how !== 'cancel' && how !== 'decline') throw new Error('Unknown action.');
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
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
    clearLibraryCache_();
    return getLibrary_(user);
  } finally {
    lock.releaseLock();
  }
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
  var match = readTable_(sheet_(USERS_SHEET, USERS_HEADERS)).rows.filter(function (u) {
    return String(u.email).toLowerCase() === email;
  })[0];
  return { email: email, name: match ? match.name : (email.split('@')[0] || 'guest') };
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
    key: headers.indexOf(KEY_HEADER)
  };
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var v = values[i];
    rows.push({
      rowIndex: i + 1,
      key: cols.key >= 0 ? String(v[cols.key]) : '',
      title: String(v[cols.title]).trim(),
      yearRaw: String(v[cols.year]).trim(),
      years: parseYears(String(v[cols.year])),
      formats: splitList(String(v[cols.disc])),
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

// ---------- Metadata ----------

/** Fetches TMDB data for new or changed rows and logs manual "where?" edits. Run by triggers. */
function refreshMetadata() {
  clearLibraryCache_(); // the sheet may have just been edited
  fetchMetadata_(syncWhere_());
  warmLibraryCache(); // new metadata and logged edits are in the sheet now
}

/** Rebuilds the cached library from the sheet. Runs on a timer so visitors rarely hit a cold cache. */
function warmLibraryCache() {
  writeLibraryCache_(buildLibrary_());
}

/**
 * Logs manual "where?" edits and adds Metadata rows for new discs. Holds the same lock as lending,
 * so overlapping runs and lends never log a move twice. Returns the rows that need TMDB data.
 */
function syncWhere_() {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
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
  } finally {
    lock.releaseLock();
  }
}

/** Fills in TMDB data for up to MAX_FETCHES_PER_RUN rows. Only one run fetches at a time; the next trigger picks up the rest. */
function fetchMetadata_(todo) {
  var lock = LockService.getDocumentLock();
  if (!lock.tryLock(0)) return;
  try {
    var msh = sheet_(METADATA_SHEET, METADATA_HEADERS);
    todo.slice(0, MAX_FETCHES_PER_RUN).forEach(function (t) {
      var d = t.disc;
      var manual = isManual_(t.meta);
      try {
        var ids = manual && t.meta.tmdb_ids ? splitList(t.meta.tmdb_ids) : matchDisc_(d);
        var data = buildData_(d, ids);
        // Columns A-G only: where_seen (H) belongs to syncWhere_ and lending, which may have changed it meanwhile.
        msh.getRange(t.rowIndex, 1, 1, 7).setValues([[d.key, d.title, d.yearRaw, ids.join(', '), manual, JSON.stringify(data), new Date()]]);
        msh.getRange(t.rowIndex, 9).setValue(ids.length ? '' : 'no match');
      } catch (e) {
        msh.getRange(t.rowIndex, 9).setValue(String(e.message || e));
      }
    });
  } finally {
    lock.releaseLock();
  }
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
 * Checks what the page sends for a new disc: a TMDB movie or series, at least one known disc format, and for a
 * series an optional season (none means a box set of the whole series). Returns the cleaned row parts.
 */
function discRow(input) {
  input = input || {};
  var ref = checkWishRef(input.ref);
  var tv = ref.indexOf('tv:') === 0;
  var formats = DISC_FORMATS.filter(function (f) { return (input.formats || []).indexOf(f) >= 0; });
  if (!formats.length) throw new Error('Pick at least one disc format.');
  var season = null;
  if (input.season != null && String(input.season).trim() !== '') {
    if (!tv || !/^\d{1,2}$/.test(String(input.season).trim()) || +input.season < 1) throw new Error('Unknown season.');
    season = +input.season;
  }
  return { ref: ref, formats: formats, season: season, type: tv ? (season ? 'TV season' : 'TV series box set') : 'Film', notes: cleanNote(input.notes) };
}

function checkWishRef(ref) {
  if (!/^(movie|tv):\d{1,10}$/.test(String(ref || ''))) throw new Error('Unknown title.');
  return String(ref);
}

function normalize(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

if (typeof module !== 'undefined') {
  module.exports = { checkTokenInfo: checkTokenInfo, pickTrailer: pickTrailer, germanTitle: germanTitle, splitList: splitList, parseYears: parseYears, cleanTitle: cleanTitle, parseSeason: parseSeason, parseCollectionItems: parseCollectionItems, cleanHousehold: cleanHousehold, cleanNote: cleanNote, genreCategories: genreCategories, searchResults: searchResults, parseImdbId: parseImdbId, checkWishRef: checkWishRef, discRow: discRow };
}
