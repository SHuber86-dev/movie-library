const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ctx = { module: { exports: {} } };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/Code.gs'), 'utf8'), ctx);

test('pickTrailer prefers an official YouTube trailer', () => {
  const videos = [
    { site: 'YouTube', type: 'Featurette', key: 'feat', official: true },
    { site: 'Vimeo', type: 'Trailer', key: 'vimeo', official: true },
    { site: 'YouTube', type: 'Teaser', key: 'teaser', official: true },
    { site: 'YouTube', type: 'Trailer', key: 'fan', official: false },
    { site: 'YouTube', type: 'Trailer', key: 'official', official: true }
  ];
  assert.strictEqual(ctx.pickTrailer(videos), 'official');
  assert.strictEqual(ctx.pickTrailer(videos.slice(0, 3)), 'teaser');
  assert.strictEqual(ctx.pickTrailer(videos.slice(0, 2)), '');
  assert.strictEqual(ctx.pickTrailer([]), '');
});

test('rows cached before trailers existed are fetched again', () => {
  const disc = { title: 'Heat', yearRaw: '1995' };
  const row = json => ({ data_json: json, title_seen: 'Heat', year_seen: '1995', manual: false });
  assert.strictEqual(ctx.isStale_(row('{"items":[]}'), disc), true);
  assert.strictEqual(ctx.isStale_(row(JSON.stringify({ v: ctx.DATA_VERSION, items: [] })), disc), false);
  assert.strictEqual(ctx.isStale_({ ...row('{"items":[]}'), manual: true, tmdb_ids: 'movie:949' }, disc), true);
});
