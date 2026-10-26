const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ctx = { module: { exports: {} } };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/Code.gs'), 'utf8'), ctx);

const tr = list => ({ translations: list.map(([lang, country, title]) => ({ iso_639_1: lang, iso_3166_1: country, data: { title, name: title } })) });

test('germanTitle prefers the Germany translation', () => {
  const t = tr([['fr', 'FR', 'Le Parrain'], ['de', 'AT', 'Der Pate (AT)'], ['de', 'DE', 'Der Pate']]);
  assert.strictEqual(ctx.germanTitle(t, 'title', 'The Godfather'), 'Der Pate');
  assert.strictEqual(ctx.germanTitle(tr([['de', 'CH', 'Der Pate']]), 'name', 'The Godfather'), 'Der Pate');
});

test('germanTitle is empty when it matches the shown title or is missing', () => {
  assert.strictEqual(ctx.germanTitle(tr([['de', 'DE', 'Fight Club']]), 'title', 'Fight Club'), '');
  assert.strictEqual(ctx.germanTitle(tr([['de', 'DE', 'Mission: Impossible']]), 'title', 'Mission Impossible'), '');
  assert.strictEqual(ctx.germanTitle(tr([['de', 'DE', '']]), 'title', 'Heat'), '');
  assert.strictEqual(ctx.germanTitle(tr([['en', 'US', 'Heat']]), 'title', 'Heat'), '');
  assert.strictEqual(ctx.germanTitle(undefined, 'title', 'Heat'), '');
});

test('germanTitle keeps titles that have accented letters', () => {
  assert.strictEqual(ctx.germanTitle(tr([['de', 'DE', 'Die fabelhafte Welt der Amélie']]), 'title', 'Amélie'), 'Die fabelhafte Welt der Amélie');
});
