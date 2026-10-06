const test = require('node:test');
const assert = require('node:assert/strict');
const {normalizeBaseUrl, requestLocal} = require('../plugin/local-api.js');

test('music analysis and exact temporary-asset deletion routes are allowed',async()=>{
  const calls=[];
  for(const route of ['/v1/music-analysis','/v1/workers/release','/v1/assets/'+'a'.repeat(32)]) {
    await requestLocal('http://127.0.0.1:8756','test',route,{},async url=>{calls.push(url);return {ok:true};});
  }
  assert.equal(calls.length,3);
});
test('deplosive and asset-download routes are allowed (regression for "Unexpected local service endpoint")',async()=>{
  const calls=[];
  for(const route of ['/v1/deplosive','/v1/lowend','/v1/assets/'+'a'.repeat(32)+'/download']) {
    await requestLocal('http://127.0.0.1:8756','test',route,{},async url=>{calls.push(url);return {ok:true};});
  }
  assert.equal(calls.length,3);
  await assert.rejects(requestLocal('http://127.0.0.1:8756','test','/v1/assets/not-hex/download',{},async()=>({ok:true})));
});

test('allows only the two loopback hosts on the service port', () => {
  assert.equal(normalizeBaseUrl(' http://127.0.0.1:8756/ '), 'http://127.0.0.1:8756');
  assert.equal(normalizeBaseUrl('http://localhost:8756'), 'http://localhost:8756');
  for (const url of ['https://example.com', 'http://127.0.0.1:80', 'http://localhost:8756.evil.com', 'http://localhost:8756@evil.com', 'http://localhost:8756/path', 'http://localhost:8756?url=https://example.com']) {
    assert.throws(() => normalizeBaseUrl(url));
  }
});
test('blocks invalid hosts and routes before any fetch', async () => {
  let calls = 0;
  const fetch = async () => {calls++;};
  await assert.rejects(requestLocal('http://example.com:8756', 'test', '/v1/health', {}, fetch));
  for (const path of ['//example.com', '/v1/jobs/../../secret', '/v1/health?redirect=evil', '/v1/jobs/abc/result/mix']) {
    await assert.rejects(requestLocal('http://127.0.0.1:8756', 'test', path, {}, fetch));
  }
  assert.equal(calls, 0);
});
test('sends local requests with token and redirect protection', async () => {
  let observed;
  await requestLocal('http://127.0.0.1:8756', 'test-token', '/v1/health', {}, async (url, options) => {
    observed = options;
    assert.equal(url, 'http://127.0.0.1:8756/v1/health');
    return {ok: true, url};
  });
  assert.equal(observed.headers.Authorization, 'Bearer test-token');
  assert.equal(observed.redirect, 'error');
  assert.equal(observed.credentials, 'omit');
});
test('rejects changed final URL if host ignores redirect option', async () => {
  await assert.rejects(requestLocal('http://localhost:8756', 'test', '/v1/health', {}, async () => ({ok: true, url: 'https://example.com'})), /redirect/);
});
test('distinguishes bad tokens from manifest permissions', async () => {
  await assert.rejects(requestLocal('http://localhost:8756', 'test', '/v1/health', {}, async () => ({ok: false, status: 401, text: async () => 'Unauthorized'})), /Service reached/);
  await assert.rejects(requestLocal('http://localhost:8756', 'test', '/v1/health', {}, async () => {throw Error('Manifest entry not found.');}), /v0\.8\.2/);
});

test('quality jobs use authenticated allowlisted routes only',async()=>{
 for(const route of ['/v1/quality-jobs','/v1/quality-jobs/'+'a'.repeat(32)])await requestLocal('http://127.0.0.1:8756','test',route,{},async(url,opts)=>{assert.equal(opts.headers.Authorization,'Bearer test');return {ok:true};});
 await assert.rejects(requestLocal('http://127.0.0.1:8756','test','/v1/quality-jobs/not-a-job',{},async()=>{throw Error('must not fetch');}),/Unexpected local service endpoint/);
});
