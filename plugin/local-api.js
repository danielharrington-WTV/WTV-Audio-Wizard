// Premiere rejects the narrower loopback manifest entries on this user's host.
// Manifest permission is broader than this application-level guard; keep every
// panel request here and revisit the manifest when host matching is reliable.
//
// The service has no pairing token (removed 2026-10-12 at Dan's request): it
// trusts loopback and private (RFC 1918) LAN clients only, so the panel may
// connect to the same computer or to a GPU server on the local network, always
// on port 8756. The URL shape is checked by hand rather than with URL(), whose
// behaviour differs between UXP versions.
const PORT = '8756';

function privateIPv4(host) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return false;
  const octets = match.slice(1).map(part => (part.length > 1 && part[0] === '0') ? NaN : Number(part));
  if (octets.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = octets;
  if (a === 127) return host === '127.0.0.1';
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function normalizeBaseUrl(value) {
  const base = String(value).trim().replace(/\/$/, '');
  const match = /^http:\/\/([A-Za-z0-9.]+):(\d+)$/.exec(base);
  const host = match ? match[1].toLowerCase() : '';
  if (!match || match[2] !== PORT || !(host === 'localhost' || privateIPv4(host))) {
    throw new Error('Use http://127.0.0.1:8756 for a service on this computer, or http://<LAN address>:8756 (for example http://192.168.0.176:8756) for a GPU server on the local network.');
  }
  return `http://${host}:${PORT}`;
}

async function requestLocal(baseUrl, path, options = {}, transport = fetch) {
  const base = normalizeBaseUrl(baseUrl);
  const route = /^\/v1\/(?:health|defaults|workers\/release|quality-jobs(?:\/[0-9a-f]{32})?|music-analysis|noise-profile|deplosive|lowend|assets(?:\/[0-9a-f]{32}(?:\/download)?)?|jobs(?:\/[0-9a-f]{32}(?:\/result\/(?:dialogue|music|effects|mix))?)?)$/;
  if (!route.test(path)) throw new Error('Unexpected local service endpoint.');
  const url = base + path;
  const headers = {...(options.headers || {})};
  for (const name of Object.keys(headers)) if (name.toLowerCase() === 'authorization') delete headers[name];
  let response;
  try {
    response = await transport(url, {
      ...options,
      credentials: 'omit',
      redirect: 'error',
      headers
    });
  } catch (error) {
    if (/manifest entry not found|permission denied to the url/i.test(String(error))) {
      throw new Error('Network permission is still blocked in panel v0.8.7. Confirm UXP Developer Tool lists version 0.8.7. This build uses the broad network permission workaround; preserve the original UDT error for diagnosis: ' + String(error));
    }
    throw error;
  }
  // UXP versions differ in fetch option support. Our API has no redirects;
  // reject a changed final URL too, without treating this as a network sandbox.
  if (response.url && response.url !== url) throw new Error('Unexpected redirect from the local service.');
  if (!response.ok) {
    const detail = await response.text();
    if (response.status === 401) throw new Error('Service reached, but it still asks for the old pairing token. Update the service to v0.7.3 (git pull) and restart it, then connect again.');
    if (response.status === 403 && /Local client required|LAN client required/.test(detail)) throw new Error(`Service reached, but it refused this connection (${detail.trim()}). The service accepts only this computer and private LAN addresses; check the URL, and update/restart an older service that accepts only 127.0.0.1.`);
    throw new Error(`Service ${response.status}: ${detail}`);
  }
  return response;
}

module.exports = {normalizeBaseUrl, privateIPv4, requestLocal};
