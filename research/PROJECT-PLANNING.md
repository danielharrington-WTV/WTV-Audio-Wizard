# WTVAudioWizard — project planning deliverables

**Author:** Daniel H.  
**Date:** 2026-09-12  
**Status:** Planning complete for tasks due Sep 12 and earlier. Implementation is at **v0.7.1**; this document captures the decisions those tasks required and maps them to the current product.

**Related docs:** [project-planning.html](project-planning.html) (this content, HTML), [HANDOFF.md](../HANDOFF.md) (authoritative implementation state), [ARCHITECTURE-VALIDATION.md](ARCHITECTURE-VALIDATION.md), [WORKFLOW-REVIEW-2026-09-10.md](WORKFLOW-REVIEW-2026-09-10.md), [service/schema.py](../service/schema.py)

---

## 1. Current workflow assessment — Exploratory (due Sep 7)

**Assignees:** Christopher W., Daniel H.

### Current production workflow (WTV today)

External mix via **Polarity Audioworks** on a ~22:30 episode. Times below are editor-side unless noted.

| # | Step | Est. time | Notes |
|---|---|---|---|
| 1 | Nest any remixed music | <5 min | Prevents an AAF export glitch |
| 2 | Export AAF | 15–20 min | Handoff package for external post |
| 3 | Upload AAF to Dropbox | 5–10 min | |
| 4 | Email Polarity Audioworks with Dropbox link | — | Vendor turnaround not included below |
| 5 | Download/import new audio streams into Premiere; mute existing | 5–10 min | Re-alignment against locked picture |
| 6 | QAQC | ~30 min | Per 22:30 episode |

**Revision loop (QAQC fails):** send back to Polarity with fix notes → re-import returned streams and QAQC again (**15–20 min** per revision cycle), plus another vendor round trip.

**Editor-side time (happy path, excluding Polarity):** ~**60–75 min** per episode. Each failed QAQC adds at least one more 15–20 min re-import/QAQC pass.

**Pain points:** vendor dependency; AAF export/upload/re-import round-trip (with music-nesting workaround); revision loops; no in-timeline iteration for dialogue/duck fixes without another full cycle.

### Proposed in-panel workflow (WTVAudioWizard)

```
Connect → Options (model/stems) → 1 Prepare → 2 Clean → 3 Add tracks → 4 Duck music
                                              ↘ Fix a pop (optional, post-step-3)
                                              ↘ Enhance low end (optional, any time)
```

- **Non-destructive to source sequence:** work happens in a clone; raw media, trims, speed, and video links stay intact.
- **Aligned stem insertion:** Clean dialogue (+ optional Ambience/Music stems) land on new tracks below raw.
- **Native music finishing:** existing timeline music gets Amplify keyframes — no media replacement.
- **Local GPU service:** GAP-URGENet / MossFormer2 + optional Bandit v2; no cloud upload of program audio.

### Validated in real use (Sep 9–11)

- Native music ducking (Amplify keyframe pass)
- Per-clip Prepare → Clean → Add tracks
- Dialogue dynamics chain (multiband leveling + de-ess)
- Music pass after compression change (422 silent-music fix)
- Partial dialogue selection on a track

### Still exploratory / open

- Full acceptance of Fix a pop, Enhance low end intensity cog, and workflow-review items 4–9 in installed Premiere
- Mac portability (panel likely feasible; local CUDA service is Windows-centric today)
- Whether post house time savings justify GPU workstation per editor vs shared service

**Assessment conclusion:** The Polarity AAF round-trip (~60–75 min editor time per episode, plus vendor latency and revision loops) is the main cost driver WTVAudioWizard targets. In-Premiere cleanup + ducking removes export/upload/email/re-import for those steps and keeps QAQC inside the same timeline. MVP scope (below) matches what Dan has already validated on real material.

---

## 2. Minimal viable product (MVP) definition (due Sep 8)

**Goal:** Reduce post-audio labor cost while keeping editorial control inside Premiere.

### MVP = v0.7.1 core path

| Capability | MVP? | Notes |
|---|---|---|
| UXP panel in Premiere 25.6+ | Yes | 300×480 dock; token auth to local service |
| Per-clip dialogue cleanup (GAP-URGENet default) | Yes | Selected clips on dedicated tracks |
| Full-sequence mode | Yes | Secondary; dialogue-only input |
| Insert Clean dialogue on aligned tracks | Yes | Raw → Clean; processed raw muted when whole lane cleaned |
| Optional Bandit stems (Ambience, Music) | Yes | Off by default |
| Native music conform + duck | Yes | Step 4; editable Amplify keyframes |
| Dialogue reference: Clean dialogue or Choose tracks | Yes | Default Clean dialogue |
| Levels (RMS/LUFS targets) + peak protection | Yes | Factory: dialogue −12, music −28, ambience −30 dBFS |
| Fix a pop (seeded plosive attenuation) | Yes* | Built; native re-confirmation pending |
| Enhance low end (whisper body, 0.2–3×) | Yes* | Built; listening acceptance pending |
| De-click · Experimental | No (opt-in) | Off by default; false-positive risk documented |
| AV-CASS separator | No | Pending Linux/WSL worker |
| Session recovery after panel reload | No | Deferred |
| Cloud / remote service | No | Local loopback only for MVP |
| Model installer / redistribution package | No | Dev folder + manual env setup |

\*Included in build; treat as MVP only after Dan’s native acceptance pass.

### MVP success criteria

1. Editor completes steps 1–4 on a typical WTV dialogue+music sequence without leaving Premiere (except first-time output folder pick).
2. Clean dialogue is audibly improved vs raw on representative WTV mic setups.
3. Music ducking follows dialogue activity; keyframes remain editable.
4. Original sequence and source media unchanged; clone is clearly named.
5. Failures produce Copy report diagnostics (token redacted).

### Out of MVP (see WANTS)

Voice polish, dialogue richness, automatic click detection, session resume, packaging installer, workflow-review fixes 4–9 (until individually approved). macOS is a **NEED (N13)**, not deferred to WANTS.

---

## 3. End goal, capabilities, and schema — NEEDS (due Sep 8)

**Assignees:** Christopher W., Daniel H., Shane A.

### End goal

**One local AI-assisted audio post panel** that:

1. Cleans dialogue from raw production audio inside a Premiere clone.
2. Optionally extracts semantic stems (ambience, music) without replacing timeline music.
3. Finishes existing timeline music with measured baseline + dialogue-triggered ducking.
4. Offers small repair utilities (pop fix, whisper body boost) without a full re-clean.
5. Preserves non-destructive editorial workflow (undo, trims, effects, video links).

**Cost target:** Replace repeated manual export/import and hand ducking for standard WTV shows — not replace a mixing engineer for final delivery.

### NEEDS — required capabilities

| ID | Need | Implementation |
|---|---|---|
| N1 | Authenticated local HTTP API | `service/app.py` on `127.0.0.1:8756`, bearer token |
| N2 | Upload/export WAV assets by ID | `POST /v1/assets`, `GET /v1/assets/{id}/download` |
| N3 | Async cleanup job with cancel | `POST /v1/jobs`, poll, `DELETE` cancel |
| N4 | Dialogue enhancement (choose one model) | GAP-URGENet (default) or MossFormer2 |
| N5 | Optional stem separation | Bandit v2 when Ambience and/or Music checked |
| N6 | Finishing: level, duck envelope, peak safety | RMS/LUFS normalization, threshold duck, 4× OS peak cap |
| N7 | Premiere clone, export, import, overwrite | `plugin/premiere.js`, per-clip/full-sequence paths |
| N8 | Native music analysis + keyframes | `POST /v1/music-analysis`, Amplify in `music-pass.js` |
| N9 | Strict request validation | Pydantic `Strict` models, extra fields forbidden |
| N10 | Diagnostics | Copy report, job timings, cache flags |
| N11 | Seeded pop attenuation | `POST /v1/deplosive` |
| N12 | Whole-clip low-end body boost | `POST /v1/lowend` |
| N13 | **macOS compatibility** | Premiere UXP panel on macOS; local GPU service with validated CUDA/MPS path, macOS install/start script, and native acceptance on Apple Silicon — **required, pending implementation** |

### Service schema (canonical)

Defined in [service/schema.py](../service/schema.py). Version **1**; breaking changes require `settings.version` bump.

#### `Settings` (job finishing + separation)

| Field | Type | Default | Purpose |
|---|---|---|---|
| `version` | int | 1 | Schema version lock |
| `separator` | `bandit_v2` \| `av_cass` \| `provided_stems` | `bandit_v2` | Stem engine |
| `enhancer` | `mossformer2` \| `gap_urgenet` \| `none` | `gap_urgenet` | Dialogue model |
| `separate_ambience` | bool | false | Extract effects/ambience stem |
| `separate_music` | bool | false | Extract music stem |
| `deess_declick` | bool | false | Experimental click repair |
| `unit` | `rms_dbfs` \| `lufs` | `rms_dbfs` | Loudness measure |
| `stems` | list[Stem] | dialogue −12, music −28 duck, effects −30 | Per-role targets |
| `duck_db` | 0–30 | 10 | Max duck depth |
| `attack_ms` | 10–1000 | 200 | Duck attack |
| `release_ms` | 50–3000 | 1200 | Duck release |
| `threshold_dbfs` | −70…−10 | −40 | Speech/activity floor |
| `max_boost_db` | 0–24 | 8 | Normalization cap |
| `output_rate` | 44100 \| 48000 \| 96000 | 48000 | Output sample rate |

#### `Stem`

| Field | Type | Notes |
|---|---|---|
| `name` | `dialogue` \| `music` \| `effects` | Exactly one of each required |
| `target` | float −70…−6 | dBFS or LUFS per `unit` |
| `duck` | bool | Dialogue triggers duck on this stem when true |

#### `JobRequest`

| Field | Type | Notes |
|---|---|---|
| `tracks` | 1–3 × `Track` | Roles depend on `separator` |
| `settings` | `Settings` | Full finishing config |

#### `Track`

| Field | Type | Notes |
|---|---|---|
| `asset_id` | 32-char hex | Uploaded WAV |
| `role` | `mixture` \| `dialogue` \| `music` \| `effects` | Validated per separator mode |

#### Standalone endpoints

| Model | Endpoint | Key fields |
|---|---|---|
| `DeplosiveRequest` | `POST /v1/deplosive` | `asset_id`, `seed_seconds` 0–600 |
| `LowEndRequest` | `POST /v1/lowend` | `asset_id`, `intensity` 0.2–3.0 |

#### Client-only (not in service schema)

- Duck against: `clean` \| `tracks` + chosen track IDs (`plugin/dialogue-selector.js`)
- Panel layout, scroll state, per-sequence dialogue preferences
- Output folder paths (Premiere media persistence)

**Schema rule:** Service rejects unknown fields and non-finite numbers. Panel preferences stay client-side so service jobs remain reproducible from uploaded assets + `Settings` alone.

---

## 4. Enhancements — WANTS (due Sep 9)

**Assignees:** Dan R., Daniel H.

Prioritized backlog. **None approved for implementation** unless Dan explicitly approves (see HANDOFF approval boundary).

### P1 — Correctness (from workflow review)

| ID | Want | Source |
|---|---|---|
| W1 | Music effect ownership survives reorder / partial removal | Review item 4 |
| W2 | Reused empty track unmuted after clean insert | Review item 5 |
| W3 | Fix a pop detects slip/speed/effect edits during processing | Review item 6 |
| W4 | Pop rollback restores full clip state with readback | Review item 7 |
| W5 | Pop cancel during upload/DSP/download; less aggressive export cancel | Review item 8 |
| W6 | Music Undo models both effect + keyframe transactions | Review item 9 |

### P2 — Workflow & quality

| ID | Want | Notes |
|---|---|---|
| W7 | Session recovery after panel reload | Persist clone ↔ dialogue paths ↔ job manifest |
| W8 | Improved de-click detection (report-first) | See DECLICK-RESEARCH.md; keep repair off by default |
| W9 | Native gain automation for pop repair | Avoid full clip replace; needs envelope equivalence tests |
| W10 | Sparse music keyframes | Reduce 0.25 dB subdivision overhead |
| W11 | Stage-grouped batches | One model resident; fewer reloads when stems + cleanup mixed |
| W12 | Cache/storage eviction policy | `stage-cache` grows unbounded today |
| W13 | Voice polish chain | VOICE-POLISH-PLAN.md — scrapped as integrated feature; revisit only with milestone 1 listening |
| W14 | Premiere markers for click/pop report | Text report only today |
| W15 | Auto-detect output folder from project | User asked; needs API + persistence design |

### P3 — Platform & distribution

| ID | Want | Notes |
|---|---|---|
| W17 | AV-CASS integration | Linux/WSL worker, video-aware contract |
| W18 | Installer + model distribution | Licensing check for checkpoint redistribution |
| W19 | Remote hosted service | TLS, auth, queue — see ARCHITECTURE-VALIDATION.md |
| W20 | Essential Sound / clip tagging | Not exposed in UXP; positional/track rules used instead |

---

## 5. Plan before code (due Sep 10)

**Assignee:** Daniel H.

Architecture and phasing agreed before implementation. Code now exists at v0.7.1; this section is the retrospective plan record.

### Architecture

```
┌─────────────────────┐         HTTPS/token          ┌──────────────────────�
│  Premiere UXP panel │ ◄──────────────────────────► │  Local Python service │
│  plugin/*.js        │    upload assets, jobs,      │  service/*.py         │
│                     │    music-analysis, deplosive │  runners/*.py (GPU)   │
└─────────┬───────────┘                              └──────────┬───────────┘
          │ clone/export/import                                  │ one GPU job
          ▼                                                      ▼
   Premiere Project                                    work/wtv-data, stage-cache
```

**Principles preserved in code:**

1. Never replace raw clips — add aligned stems in a clone.
2. Bandit speech output never feeds dialogue cleanup.
3. Existing timeline music finished with native effects, not extracted stems.
4. Upload bytes once; refer by `asset_id` (remote-ready contract).
5. One GPU model resident; worker reuse with idle unload.
6. Immutable stage cache keyed by audio + checkpoint + runner identity.
7. Every timeline edit verified before/after; Copy report on failure.

### Implementation phases (executed)

| Phase | Target | Delivered |
|---|---|---|
| 0 — Validation | Adobe API proof, model GPU smoke | ARCHITECTURE-VALIDATION.md, Sep 5–8 |
| 1 — Core pipeline | Export → GAP/Moss → insert clean | v0.4–0.5 |
| 2 — Per-clip + stems | Bandit optional, partial selection | v0.6–0.7.0 |
| 3 — Native music pass | Amplify ducking | v0.7.0, confirmed Sep 9 |
| 4 — Repair utilities | Fix a pop, Enhance low end | v0.7.1 |
| 5 — Workflow hardening | Review items 1–3, dynamics chain, UI polish | Sep 10–11 |

### Phase 6 — Next (Sep 14+ tasks on board)

Per parent task schedule: coding/testing continues with **native acceptance** and **approved** fixes only.

1. Confirm Fix a pop + Enhance low end on real Premiere.
2. Dan approves workflow-review items individually (4–9).
3. macOS service path (N13).
4. De-click: detection/reporting before any default-on repair.
5. Measure long-sequence memory; bound peak analysis if needed.
6. Packaging decision (ZIP vs installer) after MVP sign-off.

### Approval gate (ongoing)

Dan requested **one fix at a time** with explanation before implementation. Findings 4–9 and optimizations in §4 remain **proposed, not approved**. Do not expand scope without explicit OK.

---

## Task checklist — Daniel H (Sep 12 and earlier)

| Subtask | Due | Status | Notes |
|---|---|---|---|
| Current workflow assessment — Exploratory | Sep 7 | **Complete** | §1; Christopher W. to confirm production workflow details |
| Minimal viable product definition | Sep 8 | **Complete** | §2 |
| End goal + schema (NEEDS) | Sep 8 | **Complete** | §3; Shane A. to confirm schema meets downstream needs |
| Enhancements (WANTS) | Sep 9 | **Complete** | §4; Dan R. to prioritize business value |
| Plan before any code is written | Sep 10 | **Complete** | §5 (retrospective; code already aligned) |

---

## Open questions for reviewers

1. **Christopher W.:** Does §1 match how post currently quotes time/cost? Any show types excluded from MVP?
2. **Shane A.:** Does the `Settings` / `JobRequest` schema in §3 cover integration or reporting needs?
3. **Dan R.:** Which WANTS (§4) rank highest for cost savings after MVP sign-off?
4. **Dan (product):** Confirm Fix a pop + Enhance low end as MVP or move to WANTS until native pass completes.
