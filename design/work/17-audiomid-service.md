# audiomid — Docker-first Audio-to-MIDI Toolkit

**Status:** Plan approved, not yet started  
**Role in strasbeat:** Sidecar service. Strasbeat consumes its API to power a future "Import from audio" feature. audiomid is a standalone repo — it does not live inside this workspace.

---

## Research corrections (assumptions verified before planning)

| Assumption in brief                   | Reality (April 2026)                                                                                                 |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Madmom for rhythm                     | Broken on Python 3.10+ — use BeatNet + librosa instead                                                               |
| `facebookresearch/demucs`             | Archived Jan 2025 — use `adefossez/demucs` (same author, active fork, same pip package)                              |
| Basic Pitch TS                        | Browser-side only. Python `basic-pitch` is correct for a backend service                                             |
| One transcription model fits all      | Confirmed: polyphonic (Basic Pitch), monophonic (pYIN/torchcrepe), piano-specific (ByteDance) need separate branches |
| Smart routing needs neural classifier | ffprobe + lightweight librosa features (spectral centroid, ZCR, onset density) is sufficient for v1 — no neural net  |
| Node proxy needed for Python→BullMQ   | Not needed. `bullmq` pip package (taskforcesh) is fully interoperable with the TS BullMQ — same Redis wire protocol  |

---

## Resolved design decisions

1. **Python–BullMQ wiring:** Python worker uses `bullmq` pip package directly. No Node proxy. TS API produces jobs; Python worker consumes them via the same Lua scripts.

2. **Job topology:** One queue `audio.analysis`, one job per request, internal stage-progress updates in the job itself. Multi-queue parent/child is over-engineered for v1.

3. **Artifact persistence:** MinIO only. Shared volumes create coupling and break horizontal worker scaling. API uploads source audio to MinIO, passes the object key in the BullMQ payload. Worker reads from and writes to MinIO. API returns presigned URLs.

4. **Postgres:** Deferred. BullMQ's Redis retention (`removeOnComplete: { age: 86400, count: 500 }`, `removeOnFail: { age: 604800 }`) covers v1 polling needs. Add Postgres only when user ownership or cross-job search is required.

5. **Remote URL intake:** Deferred to v2. SSRF and redirect-chain edge cases are not worth handling in v1. v1 accepts direct upload or MinIO object key reference only.

6. **Smart routing:** Worker-side deterministic decision tree, informed by API-supplied hints + ffprobe metadata + optional lightweight librosa features. No neural classifier in v1.

7. **Rhythm vs. notes:** Both branches are first-class. When `analysisMode = both`, normalization and optional separation run once; then note transcription and rhythm extraction run concurrently as Python asyncio tasks.

8. **Python version:** 3.11-slim. Madmom is dropped entirely — incompatible with 3.10+.

9. **Rhythm stack:**
   - BPM: `librosa.beat.tempo()` (fast baseline) or BeatNet (more accurate on complex music)
   - Beat grid + downbeats + meter: BeatNet
   - Drum events: Demucs drum stem → ADTLib

---

## 1. Architecture overview

```
         ┌─────────────────────────────────────────────────────┐
         │                  Docker Compose                     │
         │                                                     │
Client ──┤──► api (Hono/TS) ──► redis (BullMQ) ──► worker    │
         │        │                                   │        │
         │        ▼                                   ▼        │
         │    minio (S3) ◄──────────────────────── minio       │
         │                                                     │
         └─────────────────────────────────────────────────────┘
```

The API is stateless and lightweight. It never touches audio data after handing it to MinIO. The worker does all heavy computation and writes all artifacts to MinIO. Redis carries only job metadata — never audio bytes.

---

## 2. Service responsibilities

### `api` — TypeScript + Hono

- Request validation (MIME, size, duration hints)
- Multipart file intake: stream directly to MinIO via `@aws-sdk/client-s3` — never buffer the full file in Node.js memory
- `Queue.add()` — creates job with MinIO key + normalized options in payload
- `GET /v1/jobs/:jobId` — reads BullMQ job state from Redis, returns structured status
- `GET /v1/jobs/:jobId/result` — returns presigned MinIO URLs for completed artifacts
- `POST /v1/jobs/:jobId/cancel` — calls `job.remove()` or `job.discard()`
- Health + readiness checks
- Correlation ID injection on every request

### `redis` — Redis 7 Alpine

- BullMQ queue state, retry metadata, stage progress
- No raw audio, no large blobs — only job payloads (target < 4 KB per job)
- Retention: completed jobs 24h, failed jobs 7d

### `worker-audio` — Python 3.11 + bullmq

- Pulls jobs from `audio.analysis` queue
- Runs the full audio pipeline: validate → normalize → classify → route → (separate?) → transcribe + rhythm → assemble → write
- Updates `job.updateProgress()` at each stage with `{ stage, pct, message }`
- Models loaded once at startup, kept in memory for lifecycle of the worker process
- Writes all artifacts to MinIO
- Sets `job.returnvalue` to a structured result manifest (keys only, no blobs)

### `minio` — MinIO (S3-compatible)

- Bucket `uploads/` — raw uploaded audio (immutable source of truth)
- Bucket `artifacts/` — all generated outputs keyed by `{jobId}/`
- Bucket `cache/` — normalized WAV (shared between stages, cleaned after TTL)
- Single pre-created user with bucket-scoped credentials
- Console on port 9001 for local inspection

### `postgres` — Deferred to v2

Add when user ownership, cross-job history search, or analytics become requirements.

---

## 3. Docker Compose topology

```yaml
# infra/compose/docker-compose.yml
services:
  api:
    build: ../../apps/api
    ports: ["3000:3000"]
    environment:
      REDIS_URL: redis://redis:6379
      MINIO_ENDPOINT: http://minio:9000
      MINIO_ACCESS_KEY: ${MINIO_ACCESS_KEY}
      MINIO_SECRET_KEY: ${MINIO_SECRET_KEY}
      UPLOAD_MAX_BYTES: 209715200 # 200 MB
    depends_on:
      redis: { condition: service_healthy }
      minio: { condition: service_healthy }
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/v1/health"]
      interval: 10s

  redis:
    image: redis:7-alpine
    volumes:
      - redis-data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s

  worker-audio:
    build: ../../apps/worker-audio
    environment:
      REDIS_URL: redis://redis:6379
      MINIO_ENDPOINT: http://minio:9000
      MINIO_ACCESS_KEY: ${MINIO_ACCESS_KEY}
      MINIO_SECRET_KEY: ${MINIO_SECRET_KEY}
      WORKER_CONCURRENCY: "2"
      MODEL_CACHE_DIR: /models
    volumes:
      - model-cache:/models
    mem_limit: 8g # HTDemucs headroom
    depends_on:
      redis: { condition: service_healthy }
      minio: { condition: service_healthy }
    # GPU profile (v2):
    # deploy:
    #   resources:
    #     reservations:
    #       devices: [{driver: nvidia, count: 1, capabilities: [gpu]}]

  minio:
    image: minio/minio:latest
    command: server /data --console-address ":9001"
    ports: ["9000:9000", "9001:9001"]
    environment:
      MINIO_ROOT_USER: ${MINIO_ACCESS_KEY}
      MINIO_ROOT_PASSWORD: ${MINIO_SECRET_KEY}
    volumes:
      - minio-data:/data
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:9000/minio/health/live"]
      interval: 10s

volumes:
  redis-data:
  minio-data:
  model-cache: # persists downloaded Demucs/BeatNet models across restarts
```

### Dockerfile strategy

**`api`** — Node.js multi-stage build. Stage 1: `node:22-alpine` compile TS. Stage 2: `node:22-alpine` runtime only, no devDeps.

**`worker-audio`** — Single-stage `python:3.11-slim`. Install ffmpeg via apt in a single `RUN` layer. Models are **not** baked into the image — they download to the `model-cache` volume on first run. Basic Pitch (~20 MB) is the one exception: it's bundled in the pip package.

```dockerfile
# apps/worker-audio/Dockerfile
FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .
CMD ["python", "-m", "worker.main"]
```

No host installs. No local Python, ffmpeg, Redis, or models outside Compose.

---

## 4. API contract

### `POST /v1/jobs/analyze`

Accepts `multipart/form-data`. File field: `audio`. All options as form params or JSON body alongside the file, or body-only with `sourceKey` for an already-uploaded file.

```jsonc
// Request
{
  "analysisMode":   "auto | notes | rhythm | both",   // default: "auto"
  "separationMode": "auto | force | skip",             // default: "auto"
  "outputFormat":   "midi | midi+json | json",         // default: "midi+json"
  "sourceType":     "full_mix | vocal | bass | melody | piano | guitar | drums | drum_loop | stem | unknown",
                                                       // default: "unknown"
  "monophonicHint":        false,    // treat as single melodic line
  "tempoHint":             128,      // user-supplied BPM — skips estimation
  "keyHint":               "Am",     // optional, for future use
  "includeDebugArtifacts": false,    // save normalized WAV + stems
  // OR instead of file upload:
  "sourceKey": "uploads/abc123/source.mp3"
}

// Response 202 Accepted
{
  "jobId": "jb_01jxyz...",
  "status": "queued",
  "analysisMode": "both",
  "pollingUrl":  "/v1/jobs/jb_01jxyz...",
  "resultUrl":   "/v1/jobs/jb_01jxyz.../result",
  "estimatedStages": ["normalizing", "separating", "transcribing_notes", "tracking_beats"]
}
```

### `GET /v1/jobs/:jobId`

```jsonc
{
  "jobId": "jb_01jxyz...",
  "status": "queued | active | completed | failed | cancelled",
  "stage":  "validating | normalizing | classifying | routing | separating |
             transcribing_notes | tracking_beats | transcribing_drums |
             assembling_midi | writing_artifacts | completed | failed",
  "progress":    45,              // 0–100
  "stageMessage": "Running HTDemucs 4-stem...",
  "createdAt":   "2026-04-12T...",
  "updatedAt":   "2026-04-12T...",
  "analysisMode": "both",
  "resolvedRoute": "full_mix→separate→notes+rhythm",
  "warnings": [],
  "failureReason": null,
  "artifactsAvailable": false
}
```

### `GET /v1/jobs/:jobId/result`

Available only when `status === "completed"`.

```jsonc
{
  "jobId": "jb_01jxyz...",
  "artifacts": {
    "midi": "https://…/result.mid?X-Amz-…", // presigned, 1h TTL
    "notesJson": "https://…/result.notes.json?…",
    "rhythmJson": "https://…/result.rhythm.json?…",
    "jobSummary": "https://…/job-summary.json?…", // always present
    "stems": {
      // only if separation ran
      "drums": "https://…/stems/drums.wav?…",
      "bass": "https://…/stems/bass.wav?…",
      "vocals": "https://…/stems/vocals.wav?…",
      "other": "https://…/stems/other.wav?…",
    },
    "debug": {
      "normalizedWav": null, // only if includeDebugArtifacts
    },
  },
  "routing": {
    "inputClassification": "full_mix",
    "separationRan": true,
    "notesTranscribed": true,
    "rhythmExtracted": true,
    "drumsTranscribed": true,
    "backends": {
      "notes": "basic-pitch@0.2.6",
      "rhythm": "beatnet@1.0",
      "separation": "demucs-htdemucs@4.0",
    },
  },
  "warnings": [],
  "inputMetadata": {
    "duration": 182.4,
    "channels": 2,
    "sampleRate": 44100,
    "codec": "aac",
  },
}
```

### Other endpoints

```
POST /v1/jobs/:jobId/cancel    → 204 or 409 if already terminal
POST /v1/jobs/:jobId/retry     → 202 with new jobId
GET  /v1/health                → { "status": "ok" }
GET  /v1/ready                 → 200 when Redis + MinIO reachable, 503 otherwise
GET  /v1/metrics               → Prometheus text (Phase 4)
```

---

## 5. Queue / job lifecycle

**Queue:** `audio.analysis`

**BullMQ job payload** (what goes into Redis — no audio bytes):

```jsonc
{
  "jobId": "jb_01jxyz...", // ULIDv2
  "sourceKey": "uploads/jb_01jxyz.../source.mp3",
  "contentHash": "sha256:abc...", // for future dedup
  "options": {
    "analysisMode": "both",
    "separationMode": "auto",
    "outputFormat": "midi+json",
    "sourceType": "unknown",
    "monophonicHint": false,
    "tempoHint": null,
    "keyHint": null,
    "includeDebugArtifacts": false,
  },
  "inputMetadata": {
    // populated by API from ffprobe before enqueue
    "duration": 182.4,
    "channels": 2,
    "sampleRate": 44100,
    "codec": "aac",
    "fileSizeBytes": 14200000,
  },
}
```

**Retry policy:** `{ attempts: 3, backoff: { type: "exponential", delay: 5000 } }`

**Retention:** `removeOnComplete: { age: 86400, count: 500 }` / `removeOnFail: { age: 604800 }`

**Concurrency:** `WORKER_CONCURRENCY=2` per container (safe on a 4-core CPU host).

**Progress updates** (worker → `job.updateProgress()`):

```json
{ "stage": "separating", "pct": 35, "message": "Running HTDemucs 4-stem..." }
```

**Cancellation:** Worker checks `await job.isCancelled()` at each stage boundary; cleans up partial artifacts on cancellation.

**Idempotency / dedup:** `contentHash + JSON(options)` can be used as a dedup key. Deferred to Phase 4 — v1 does not dedup.

---

## 6. Worker pipeline design

Pipeline runs as an async Python function. Shared artifacts (normalized WAV, stems) are written to MinIO and re-referenced by key. Nothing large is held in memory across stages.

```
Input
  │
  ▼
[1] INTAKE / VALIDATE
    • ffprobe → duration, channels, sample rate, codec
    • Reject: unsupported codec, > 200 MB, > 90 minutes
    • SHA-256 content hash
    • Merge with API-supplied inputMetadata
  │
  ▼
[2] NORMALIZE
    • ffmpeg: decode → stereo (mono if monophonicHint) → 44100 Hz → 16-bit PCM WAV
    • Write: artifacts/{jobId}/normalized.wav
    • If includeDebugArtifacts: also write debug/normalized.wav
  │
  ▼
[3] CLASSIFY / ROUTE
    • Input: sourceType + monophonicHint + ffprobe metadata
    • If sourceType == "unknown": lightweight librosa analysis (< 500ms)
      spectral centroid, spectral flatness, onset density, ZCR → classify
    • Output: ResolvedRoute { separationRequired, notesMode, rhythmMode, stemOverride }
  │
  ▼
[4] SEPARATE  (only when separationRequired)
    • demucs CLI: htdemucs 4-stem on normalized.wav
    • Write stems: artifacts/{jobId}/stems/{drums,bass,vocals,other}.wav
  │
  ▼
[5a] TRANSCRIBE NOTES  (if notesMode != "skip") ─────────────┐
    • Select input: stem ("other" or "bass") or normalized.wav │ concurrent
    • polyphonic → basic-pitch on selected source              │ (asyncio)
    • monophonic → librosa.pyin() on selected source           │
    • Output: raw note events list                             │
[5b] TRACK RHYTHM  (if rhythmMode != "skip") ────────────────┘
    • BPM: librosa.beat.tempo() (fast) or BeatNet (complex music)
    • Beat grid + downbeats + meter: BeatNet on normalized.wav
    • If rhythmMode == "beats+drums":
        ADTLib on stems/drums.wav (or normalized.wav if no separation)
        → kick, snare, hi-hat onset times
    • Output: rhythm events
  │
  ▼
[6] ASSEMBLE MIDI
    • Track 0 (meta): tempo event from BPM (or tempoHint if supplied)
    • Track 1+ (notes): one track per source
    • Channel 10 (drums): drum events if available
    • Velocity: from basic-pitch confidence score (0–127)
    • Timing: raw — no quantization in v1
    • Library: mido
    • Write: artifacts/{jobId}/result.mid
  │
  ▼
[7] WRITE ARTIFACTS
    • result.notes.json
    • result.rhythm.json
    • job-summary.json
    • Update progress → completed / 100%
    • job.returnvalue = ResultManifest (MinIO keys only)
```

**Model loading:** All models (BeatNet, Basic Pitch) are loaded into module-level singletons at `worker.main` startup. ffmpeg is invoked as a subprocess. This avoids cold start per job.

---

## 7. Smart routing design

The routing decision is a pure function — entirely explicit, testable, no ML needed in v1.

```python
def resolve_route(
    options: JobOptions,
    ffprobe: AudioMetadata,
    librosa_features: LightFeatures | None,
) -> ResolvedRoute: ...
```

**Decision tree:**

| sourceType                        | separationRequired         | notesMode                   | rhythmMode  |
| --------------------------------- | -------------------------- | --------------------------- | ----------- |
| `drums` / `drum_loop`             | False                      | skip                        | beats+drums |
| `stem`                            | False                      | polyphonic_or_mono(options) | skip        |
| `vocal` / `melody` / `bass`       | False                      | monophonic                  | beats       |
| `piano` / `guitar` / `polyphonic` | False                      | polyphonic                  | beats       |
| `full_mix`                        | `separationMode != "skip"` | polyphonic                  | beats+drums |
| `unknown`                         | see below                  | see below                   | see below   |

**Unknown path** (lightweight librosa analysis):

- `channels == 1 AND spectral_flatness < 0.1` → treat as `melody`
- `onset_density > 8/sec AND spectral_centroid > 4000` → treat as `drums`
- else → treat as `full_mix` (conservative default)

**Overrides applied last:**

- `separationMode == "force"` → always `separationRequired = True`
- `separationMode == "skip"` → always `separationRequired = False`
- `analysisMode == "notes"` → `rhythmMode = "skip"`
- `analysisMode == "rhythm"` → `notesMode = "skip"`

**v2 routing improvement:** Small classifier (< 1 MB SVM on librosa features) or a lightweight audio tagging model to improve unknown-input accuracy.

---

## 8. Rhythm branch design

Rhythm is a first-class branch, not an afterthought. It runs concurrently with note transcription when `analysisMode = both`.

**Stack:**

| Task                          | Tool                                   | Notes                                         |
| ----------------------------- | -------------------------------------- | --------------------------------------------- |
| BPM estimation                | `librosa.beat.tempo()`                 | Fast baseline, used if BeatNet is unavailable |
| Beat grid + downbeats + meter | BeatNet                                | PyTorch, Python 3.11-compatible               |
| Drum event detection          | ADTLib on drum stem                    | Kick / snare / hi-hat onset times             |
| Fallback for ADTLib           | `librosa` onset detection on drum stem | If ADTLib install fails                       |

**Input routing:**

- Beat tracking: always on `normalized.wav` (full mix is fine for BPM/grid)
- Drum events: on `stems/drums.wav` if separation ran, otherwise on `normalized.wav`

**Output:** `result.rhythm.json` (see schema below).

---

## 9. Artifact schemas

### `result.notes.json`

```jsonc
{
  "schemaVersion": "1.0",
  "source": "basic-pitch",
  "sourceVersion": "0.2.6",
  "inputDuration": 182.4,
  "tracks": [
    {
      "id": "main",
      "sourceAudio": "normalized",
      "events": [
        {
          "pitch": 60,
          "pitchName": "C4",
          "onset": 0.512,
          "offset": 0.875,
          "confidence": 0.92,
          "velocity": 87,
        },
      ],
    },
  ],
  "warnings": [],
}
```

### `result.rhythm.json`

```jsonc
{
  "schemaVersion": "1.0",
  "bpm": 128.0,
  "meter": "4/4",
  "confidence": 0.94,
  "beatTimes": [0.0, 0.47, 0.94, 1.41],
  "downbeatTimes": [0.0, 1.88, 3.76],
  "drums": {
    "source": "adtlib",
    "events": [
      { "type": "kick", "time": 0.0, "confidence": 0.98 },
      { "type": "snare", "time": 0.469, "confidence": 0.95 },
      { "type": "hihat", "time": 0.234, "confidence": 0.87 },
    ],
  },
  "warnings": [],
}
```

### `job-summary.json`

```jsonc
{
  "jobId": "jb_01jxyz...",
  "createdAt": "2026-04-12T...",
  "inputMetadata": { "duration": 182.4, "channels": 2, "sampleRate": 44100 },
  "resolvedRoute": "full_mix→separate→notes+rhythm",
  "stagesRun": [
    "normalizing",
    "separating",
    "transcribing_notes",
    "tracking_beats",
    "transcribing_drums",
    "assembling_midi",
  ],
  "backends": {
    "notes": "basic-pitch@0.2.6",
    "rhythm": "beatnet@1.0",
    "separation": "demucs-htdemucs@4.0",
  },
  "artifactsGenerated": [
    "result.mid",
    "result.notes.json",
    "result.rhythm.json",
    "stems/drums.wav",
  ],
  "warnings": [],
  "durationSeconds": { "total": 47.2, "normalize": 3.1, "separate": 21.4 },
}
```

---

## 10. Error / retry strategy

**Failure categories** (classified by worker, stored in `job.failedReason`):

| Category        | Retry?        | Example                         |
| --------------- | ------------- | ------------------------------- |
| `invalid_input` | No            | Corrupt file, unsupported codec |
| `too_large`     | No            | > 200 MB or > 90 min            |
| `model_error`   | Yes (up to 3) | Basic Pitch crash               |
| `storage_error` | Yes (up to 3) | MinIO write timeout             |
| `timeout`       | Yes (up to 2) | Stage exceeded wall-clock limit |
| `oom`           | No            | Worker OOM-killed               |

**Stage timeouts:**

| Stage                 | Limit                   |
| --------------------- | ----------------------- |
| Normalization         | 60s                     |
| Classification        | 10s                     |
| Separation (HTDemucs) | 300s for ≤ 10 min audio |
| Note transcription    | 120s                    |
| Rhythm extraction     | 60s                     |
| Total job             | 600s                    |

**Partial cleanup:** On failure, worker records partially-written MinIO keys in the `failedReason` payload. A maintenance job (Phase 4) handles orphan cleanup.

---

## 11. Observability

**Correlation IDs:** Every API request generates a ULID `correlationId`. Injected into BullMQ job payload, all structured logs, and `job-summary.json`.

**Structured logging:**

- API: pino → JSON to stdout
- Worker: structlog → JSON to stdout
- Format: `{ "ts": "...", "level": "info", "correlationId": "...", "jobId": "...", "stage": "separating", "msg": "HTDemucs started", "durationMs": 0 }`

**Stage timing:** Worker wraps each stage in a `@timed` decorator that logs stage name + elapsed ms. Totals appear in `job-summary.json`.

**Queue metrics (Phase 4):** `Queue.getJobCounts()` exposed at `GET /v1/metrics` in Prometheus text format: `bullmq_queue_waiting`, `bullmq_queue_active`, `bullmq_queue_failed`.

**Diagnosing problems:**

| Problem           | How to inspect                                                         |
| ----------------- | ---------------------------------------------------------------------- |
| Stuck jobs        | `redis-cli KEYS bull:audio.analysis:*` → inspect `job:{id}` hashes     |
| Model crashes     | Worker logs include full traceback at ERROR level with `jobId`         |
| Storage failures  | MinIO client logs 503/ConnectionError; check MinIO container logs      |
| OOM               | Docker emits `Killed` in container logs; job fails with `oom` category |
| Oversized uploads | Rejected at API layer with HTTP 413 before hitting Redis               |

---

## 12. Repo structure

```
audiomid/
├── apps/
│   ├── api/                          # Hono + TypeScript
│   │   ├── src/
│   │   │   ├── index.ts              # Hono app entry
│   │   │   ├── routes/
│   │   │   │   ├── jobs.ts           # POST /analyze, GET /:id, GET /:id/result
│   │   │   │   └── health.ts
│   │   │   ├── queue/
│   │   │   │   └── producer.ts       # BullMQ Queue wrapper
│   │   │   ├── storage/
│   │   │   │   └── minio.ts          # S3Client wrapper: upload, presign
│   │   │   ├── validation/
│   │   │   │   └── job-options.ts    # Zod schemas for request validation
│   │   │   └── middleware/
│   │   │       └── correlation.ts
│   │   ├── Dockerfile
│   │   └── package.json
│   │
│   └── worker-audio/                 # Python 3.11
│       ├── worker/
│       │   ├── main.py               # BullMQ Worker entry + model preload
│       │   ├── pipeline.py           # top-level job handler
│       │   ├── stages/
│       │   │   ├── intake.py         # ffprobe validation
│       │   │   ├── normalize.py      # ffmpeg normalization
│       │   │   ├── routing.py        # classify + resolve_route() — unit-tested
│       │   │   ├── separate.py       # Demucs abstraction
│       │   │   ├── transcribe.py     # Basic Pitch / pYIN abstraction
│       │   │   ├── rhythm.py         # BeatNet + librosa + ADTLib
│       │   │   ├── assemble.py       # MIDI assembly (mido)
│       │   │   └── artifacts.py      # JSON serialization + MinIO write
│       │   ├── models.py             # singleton model loader
│       │   └── storage.py            # MinIO client (minio-py / boto3)
│       ├── tests/
│       ├── requirements.txt
│       └── Dockerfile
│
├── packages/
│   ├── shared-types/                 # TS: JobPayload, ProgressUpdate, ResultManifest
│   ├── shared-validation/            # Zod schemas — used by API, referenced by worker tests
│   └── config/                       # env parsing helpers (zod-based)
│
├── infra/
│   ├── compose/
│   │   ├── docker-compose.yml
│   │   ├── docker-compose.override.yml   # local dev: volume mounts for hot reload
│   │   └── .env.example
│   └── docker/
│       └── minio-init.sh             # bucket creation on first boot (mc mb)
│
└── docs/
    ├── api.md
    ├── routing.md
    └── strasbeat-integration.md
```

**Conventions:**

- `packages/shared-types` is the single source of truth for cross-service contracts
- Python keeps local copies of the JSON schemas (manually kept in sync or generated from TS types)
- `worker/stages/routing.py` is unit-tested independently of the full pipeline

---

## 13. Phased implementation plan

### Phase 1 — Plumbing (no real audio processing)

Goal: complete request-to-result loop with a fake worker.

- Repo + Compose skeleton (all 4 services)
- Hono API: `/analyze` endpoint streams file directly to MinIO, enqueues BullMQ job, returns `jobId`
- Python worker: `bullmq` consumer that sleeps 5s, writes a dummy `job-summary.json` to MinIO, marks job complete
- `GET /v1/jobs/:jobId` returns real BullMQ state from Redis
- `GET /v1/jobs/:jobId/result` returns presigned MinIO URLs
- MinIO bucket init script (`minio-init.sh`)
- `GET /v1/health`, `GET /v1/ready`
- Health checks wired in Compose
- Smoke test: `curl -F audio=@test.mp3 http://localhost:3000/v1/jobs/analyze` → poll → download dummy result

**Risk to validate in Phase 1:** MinIO presigned URL + AWS SDK v3 `forcePathStyle: true` — test this before trusting it works.

### Phase 2 — Real preprocessing + baseline transcription

Goal: first real MIDI output from a real audio file.

- ffprobe intake stage (validate codec, duration, channels)
- ffmpeg normalization stage (to 44100 Hz WAV)
- Basic Pitch integration (polyphonic transcription)
- `librosa.beat.tempo()` BPM extraction
- MIDI assembly (mido) — single-track output
- `result.notes.json` and `result.rhythm.json` artifacts written
- Stage progress updates wired
- Unit tests: normalization, MIDI assembly, artifact serialization

### Phase 3 — Smart routing + separation + rhythm branch

Goal: full routing logic, Demucs, BeatNet, drum detection.

- `resolve_route()` decision tree
- Lightweight librosa classification for unknown inputs
- HTDemucs 4-stem separation (`adefossez/demucs`)
- BeatNet integration (beats + downbeats + meter)
- ADTLib on drum stem
- Per-stem note transcription
- Drum channel (ch 10) in MIDI
- `monophonicHint` → pYIN path
- Failure categories + partial artifact cleanup
- End-to-end test suite with real audio fixtures (< 10s clips)

### Phase 4 — Production hardening

- Model preload at worker startup (eliminate per-job cold start)
- Stage timeouts enforced
- `POST /v1/jobs/:jobId/cancel` and `POST /v1/jobs/:jobId/retry`
- Structured logging with correlation IDs in both services
- `GET /v1/metrics` (BullMQ queue counts)
- MinIO artifact TTL cleanup job (`audio.maintenance` queue)
- Horizontal worker scaling test (run 2+ worker containers)
- GPU Compose profile with CUDA worker Dockerfile variant
- Auth placeholder (API key header, gated per endpoint)

### Phase 5 — Quality + specialist backends

- torchcrepe for monophonic melody (replaces pYIN)
- ByteDance Piano Transcription path (`sourceType: "piano"`, GPU-targeted)
- BeatNet meter detection surfaced in `result.rhythm.json`
- Dedup by `contentHash + JSON(options)` (carried from Phase 4)
- Richer confidence/warning model
- Webhook support (`POST /v1/webhooks/register`, triggered on completion)

---

## 14. v1 / v2 boundary

**v1 ships:**

- All four Docker services
- Upload + MinIO object key reference input
- `analysisMode`: `notes | rhythm | both | auto`
- Basic Pitch (polyphonic), pYIN (monophonic), HTDemucs (separation), BeatNet (beats), ADTLib (drums)
- MIDI + JSON artifacts
- Presigned URL result retrieval
- Cancel + retry
- Health + readiness

**v2 adds:**

- Remote URL intake (with SSRF mitigations)
- torchcrepe specialist (monophonic)
- ByteDance Piano Transcription (piano-specific, GPU)
- Postgres for long-term job history + user ownership
- Webhooks
- Auth + rate limiting
- Dedup by content hash
- Score output (MusicXML) — if demand exists
- `outputFormat: "strudel"` — Strudel codegen server-side (see Strasbeat integration below)

---

## 15. Major risks and tradeoffs

| Risk                                                 | Severity                       | Mitigation                                                                                        |
| ---------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------- |
| HTDemucs needs 8 GB RAM                              | High on resource-limited hosts | `mem_limit: 8g` in Compose; skip-separation escapehatches are always available                    |
| Demucs archived repo                                 | Medium                         | `pip install demucs` still resolves to `adefossez/demucs` (same author). Monitor PyPI.            |
| Model cold-start time                                | Medium                         | Load all models at worker startup (Phase 4). First job after deploy is slow; subsequent are fast. |
| MinIO presigned URL / AWS SDK v3 `SignatureMismatch` | Low-Medium                     | Known issue — use `forcePathStyle: true` + correct endpoint. Test in Phase 1.                     |
| Basic Pitch accuracy on dense polyphony              | Medium                         | Accept limitation; separate first for full mixes. Document expected accuracy.                     |
| ADTLib on Python 3.11                                | Low                            | If install fails, fall back to `librosa` onset detection on drum stem as immediate replacement.   |
| CPU inference speed for long audio                   | High                           | 90-minute max enforced in v1. Document expected latencies. GPU profile in Phase 4.                |
| BeatNet on complex non-4/4 music                     | Low-Medium                     | BeatNet handles 3/4; degrade gracefully for truly irregular meter.                                |

---

## 16. Recommended first build order

1. `infra/compose/docker-compose.yml` — get all 4 containers talking to each other
2. MinIO bucket init script + healthcheck
3. `packages/shared-types` — define `JobPayload`, `ProgressUpdate`, `ResultManifest` TS interfaces
4. `apps/api`: file upload → MinIO stream, BullMQ enqueue, return `jobId`
5. `apps/worker-audio`: fake processor — polls, sleeps, writes dummy artifact, marks complete
6. `GET /v1/jobs/:jobId` and `GET /v1/jobs/:jobId/result` with presigned URLs
7. End-to-end smoke test: `curl -F audio=@test.mp3 http://localhost:3000/v1/jobs/analyze`
8. Replace fake worker with real ffprobe + ffmpeg normalization
9. Add Basic Pitch transcription + `librosa` BPM
10. Add routing logic + BeatNet + ADTLib
11. Add Demucs separation path last (most memory/time cost, most risk)

---

## Appendix: Strasbeat sidecar integration

This is the primary reason audiomid is being built. The design above already accommodates the integration cleanly. **strasbeat owns the Strudel codegen; audiomid knows nothing about Strudel.**

Strasbeat already has `src/midi-to-strudel.js` that converts MIDI to Strudel pattern strings. audiomid produces MIDI + structured JSON. The integration layer lives entirely inside strasbeat.

### The flow

```
strasbeat UI: "Import from audio" button
  → user picks local audio file
  → POST /v1/jobs/analyze  (analysisMode: "both", outputFormat: "midi+json")
  → strasbeat polls GET /v1/jobs/:jobId every 2s  (shows stage in UI)
  → on completed:
      - fetch result.rhythm.json → BPM → setcps(BPM/60/4)
      - fetch result.mid → midi-to-strudel.js → note patterns
      - fetch result.rhythm.json drums → map kick/snare/hihat → s("bd ~ sd ~") string
  → open assembled Strudel code in editor, ready to evaluate
```

### What the service must produce for this to work

- `result.rhythm.json.bpm` must always be present when `analysisMode != "notes"`
- `result.notes.json.tracks[].events` must be sortable and carry clean `onset`/`offset`
- Drum events must be typed as `kick` / `snare` / `hihat` so strasbeat can map them to Strudel sound names (`bd`, `sd`, `hh`)
- The MIDI file must have a tempo event on track 0

All of this is already in the schemas above.

### CORS

strasbeat runs on `localhost:5173`. audiomid runs on `localhost:3000`. Hono CORS middleware must explicitly allow the strasbeat origin. In production, audiomid needs a stable domain and CORS config.

### v2 bonus

Add `outputFormat: "strudel"` that returns a ready-to-paste Strudel snippet server-side — `setcps` + note patterns + drum pattern. Tempting, but keep strasbeat as the Strudel expert in v1. The codegen quality depends on musical context and iteration, which only the strasbeat side can provide.
