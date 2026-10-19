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
var MAX_NAME = 40;
var MAX_FETCHES_PER_RUN = 40;
var DATA_VERSION = 2;     // bump when buildData_ adds fields, so older cached rows are fetched again (2: trailers)
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
 *   { action: 'seen', token, movie, title, person, seen: true | false }
 *   { action: 'household', token, names: [...] }
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
    if (req.action === 'seen') return json_({ ok: true, data: markSeen(req.movie, req.title, req.person, req.seen, user) });
    if (req.action === 'household') return json_({ ok: true, data: setHousehold(req.names, user) });
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
  return { user: user, people: shared.people, discs: shared.discs, household: mine.household, seen: mine.seen };
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

/** Marks or unmarks one person (the user or someone in their household) as having seen a movie. */
function markSeen(movie, title, person, seen, user) {
  if (!/^(movie|disc):[\w-]+$/.test(String(movie || ''))) throw new Error('Unknown movie.');
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (person !== user.name && personalData_(user).household.indexOf(person) < 0) {
      throw new Error(person + ' is not in your household.');
    }
    var sh = sheet_(SEEN_SHEET, SEEN_HEADERS);
    var rows = readTable_(sh).rows;
    var found = -1;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].movie === movie && String(rows[i].email).toLowerCase() === user.email && String(rows[i].person) === person) { found = i; break; }
    }
    if (seen && found < 0) sh.appendRow([movie, String(title || '').slice(0, 200), user.email, person, new Date()]);
    if (!seen && found >= 0) sh.deleteRow(found + 2);
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
  var people = {};
  readTable_(sheet_(USERS_SHEET, USERS_HEADERS)).rows.forEach(function (u) { if (u.name) people[u.name] = true; });

  var discs = inv.rows.filter(function (r) { return r.title; }).map(function (r) {
    if (r.owner) people[r.owner] = true;
    if (r.where) people[r.where] = true;
    var m = meta[r.key];
    return {
      key: r.key,
      title: r.title,
      years: r.years,
      formats: r.formats,
      type: r.type,
      notes: r.notes,
      owner: r.owner,
      where: r.where || r.owner,
      meta: m && m.data_json ? JSON.parse(m.data_json) : null,
      history: loans.filter(function (l) { return l.id === r.key; }).map(function (l) {
        return { from: l.from, to: l.to, at: l.at instanceof Date ? l.at.toISOString() : String(l.at), by: l.by, note: l.note };
      })
    };
  });

  return { people: Object.keys(people).sort(), discs: discs };
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
    clearLibraryCache_();
    return getLibrary_(user);
  } finally {
    lock.releaseLock();
  }
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
  var m = tmdb_('/movie/' + id, { append_to_response: 'credits,videos', include_video_language: videoLanguages_() });
  return {
    kind: 'movie',
    tmdbId: id,
    imdbId: m.imdb_id || '',
    title: m.title,
    year: (m.release_date || '').slice(0, 4),
    overview: m.overview,
    runtime: m.runtime,
    genres: (m.genres || []).map(function (g) { return g.name; }),
    rating: m.vote_average ? Math.round(m.vote_average * 10) / 10 : null,
    poster: m.poster_path || '',
    backdrop: m.backdrop_path || '',
    directors: ((m.credits && m.credits.crew) || []).filter(function (c) { return c.job === 'Director'; }).map(function (c) { return c.name; }),
    cast: ((m.credits && m.credits.cast) || []).slice(0, 6).map(function (c) { return c.name; }),
    trailer: pickTrailer((m.videos && m.videos.results) || [])
  };
}

function tvDetails_(id, season) {
  var t = tmdb_('/tv/' + id, { append_to_response: 'external_ids,credits,videos', include_video_language: videoLanguages_() });
  var s = season ? tmdb_('/tv/' + id + '/season/' + season, {}) : null;
  return {
    kind: 'tv',
    tmdbId: id,
    imdbId: (t.external_ids && t.external_ids.imdb_id) || '',
    title: t.name + (s ? ' – ' + s.name : ''),
    year: ((s && s.air_date) || t.first_air_date || '').slice(0, 4),
    overview: (s && s.overview) || t.overview,
    runtime: (t.episode_run_time || [])[0] || null,
    episodes: s ? (s.episodes || []).length : t.number_of_episodes,
    genres: (t.genres || []).map(function (g) { return g.name; }),
    rating: t.vote_average ? Math.round(t.vote_average * 10) / 10 : null,
    poster: (s && s.poster_path) || t.poster_path || '',
    backdrop: t.backdrop_path || '',
    directors: (t.created_by || []).map(function (c) { return c.name; }),
    cast: ((t.credits && t.credits.cast) || []).slice(0, 6).map(function (c) { return c.name; }),
    trailer: pickTrailer((t.videos && t.videos.results) || [])
  };
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

function normalize(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

if (typeof module !== 'undefined') {
  module.exports = { checkTokenInfo: checkTokenInfo, pickTrailer: pickTrailer, splitList: splitList, parseYears: parseYears, cleanTitle: cleanTitle, parseSeason: parseSeason, parseCollectionItems: parseCollectionItems, cleanHousehold: cleanHousehold };
}
