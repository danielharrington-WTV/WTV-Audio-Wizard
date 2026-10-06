# Connected dialogue quality review

**Check dialogue quality** uses DNSMOS P.835 on the connected WTV service CPU. Use the same Connect button and pairing token as dialogue cleanup. There is no separate helper, folder picker or file queue on the editing computer.

## Setup and use

Update the service environment from `requirements.lock.txt`, restart `start-service.ps1`, and reload/reconnect the panel. The first quality job downloads the pinned 1.16 MB model into the service data directory (`models/dnsmos`); later scans work without Internet. ONNX Runtime is CPU-only. No additional GPU or editing-machine Python install is required.

Open **Options > Dialogue quality**, adjust the review threshold if needed. Select one or more dialogue audio clips on the timeline. Clear mixer solos, then click **Check dialogue quality** on Main. Each selected clip is isolated in a temporary sequence and exported over its own visible time range without modifying the original; unselected clips on the same track are excluded. The verified WAV is uploaded through the existing authenticated asset API, analyzed, then removed from the service after completion, failure or cancellation. Confirmed local exports are deleted; uncertain exports remain because Premiere may still be writing.

A maximum of two quality jobs (running plus queued) is allowed. One dedicated CPU worker prevents parallel DNSMOS scans and keeps the main model worker independent. Progress and cancellation use `/v1/quality-jobs`. Quality reports are in-memory; restarting the service requires rerunning a scan. The panel never adds markers from a failed/cancelled job or if the available timeline/effect signature changes.

The threshold is part of each cleanup preset, Save/Load settings and Reset this preset to defaults. No selection means no scan; there is no whole-track fallback. Existing clip effects/mute Amplify and mixer processing remain; select audible dialogue clips. Mixer solos cannot be fully inspected by UXP; leave the mixer unchanged while scanning.

**Deployment limitation:** the existing connection transport is still loopback-only (`127.0.0.1:8756` / `localhost:8756`). This change does not add remote-host/HTTPS support. An M2 panel no longer needs a separate quality helper, but connecting it to a different machine remains a separate service-deployment task.

## Scores and flags

- 16 kHz model input; 48 kHz exports resampled with a polyphase filter. Regular P.835 calibration from Microsoft's reference implementation. P.808 is not used.
- About 9.01 seconds per window, 1-second hop, including the final tail. Short audio is repeated for inference as in the reference implementation; it provides less context and deserves cautious interpretation.
- Mono or stereo; stereo channels assessed independently and the channel with lower overall score supplies the window's scores, preventing anti-phase stereo from cancelling into silence.
- Windows below -60 dBFS RMS are skipped. **This is a silence gate, not voice activity detection**; select speech clips only. Music, whispering, deliberate effects and unusual voices can trigger low scores.
- Default overall-score review threshold: **1.5**. Configurable 1–5; higher flags more sections. It is an editorial preference, not a validated broadcast cutoff or an intelligibility percentage.
- Overlapping flagged windows merge into review regions. Comments include minimum speech, background and overall scores. Markers identify approximate sections, not individual defects. Maximum 500 regions, explicitly reported if truncated.
- Reruns replace only `WTV quality | A… | …` markers for the matching clip track/start/end scope. Other markers and other clip scopes remain. Legacy whole-track quality markers are not automatically removed. Marker creation and colouring are separate Undo steps.
- Selected clips of 0.4 seconds to 30 minutes each, mono/stereo. Windows are analyzed separately per clip and marker times are offset/clamped to that clip on the timeline. CPU thread count capped at four. Memory is bounded by one audio window plus result metadata.

## Validation limits

CPU inference and authenticated service jobs are tested on Windows. Live Premiere marker/export behavior and M2 use remain unverified. Tests use real ONNX inference plus mocked Premiere host interactions. Review flags are not a substitute for listening.

## Attribution

Model and calibration: Microsoft DNS-Challenge, revision `591184a9fcb2cbdec02520fed81a32bbbf9d73ff`.

- [DNSMOS source and paper citations](https://github.com/microsoft/DNS-Challenge/tree/591184a9fcb2cbdec02520fed81a32bbbf9d73ff/DNSMOS)
- [Repository license (CC BY 4.0)](https://github.com/microsoft/DNS-Challenge/blob/591184a9fcb2cbdec02520fed81a32bbbf9d73ff/LICENSE)
- [Code license (MIT)](https://github.com/microsoft/DNS-Challenge/blob/591184a9fcb2cbdec02520fed81a32bbbf9d73ff/LICENSE-CODE)

This adaptation adds bounded window reads, polyphase resampling, independent stereo assessment, per-window flags, cancellation and a local file queue. It is not endorsed by Microsoft. The model is downloaded unchanged, pinned to its Git blob hash; the Python implementation is adapted. Preserve this attribution when distributing.

MIT License — Copyright (c) Microsoft Corporation.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
