const test = require('node:test');
const assert = require('node:assert/strict');
const {normalizeBaseUrl, requestLocal} = require('../plugin/local-api.js');

test('music analysis and exact temporary-asset deletion routes are allowed',async()=>{
  const calls=[];
  for(const route of ['/v1/music-analysis','/v1/workers/release','/v1/assets/'+'a'.repeat(32)]) {
    await requestLocal('http://127.0.0.1:8756',route,{},async url=>{calls.push(url);return {ok:true};});
  }
  assert.equal(calls.length,3);
});
test('deplosive and asset-download routes are allowed (regression for "Unexpected local service endpoint")',async()=>{
  const calls=[];
  for(const route of ['/v1/deplosive','/v1/lowend','/v1/assets/'+'a'.repeat(32)+'/download']) {
    await requestLocal('http://127.0.0.1:8756',route,{},async url=>{calls.push(url);return {ok:true};});
  }
  assert.equal(calls.length,3);
  await assert.rejects(requestLocal('http://127.0.0.1:8756','/v1/assets/not-hex/download',{},async()=>({ok:true})));
});

test('allows loopback and private LAN hosts on the service port (token-free LAN, 2026-10-12)', () => {
  assert.equal(normalizeBaseUrl(' http://127.0.0.1:8756/ '), 'http://127.0.0.1:8756');
  assert.equal(normalizeBaseUrl('http://localhost:8756'), 'http://localhost:8756');
  assert.equal(normalizeBaseUrl('http://LOCALHOST:8756'), 'http://localhost:8756');
  for (const url of ['http://192.168.0.176:8756', 'http://192.168.25.252:8756', 'http://10.0.0.5:8756', 'http://172.16.0.1:8756', 'http://172.31.255.254:8756']) {
    assert.equal(normalizeBaseUrl(url + '/'), url);
  }
});
test('rejects public, malformed and decorated service URLs', () => {
  for (const url of ['https://example.com', 'http://example.com:8756', 'https://192.168.0.176:8756', 'http://127.0.0.1:80', 'http://192.168.0.176', 'http://192.168.0.176:87560',
    'http://localhost:8756.evil.com', 'http://localhost:8756@evil.com', 'http://user:pw@192.168.0.176:8756', 'http://192.168.0.176:8756/path', 'http://192.168.0.176:8756?url=https://example.com', 'http://192.168.0.176:8756#x',
    'http://8.8.8.8:8756', 'http://172.15.0.1:8756', 'http://172.32.0.1:8756', 'http://192.169.0.1:8756', 'http://11.0.0.1:8756', 'http://127.0.0.2:8756', 'http://0.0.0.0:8756', 'http://169.254.1.1:8756',
    'http://192.168.0.256:8756', 'http://192.168.0:8756', 'http://192.168.0.1.5:8756', 'http://192.168.00.1:8756', 'http://192.168.0.-1:8756', 'http://[::1]:8756', 'http://evil.192.168.0.1:8756', '', 'http://']) {
    assert.throws(() => normalizeBaseUrl(url), /LAN address/, url);
  }
});
test('blocks invalid hosts and routes before any fetch', async () => {
  let calls = 0;
  const fetch = async () => {calls++;};
  await assert.rejects(requestLocal('http://example.com:8756', '/v1/health', {}, fetch));
  for (const path of ['//example.com', '/v1/jobs/../../secret', '/v1/health?redirect=evil', '/v1/jobs/abc/result/mix']) {
    await assert.rejects(requestLocal('http://127.0.0.1:8756', path, {}, fetch));
  }
  assert.equal(calls, 0);
});
test('sends LAN requests without any Authorization header, with redirect protection', async () => {
  let observed;
  await requestLocal('http://192.168.0.176:8756', '/v1/health', {headers: {'Content-Type': 'application/json', authorization: 'Bearer stale'}}, async (url, options) => {
    observed = options;
    assert.equal(url, 'http://192.168.0.176:8756/v1/health');
    return {ok: true, url};
  });
  assert.deepEqual(Object.keys(observed.headers).map(k => k.toLowerCase()), ['content-type']);
  assert.equal(observed.redirect, 'error');
  assert.equal(observed.credentials, 'omit');
});
test('rejects a redirect away from the LAN service', async () => {
  await assert.rejects(requestLocal('http://192.168.0.176:8756', '/v1/health', {}, async () => ({ok: true, url: 'http://192.168.0.176:8756/elsewhere'})), /redirect/);
});
test('rejects changed final URL if host ignores redirect option', async () => {
  await assert.rejects(requestLocal('http://localhost:8756', '/v1/health', {}, async () => ({ok: true, url: 'https://example.com'})), /redirect/);
});
test('explains an old token-only service and an old loopback-only service', async () => {
  await assert.rejects(requestLocal('http://localhost:8756', '/v1/health', {}, async () => ({ok: false, status: 401, text: async () => 'Unauthorized'})), /old pairing token.*restart/);
  await assert.rejects(requestLocal('http://192.168.0.176:8756', '/v1/health', {}, async () => ({ok: false, status: 403, text: async () => '{"detail":"Local client required"}'})), /refused this connection/);
  await assert.rejects(requestLocal('http://localhost:8756', '/v1/health', {}, async () => {throw Error('Manifest entry not found.');}), /v0\.8\.3/);
});

test('quality jobs use allowlisted routes only, with no Authorization header',async()=>{
 for(const route of ['/v1/quality-jobs','/v1/quality-jobs/'+'a'.repeat(32)])await requestLocal('http://127.0.0.1:8756',route,{},async(url,opts)=>{assert.equal(opts.headers.Authorization,undefined);return {ok:true};});
 await assert.rejects(requestLocal('http://127.0.0.1:8756','/v1/quality-jobs/not-a-job',{},async()=>{throw Error('must not fetch');}),/Unexpected local service endpoint/);
});
