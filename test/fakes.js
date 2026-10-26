// Script properties kept in memory, like PropertiesService.getScriptProperties().
function fakeProperties(initial) {
  const store = Object.assign({}, initial);
  const props = {
    store,
    getProperty: k => (k in store ? store[k] : null),
    getProperties: () => Object.assign({}, store),
    setProperty: (k, v) => { store[k] = String(v); },
    setProperties: vals => { for (const [k, v] of Object.entries(vals)) store[k] = String(v); },
    deleteProperty: k => { delete store[k]; }
  };
  return { getScriptProperties: () => props, store };
}

module.exports = { fakeProperties };
