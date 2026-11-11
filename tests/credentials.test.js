const assert = require('node:assert/strict');
const providers = require('../content/providers.js');

(async () => {
  let vault = [];
  let clears = 0;
  global.Services = { logins: {
    findLogins: (origin, form, realm) => {
      assert.equal(origin, 'chrome://metadata-reconciler');
      assert.equal(realm, 'SerpApi API Key');
      return vault.slice();
    },
    addLoginAsync: async login => { vault.push(login); },
    modifyLogin: (old, login) => { vault[vault.indexOf(old)] = login; },
    removeLogin: login => { vault.splice(vault.indexOf(login), 1); }
  } };
  global.Ci = { nsILoginInfo: {} };
  global.Cc = { '@mozilla.org/login-manager/loginInfo;1': { createInstance: () => ({
    init(origin, form, realm, username, password) { Object.assign(this, { origin, realm, username, password }); }
  }) } };
  const api = { ...providers, providerSettings: { serpKey: '' }, lookupCache: { clear() { clears++; } } };
  await api.saveSerpApiKey('  test-key-one  ');
  assert.equal(vault.length, 1);
  api.providerSettings.serpKey = '';
  await api.loadSerpApiKey();
  assert.equal(api.providerSettings.serpKey, 'test-key-one');
  await api.saveSerpApiKey('test-key-two');
  assert.equal(vault.length, 1);
  assert.equal(vault[0].password, 'test-key-two');
  await api.saveSerpApiKey('');
  assert.equal(vault.length, 0);
  assert.equal(api.providerSettings.serpKey, '');
  assert.ok(clears >= 4);
  console.log('Credential-manager save, reload, replacement and deletion passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
