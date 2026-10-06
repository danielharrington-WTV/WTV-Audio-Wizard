# Designing for a remote processing service

Dan flagged that `http://127.0.0.1:8756` (currently a local process on his own
machine) will eventually be a remote server, and asked to develop with that in
mind since a remote call is slower and less reliable than a loopback one. This
is a reference for that shift, not a change in behavior today -- no code
changed as part of writing this.

## Hard blocker, not just a performance concern

`plugin/local-api.js`'s `normalizeBaseUrl()` currently **rejects anything that
isn't `127.0.0.1:8756` or `localhost:8756`** by regex. Nothing else in this
plan matters until that's deliberately relaxed -- today the panel cannot talk
to a remote host at all, by design (the comment there says the loopback
restriction is itself a workaround for a Premiere manifest-permission issue,
so relaxing it needs its own investigation, not just a regex edit).

Two things have to change together when that happens, not just the regex:
- **HTTPS becomes mandatory.** The service uses a Bearer token
  (`Authorization: Bearer <token>`) over plain HTTP today, which is fine on
  loopback (traffic never leaves the machine) and not fine the moment the
  host is remote -- the token would be readable by anything between Dan and
  the server. This is a correctness/security requirement, not a "nice to
  have," and should land in the same change that allows a non-loopback host.
- **The allowed-host check should become an explicit allowlist the user
  configures**, not "anything goes" -- keep validating the URL shape, just
  widen what shape is accepted, deliberately.

## What actually needs to stay server-side vs. what's just CPU math

The `/v1/jobs` pipeline (Bandit v2, GAP URGENet, MossFormer2, AV-CASS-shaped
future models) needs a GPU and model weights -- that has to live on a server,
local or remote, regardless of latency. Nothing about "remote-readiness"
changes that; the question is only how the panel talks to it.

Two endpoints are different. `service/app.py` documents both explicitly as
"CPU DSP... not a model job," always synchronous, never cached:

- **`/v1/deplosive`** (Fix a pop) -- plain numpy envelope-based attenuation
  around a human-seeded point, on a few seconds of already-locally-exported
  audio (`service/deplosive.py`).
- **`/v1/lowend`** (Enhance low end) -- a whole-file psychoacoustic effect,
  same synchronous/uncached shape.

These are candidates to eventually reimplement in plugin JS and skip the
round trip entirely, since they need no model and no GPU -- but see
"Where the latency actually bites" below for why this is lower priority than
it first looks, and why Dan chose to document this rather than start porting
one today.

## Where the latency actually bites

Round-trip cost is a function of frequency x payload, not just "is this call
slow." Ranked by exposure if the service were remote right now:

1. **Per-clip batch processing (`clip-batch.js processBatch`)** -- one
   upload + one job poll + one download per stem, per clip, run **sequentially
   in a `for` loop** (see `processBatch`'s clip loop). On a 100+ clip batch
   this is by far the highest call frequency in the whole panel, and it's
   exactly the traffic that *can't* move client-side (it needs the model).
   This is the one to design around first: sequential per-clip round trips
   that are cheap on loopback become the dominant wall-clock cost the moment
   each one carries real network latency. The existing reuse/manifest cache
   (`clip-batch.json`, skips re-upload and re-processing for a clip already
   done with the same settings) already helps on re-runs and is the right
   pattern to lean on further -- worth revisiting whether uploads/downloads
   for *different* clips in the same batch could be pipelined (start
   uploading clip N+1 while clip N is still processing) instead of strictly
   one-at-a-time, once this is actually pointed at a remote host to measure
   against.
2. **Fix a pop / Enhance low end / standalone Extract ambience** -- one clip
   at a time, user-triggered, infrequent. Low frequency means remote latency
   here is a few extra seconds occasionally, not a multiplied cost across a
   long batch. This is the weaker case for the porting effort mentioned
   above: moving `deplosive.py`'s algorithm to plugin JS removes a round trip
   that wasn't the actual bottleneck to begin with. Worth doing eventually,
   not worth doing before item 1 above is addressed.
3. **Verify loudness / music-analysis** -- exports the full sequence locally
   either way (Premiere-side, unavoidable); whatever gets sent to the service
   from that export is comparatively rare (one verification run, not
   per-clip).

## Things that already don't assume near-zero latency (no change needed)

- `clip-batch.js`'s job poll uses a 1s `sleep` and a 90-minute deadline --
  both already generous enough for real network latency, not tuned for LAN
  speed.
- `local-api.js`'s `requestLocal()` already separates a network/connection
  failure from an HTTP-status error in its error messages, which is the right
  shape to build on for "service unreachable" vs. "service rejected this"
  once timeouts and retries actually matter.
- The 1536 MiB per-WAV upload ceiling (`main.js`) and the README's documented
  512 MiB preview limit are bandwidth-aware sizing, not loopback-only
  assumptions.

## Recommendation

Sequential per-clip round trips in `processBatch` are the real latency risk,
not the two CPU-DSP endpoints Dan's question was prompted by. When remote
readiness becomes an active project (not now): first widen `local-api.js`'s
host check + require HTTPS together, then measure the per-clip batch loop
against a real remote host before deciding whether to pipeline it, cache
harder, or batch multiple clips per request. Porting Fix a pop/Enhance low
end to plugin-side JS is a reasonable follow-up after that, not a
prerequisite -- it removes round trips that were never the dominant cost.
