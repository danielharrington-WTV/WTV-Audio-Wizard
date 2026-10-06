// Premiere rejects the narrower loopback manifest entries on this user's host.
// Manifest permission is broader than this application-level guard; keep every
// panel request here and revisit the manifest when host matching is reliable.
function normalizeBaseUrl(value) {
  const base = String(value).trim().replace(/\/$/, '');
  if (!/^http:\/\/(127\.0\.0\.1|localhost):8756$/.test(base)) {
    throw new Error('Use http://127.0.0.1:8756 or http://localhost:8756 for the local service.');
  }
  return base;
}

async function requestLocal(baseUrl, token, path, options = {}, transport = fetch) {
  const base = normalizeBaseUrl(baseUrl);
  const route = /^\/v1\/(?:health|defaults|workers\/release|quality-jobs(?:\/[0-9a-f]{32})?|music-analysis|deplosive|lowend|assets(?:\/[0-9a-f]{32}(?:\/download)?)?|jobs(?:\/[0-9a-f]{32}(?:\/result\/(?:dialogue|music|effects|mix))?)?)$/;
  if (!route.test(path)) throw new Error('Unexpected local service endpoint.');
  const url = base + path;
  let response;
  try {
    response = await transport(url, {
      ...options,
      credentials: 'omit',
      redirect: 'error',
      headers: {...(options.headers || {}), Authorization: `Bearer ${token}`}
    });
  } catch (error) {
    if (/manifest entry not found|permission denied to the url/i.test(String(error))) {
      throw new Error('Network permission is still blocked in panel v0.8.2. Confirm UXP Developer Tool lists version 0.8.2. This build uses the broad network permission workaround; preserve the original UDT error for diagnosis: ' + String(error));
    }
    throw error;
  }
  // UXP versions differ in fetch option support. Our API has no redirects;
  // reject a changed final URL too, without treating this as a network sandbox.
  if (response.url && response.url !== url) throw new Error('Unexpected redirect from the local service.');
  if (!response.ok) {
    const detail = await response.text();
    if (response.status === 401) throw new Error('Service reached. Paste the pairing token printed by start-service.ps1, then connect again.');
    throw new Error(`Service ${response.status}: ${detail}`);
  }
  return response;
}

module.exports = {normalizeBaseUrl, requestLocal};
