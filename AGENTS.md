# transcode-service — API Documentation for Agents

> Documentation destinee aux agents (Claude Code, etc.) qui veulent integrer
> l'API transcode-service en TypeScript ou autre langage. Format schema-first,
> types complets, exemples verifies empiriquement le 2026-05-24.

## TL;DR

**Service HTTP REST qui transcode des videos via ffmpeg + NVENC (GPU GB10 Blackwell).**

- **Base URL**: `https://transcode.agi-so.fr`
- **Auth**: HTTP Basic Auth (`Authorization: Basic <base64(user:password)>`)
- **Pattern**: async jobs avec polling
- **Workflow**: `POST /jobs` (multipart upload) → poll `GET /jobs/{id}` → `GET /jobs/{id}/output` (stream download) → `DELETE /jobs/{id}` (cleanup)
- **Limites**: 12 GB upload max, 7200s (2h) timeout, 3 jobs concurrent serveur (queue FIFO au-dela)
- **Performance**: ~100x realtime pour 480p H.264 NVENC (sur des sources de 60s+)
- **⚡ Recommandation concurrence**: **PARALLEL=2-4 cote client en HTTP/1.1** (pas HTTP/2).
  HTTP/2 multiplexing + window flow control 64 KB cap le throughput upload a ~55 Mbps/stream.
  HTTP/1.1 avec connexions distinctes utilise 4 cores TLS Pi en parallele (~175-250 Mbps/stream).
  Si curl: ajouter `--http1.1`. Si Node `fetch` natif (>= 18): HTTP/1.1 par defaut OK.

## 1. Authentification

Le service utilise **HTTP Basic Auth** (RFC 7617). Pas d'API key, pas d'OAuth, pas de JWT.
Le credential est un couple **user/password** stocke cote serveur dans
`/etc/nginx/.htpasswd-transcode`. Ce credential vous est transmis hors-bande.

**Stockage du secret cote client** : variable d'environnement `TRANSCODE_API_AUTH`
au format `user:password`. **JAMAIS commit dans un repo**. Pour un agent qui
genere du code TypeScript, lire depuis `process.env.TRANSCODE_API_AUTH` ou un
fichier `.env` non versionne.

```typescript
const auth = process.env.TRANSCODE_API_AUTH
if (!auth) throw new Error('TRANSCODE_API_AUTH env var required (format: user:password)')
const authHeader = 'Basic ' + Buffer.from(auth).toString('base64')
// → "Basic dHJhbnNjb2RlOk1vbm1vdGRlcGFzc2U="
```

**Tous les endpoints requierent l'auth sauf `/waker/health`** (healthcheck public
pour monitoring externe type Prometheus blackbox).

## 2. Endpoints — Quick Reference

| Method | Path | Auth | Body | Purpose |
|---|---|---|---|---|
| GET | `/` | yes | none | Service descriptor (version, endpoints list) |
| GET | `/health` | yes | none | Liveness check |
| GET | `/codecs` | yes | none | List NVENC encoders + supported params |
| GET | `/waker/health` | **no** | none | Public health (monitoring) |
| GET | `/waker/status` | yes | none | Container state, idle minutes |
| **POST** | **`/jobs`** | yes | multipart | **Create transcode job (upload + start)** |
| GET | `/jobs` | yes | none | List all jobs (sorted recent first) |
| GET | `/jobs/{id}` | yes | none | Get job state + progress |
| GET | `/jobs/{id}/output` | yes | none | Stream download transcoded file |
| DELETE | `/jobs/{id}` | yes | none | Kill job + delete files |

## 3. TypeScript Types (copy-paste ready)

```typescript
/** All types in transcode-service API responses. */

export type TargetCodec = 'h264_nvenc' | 'hevc_nvenc' | 'av1_nvenc'
export type JobStatus = 'queued' | 'running' | 'done' | 'failed'
export type AudioMode = 'auto' | 'copy' | 'aac'
export type NvencPreset = 'p1' | 'p2' | 'p3' | 'p4' | 'p5' | 'p6' | 'p7'
//   p1 = fastest (lowest quality), p7 = slowest (highest quality)

export interface JobInput {
  filename: string
  sizeBytes: number
  codec?: string           // ex: 'hevc', 'h264', 'vp9'
  height?: number          // ex: 1080
  width?: number           // ex: 1920
  audioCodec?: string      // ex: 'aac', 'opus', 'mp3'
  durationSeconds?: number // ex: 600 (10 minutes)
}

export interface JobParams {
  targetCodec: TargetCodec
  targetHeight: number       // 0 = keep source, else 480/720/1080/etc.
  preset: NvencPreset
  cq: number                 // 0..51 Constant Quality (used if targetBitrate absent)
  targetBitrate?: string     // ex: '1500k', '2M' — takes precedence over cq
  audioMode: AudioMode       // auto = copy if AAC, else encode to aac
  audioBitrate: string       // ex: '128k'
  audioStream: string        // 'auto' or numeric index ('0', '1')
}

export interface JobProgress {
  percent: number            // 0..100
  outTimeSeconds: number     // seconds of output produced
  fps: number                // current encoding fps
  speed: string              // ex: '41.9x', '0.5x'
  frame: number              // current frame
}

export interface JobOutput {
  path: string               // server-side path (internal)
  sizeBytes: number
  ready: boolean
}

export interface Job {
  id: string                 // UUID v4
  status: JobStatus
  createdAt: number          // epoch ms
  startedAt?: number         // epoch ms (set when status -> 'running')
  finishedAt?: number        // epoch ms (set when status -> 'done' | 'failed')
  input: JobInput
  inputPath: string          // server-side path
  params: JobParams
  output?: JobOutput
  progress: JobProgress
  error?: string             // populated if status === 'failed'
}

export interface JobsList {
  count: number
  jobs: Job[]
}

export interface CodecsInfo {
  ffmpeg_ok: boolean
  nvenc_encoders: string[]              // ex: ['V....D h264_nvenc NVIDIA NVENC H.264 encoder (codec h264)']
  supported_target_codecs: TargetCodec[]
  supported_presets: NvencPreset[]
  supported_audio_modes: AudioMode[]
  supported_target_heights: number[]
}

export interface ApiError {
  error: string              // machine-readable code, ex: 'invalid_target_codec'
  detail?: string
  allowed?: unknown          // valid values for invalid_* errors
  got?: unknown
}
```

## 4. POST /jobs — Detailed Spec

**Request**: `multipart/form-data` (use `FormData` in browser/Node 18+/Bun).

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| `file` | binary | **yes** | — | The input video file (any format ffmpeg can read) |
| `target_codec` | string | no | `h264_nvenc` | Must be in `supported_target_codecs` |
| `target_height` | int | no | `720` | `0` = no rescale. Common: 480, 720, 1080 |
| `preset` | string | no | `p4` | NVENC preset `p1`..`p7`. **Use `p1` for speed** |
| `cq` | int | no | `23` | Constant Quality 0..51. **Ignored if `target_bitrate` set** |
| `target_bitrate` | string | no | (none) | Bitrate target (ex `1500k`, `2M`). **Use this for predictable size + speed** |
| `audio_mode` | string | no | `auto` | `auto`=copy if AAC else encode, `copy`=always copy, `aac`=always encode |
| `audio_bitrate` | string | no | `128k` | Used only if audio is encoded |
| `audio_stream` | string | no | `auto` | `auto` = first stream, or numeric index |

**Response 201 Created**: full `Job` object (status will be `running` or `queued`).

**Response 400 Bad Request** (validation error): `ApiError`. Possible `error` codes:
- `missing_file`, `invalid_multipart`
- `invalid_target_codec`, `invalid_preset`, `invalid_audio_mode`
- `invalid_target_height`, `invalid_cq`, `invalid_target_bitrate`

**Response 500**: `job_creation_failed` — generally ffprobe could not read the file.

### Choosing rate control: `cq` vs `target_bitrate`

| Use case | Recommended | Why |
|---|---|---|
| **Speed-first** (batch transcoding, ~50-100x realtime) | `target_bitrate` + `preset=p1` | Predictable size, NVENC optimized for CBR |
| **Quality-first** (archive, master copies) | `cq` (no bitrate) + `preset=p4..p6` | Adaptive bitrate, better quality per byte |
| **Streaming/live** | `target_bitrate` + `preset=p1` | Predictable network usage |

### Common content types & recommended params

| Content type | Source typique | `target_height` | `target_bitrate` | Notes |
|---|---|---|---|---|
| **Series TV vintage PAL** (Mariés deux enfants, Friends, etc.) | HEVC/MPEG2 720×576 | `576` (keep) or `480` (smaller) | `1000k` (576p) / `800k` (480p) | PAL source typique ~576p |
| **Series TV NTSC** | 720×480 | `480` (keep) | `800k` | NTSC = 480p natif |
| **Series TV HD** | 1280×720 / 1920×1080 HEVC | `720` | `2500k` | Streaming-friendly |
| **Films modernes 1080p** | 1920×1080 HEVC/AV1 | `1080` (keep) | `4000k` | Quality > size |
| **Anime 480p/576p** | Variable | `480` | `1200k` (motion forte) | Anime: motion + lines, bitrate plus eleve qu'attendu |
| **YouTube ingest** | Variable | `720` ou `1080` | `2500k` / `4000k` | Bitrate haut pour pas perdre en compression YouTube |
| **Archive long terme** | Master HD | `0` (no rescale) | (omit) + `cq=20` + `preset=p5` | Quality target, taille adaptative |

**Note sur le 576p (PAL)** : si ta source est déjà 576p, `target_height=576` ne fait **aucun rescale**
(le code skip le filter scale_cuda si `input.height <= target_height`) → encode pur NVENC, vitesse max.
Pour downscaler 576p → 480p, mettre `target_height=480` (le code applique `scale_cuda=-2:480`).

## 5. GET /jobs/{id} — Polling Spec

Poll every **2-5 seconds** until `status === 'done' || status === 'failed'`.
Server-side jobs are tracked with `setInterval` 1 Hz for progress, so polling
faster than 1 Hz gives no extra precision.

**Status transitions**:
```
queued → running → done
                 ↘ failed
```

**Error recovery**: if `status === 'failed'`, inspect `job.error` (string). Typical
errors: `ffmpeg exit code 234\n[lrc @ ...] Format lrc detected only with low score...`
→ usually means invalid/corrupt input.

## 6. GET /jobs/{id}/output — Download

**Pre-condition**: `job.status === 'done'` AND `job.output.ready === true`.

**Response 200**: `Content-Type: video/mp4`, body is the stream of the transcoded
file. `Content-Length` and `Content-Disposition: attachment; filename="..."`
are set.

**Response 409 Conflict**: if called before `done` → `{error: 'output_not_ready', status, progress}`.

**Response 404 Not Found**: job doesn't exist (was deleted, expired, or never created).

**Streaming**: download is streamed in chunks. Use `Response.body` (a `ReadableStream`)
or fetch-into-file pattern, do not buffer the whole response in memory.

## 7. Complete TypeScript Client (copy-paste ready)

```typescript
import { writeFile } from 'node:fs/promises'

export interface ClientConfig {
  baseUrl?: string
  /** Format 'user:password' */
  auth: string
  /** Poll interval in milliseconds (default 2000) */
  pollIntervalMs?: number
  /** Max total wait for a job in milliseconds (default 7200000 = 2h) */
  maxWaitMs?: number
}

export class TranscodeApiClient {
  private readonly baseUrl: string
  private readonly authHeader: string
  private readonly pollIntervalMs: number
  private readonly maxWaitMs: number

  constructor(cfg: ClientConfig) {
    this.baseUrl = (cfg.baseUrl ?? 'https://transcode.agi-so.fr').replace(/\/$/, '')
    this.authHeader = 'Basic ' + Buffer.from(cfg.auth).toString('base64')
    this.pollIntervalMs = cfg.pollIntervalMs ?? 2000
    this.maxWaitMs = cfg.maxWaitMs ?? 7200000
  }

  private async req<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(this.baseUrl + path, {
      ...init,
      headers: { ...init?.headers, Authorization: this.authHeader },
    })
    if (!res.ok) {
      let err: unknown
      try { err = await res.json() } catch { err = await res.text() }
      throw new Error(`${init?.method ?? 'GET'} ${path} -> ${res.status}: ${JSON.stringify(err)}`)
    }
    return res.json() as Promise<T>
  }

  async health(): Promise<{ status: string; version: string }> {
    return this.req('/health')
  }

  async codecs(): Promise<CodecsInfo> {
    return this.req('/codecs')
  }

  async createJob(opts: {
    file: Blob | File          // pass a Blob (Node 18+/Bun: import { readFile } -> new Blob([buf]))
    filename?: string
    params?: Partial<JobParams>
  }): Promise<Job> {
    const form = new FormData()
    const filename = opts.filename
      ?? (opts.file instanceof File ? opts.file.name : 'input.bin')
    form.append('file', opts.file, filename)
    const p = opts.params ?? {}
    if (p.targetCodec)   form.append('target_codec',   p.targetCodec)
    if (p.targetHeight !== undefined) form.append('target_height', String(p.targetHeight))
    if (p.preset)        form.append('preset',         p.preset)
    if (p.cq !== undefined)            form.append('cq',           String(p.cq))
    if (p.targetBitrate) form.append('target_bitrate', p.targetBitrate)
    if (p.audioMode)     form.append('audio_mode',     p.audioMode)
    if (p.audioBitrate)  form.append('audio_bitrate',  p.audioBitrate)
    if (p.audioStream)   form.append('audio_stream',   p.audioStream)

    return this.req('/jobs', { method: 'POST', body: form })
  }

  async getJob(id: string): Promise<Job> {
    return this.req(`/jobs/${id}`)
  }

  async listJobs(): Promise<JobsList> {
    return this.req('/jobs')
  }

  async deleteJob(id: string): Promise<{ deleted: boolean; job_id: string }> {
    return this.req(`/jobs/${id}`, { method: 'DELETE' })
  }

  /** Polls until status is terminal. Throws on timeout or failure. */
  async waitForJob(id: string, onProgress?: (job: Job) => void): Promise<Job> {
    const start = Date.now()
    while (true) {
      if (Date.now() - start > this.maxWaitMs) {
        throw new Error(`Timeout waiting for job ${id} (>${this.maxWaitMs}ms)`)
      }
      const job = await this.getJob(id)
      onProgress?.(job)
      if (job.status === 'done') return job
      if (job.status === 'failed') {
        throw new Error(`Job ${id} failed: ${job.error ?? 'unknown'}`)
      }
      await new Promise((r) => setTimeout(r, this.pollIntervalMs))
    }
  }

  /** Downloads output to a local file (Node/Bun). Returns bytes written. */
  async downloadOutput(id: string, destPath: string): Promise<number> {
    const res = await fetch(`${this.baseUrl}/jobs/${id}/output`, {
      headers: { Authorization: this.authHeader },
    })
    if (!res.ok) {
      throw new Error(`Download ${id} -> ${res.status}: ${await res.text()}`)
    }
    const buf = new Uint8Array(await res.arrayBuffer())
    await writeFile(destPath, buf)
    return buf.byteLength
  }

  /** End-to-end helper: upload + wait + download + delete. */
  async transcode(opts: {
    file: Blob | File
    filename?: string
    outputPath: string
    params?: Partial<JobParams>
    onProgress?: (job: Job) => void
  }): Promise<{ job: Job; bytesWritten: number }> {
    const created = await this.createJob(opts)
    const finished = await this.waitForJob(created.id, opts.onProgress)
    const bytesWritten = await this.downloadOutput(finished.id, opts.outputPath)
    await this.deleteJob(finished.id)
    return { job: finished, bytesWritten }
  }
}
```

## 8. Usage Examples

### Node.js / Bun — minimal

```typescript
import { readFile } from 'node:fs/promises'

const client = new TranscodeApiClient({ auth: process.env.TRANSCODE_API_AUTH! })

const inputBuf = await readFile('./input.mkv')
const file = new Blob([inputBuf])

const { job, bytesWritten } = await client.transcode({
  file,
  filename: 'input.mkv',
  outputPath: './output.mp4',
  params: {
    targetCodec: 'h264_nvenc',
    targetHeight: 720,
    preset: 'p1',
    targetBitrate: '2000k',
    audioMode: 'auto',
  },
  onProgress: (j) => console.log(`${j.status} ${j.progress.percent}% fps=${j.progress.fps} speed=${j.progress.speed}`),
})

console.log(`Done: ${bytesWritten} bytes in output (job took ${(job.finishedAt! - job.startedAt!) / 1000}s)`)
```

### Browser — using DOM File from `<input type="file">`

```typescript
const input = document.querySelector<HTMLInputElement>('#file-input')!
const file = input.files![0]

const client = new TranscodeApiClient({ auth: 'transcode:xxx' })
const job = await client.createJob({ file, params: { targetHeight: 480, preset: 'p1', targetBitrate: '1500k' } })
console.log('Job created:', job.id)

const finished = await client.waitForJob(job.id, (j) => {
  document.querySelector('#progress')!.textContent = `${j.progress.percent}% (${j.progress.speed})`
})

// Download via the API URL directly (browser handles the stream)
window.open(`https://transcode.agi-so.fr/jobs/${finished.id}/output`)
// (Browser will need to handle the Basic Auth — typically prompt the user)
```

### Batch parallele (RECOMMANDE pour exploiter la bande passante)

**Pourquoi**: le serveur traite **1 job ffmpeg a la fois** (NVENC bloc unique cote GPU), mais
le **reverse proxy nginx** peut absorber **plusieurs uploads/downloads HTTP en parallele** grace
a ses 4 workers TLS. Si vous uploadez **2-3 fichiers en parallele**, vous saturez votre lien
upload (~1 Gbps fibre) au lieu d'etre limite a ~460 Mbps single-stream.

Cote serveur, les jobs au-dela du 1er sont queues FIFO (status `queued`), et traites des que
le precedent termine. Pendant qu'un job transcode, les autres uploadent — c'est exactement
ce qu'on veut: paralleliser **transferts** + **transcode**.

```typescript
/** Util: pool de promesses avec concurrence limitee. */
async function withConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (cursor < items.length) {
        const i = cursor++
        results[i] = await fn(items[i], i)
      }
    }),
  )
  return results
}

/** Exemple: transcode batch de 285 episodes avec PARALLEL=2. */
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

async function transcodeBatch(inputs: string[], outDir: string) {
  const client = new TranscodeApiClient({ auth: process.env.TRANSCODE_API_AUTH! })

  await withConcurrency(inputs, 2 /* PARALLEL — recommande pour exploiter ~1 Gbps */, async (input, i) => {
    const out = join(outDir, basename(input).replace(/\.[^.]+$/, '.mp4'))
    const buf = await readFile(input)
    const { bytesWritten } = await client.transcode({
      file: new Blob([buf]),
      filename: basename(input),
      outputPath: out,
      params: {
        targetCodec: 'h264_nvenc',
        targetHeight: 480,
        preset: 'p1',
        targetBitrate: '1500k',
        audioMode: 'auto',
      },
      onProgress: (j) => {
        if (j.progress.percent % 10 === 0) {
          console.log(`[${i + 1}/${inputs.length}] ${basename(input)}: ${j.progress.percent}% ${j.progress.speed}`)
        }
      },
    })
    console.log(`[${i + 1}/${inputs.length}] OK ${out} (${bytesWritten} bytes)`)
  })
}
```

**Note sur PARALLEL=3+**: au-dela de 2, vous risquez de saturer le TLS Pi (~1200 Mbps cumul
4 workers). PARALLEL=3 peut donner un leger gain si votre fibre est tres rapide (>1.5 Gbps),
au-dela ca devient contre-productif (timeouts, retries). **Default sain: PARALLEL=2.**

### Bash equivalent (for reference)

```bash
# 1. Upload + start
JOB_ID=$(curl -sS -u "$TRANSCODE_API_AUTH" \
    -X POST \
    -F "file=@input.mkv" \
    -F "target_codec=h264_nvenc" \
    -F "target_height=720" \
    -F "preset=p1" \
    -F "target_bitrate=2000k" \
    https://transcode.agi-so.fr/jobs | jq -r .id)

# 2. Poll
while true; do
    STATUS=$(curl -sS -u "$TRANSCODE_API_AUTH" \
        https://transcode.agi-so.fr/jobs/$JOB_ID | jq -r .status)
    [[ "$STATUS" == "done" ]] && break
    [[ "$STATUS" == "failed" ]] && { echo "FAILED"; exit 1; }
    sleep 2
done

# 3. Download + cleanup
curl -sS -u "$TRANSCODE_API_AUTH" -o output.mp4 https://transcode.agi-so.fr/jobs/$JOB_ID/output
curl -sS -u "$TRANSCODE_API_AUTH" -X DELETE https://transcode.agi-so.fr/jobs/$JOB_ID
```

## 9. Error Handling

### HTTP status codes

| Code | Meaning | Retry? |
|---|---|---|
| `201 Created` | Job created | — |
| `200 OK` | Read success | — |
| `400 Bad Request` | Validation error (see `ApiError.error`) | **No** — fix request |
| `401 Unauthorized` | Bad Basic Auth credentials | **No** — fix auth |
| `404 Not Found` | Job doesn't exist or expired | **No** |
| `409 Conflict` | Output not ready yet (poll instead) | Wait & poll |
| `413 Payload Too Large` | File > 12 GB | **No** — split source |
| `429 Too Many Requests` | nginx rate limit (600/min/IP = 10/sec sustain, burst 50) | **Yes** with backoff |
| `500 Internal Server Error` | Server fault (ffprobe failed, etc.) | Maybe — check response body |
| `502 Bad Gateway` | nginx → backend down (waker cold-starting?) | **Yes** with 2-10s backoff |
| `503 Service Unavailable` | Backend unhealthy | **Yes** with 5-30s backoff |

### Cold-start behavior

The container scales to zero after 30 min idle. The **first request after a
cold period** will trigger a `docker compose up -d` cycle on the host
(~700-1000 ms). The waker proxies the request transparently, so you don't need
to do anything special — just expect the first call after idle to be ~1s slower.

If you see `502/503` on the first call, retry **once** with a 2s delay.

### Recommended retry strategy

```typescript
async function withRetry<T>(fn: () => Promise<T>, opts = { tries: 3, baseMs: 1000 }): Promise<T> {
  let lastErr: unknown
  for (let i = 0; i < opts.tries; i++) {
    try { return await fn() } catch (e) {
      lastErr = e
      const msg = e instanceof Error ? e.message : String(e)
      // Don't retry on 4xx (except 429)
      if (/-> 4(0[01]|04|13)\b/.test(msg)) throw e
      await new Promise((r) => setTimeout(r, opts.baseMs * Math.pow(2, i)))
    }
  }
  throw lastErr
}
```

## 10. Performance Reference (measured 2026-05-24)

| Source | Target | Params | transcode_time | Speedup |
|---|---|---|---|---|
| 10s HEVC 1080p | H.264 720p | p4, cq 23 | 3.87 s | **2.5x realtime** |
| 10s HEVC 1080p | H.264 720p | p1, bitrate 2000k | 0.85 s | **11.8x** |
| 10s HEVC 576p | H.264 480p | p1, bitrate 1500k | 0.60 s | **16.6x** |
| 60s HEVC 576p | H.264 480p | p1, bitrate 1500k | 0.85 s | **70.4x** |
| **120s HEVC 576p** | **H.264 480p** | **p1, bitrate 1500k** | **1.10 s** | **109x** |

**Key insight**: `preset=p1` + `target_bitrate` is **4-5x faster** than the
default `preset=p4` + `cq`. Use it for batch jobs unless quality is critical.

**Network limits** (mesured on the deployed infra):
- TLS termination Pi 4 (nginx) **single-stream**: **~460 Mbps** (single core)
- TLS termination Pi 4 (nginx) **cumul 4 workers**: **~1200-1500 Mbps**
- WAN Freebox upload: 866 Mbps (mesure), capacite brute ~600-2500 Mbps selon offre
- LAN gigabit Pi↔Spark: 943 Mbps wire speed
- WAN Freebox download (cote client): voir votre propre fibre

**For a 4 GB upload**:
- Single-stream (PARALLEL=1): ~71 s (limite TLS Pi)
- **Multi-stream PARALLEL=2: ~35-40 s** (effectif ~860-1000 Mbps)
- PARALLEL=3: ~30 s (gain marginal, ne pas depasser sauf fibre > 1.5 Gbps)

### ⚡ Best practice: PARALLEL=2 par defaut, PARALLEL=4 OK sur fibre 1 Gbps

Mesure 2026-05-24: 4 streams x 250 MiB en parallele → 4/4 OK, **626 Mbps cumule**.

**Pour tout batch de plus de 2 fichiers**, lancez **2 uploads HTTP en parallele** (cote client).
Cela exploite les **4 workers TLS du Pi nginx** au lieu d'etre limite a un seul. Le serveur
gere la queue cote ffmpeg (1 job actif a la fois sur NVENC), donc les fichiers au-dela du 1er
sont uploads et stockes pendant que le 1er transcode → **vous masquez la latence reseau
derriere le compute**. Voir code TypeScript section 8 (`transcodeBatch` + `withConcurrency`).

**PARALLEL=4 OK sur fibre 1 Gbps** (mesure: 4/4 streams 250 MiB, 626 Mbps cumule).
Cold-start (>30 min idle) peut donner 1 503 sur le 1er essai, retry suffit.

## 11. Security Notes for Agents

- **Never log the Basic Auth credentials** (the password is a real secret).
- **Never commit `.env`** with `TRANSCODE_API_AUTH` to a repo.
- **Use `process.env.TRANSCODE_API_AUTH`** in code, document the var in `.env.example`
  with a placeholder like `transcode:CHANGEME`.
- **Rotate the password** by asking the operator to regenerate via
  `sudo htpasswd /etc/nginx/.htpasswd-transcode transcode` on the nginx host.
- **TLS verification**: the cert is issued by Let's Encrypt. Do not disable TLS
  verification in your client (no `rejectUnauthorized: false`). If you must
  pin the cert: it's `CN=transcode.agi-so.fr`, issuer `Let's Encrypt E7`.

## 12. Reference: Server-Side Source

If you need to inspect or modify the server behavior:

- **Service code**: `app/src/main.ts` (Hono routes), `app/src/jobs.ts` (ffmpeg lifecycle)
- **Container**: `docker/Dockerfile` (multi-stage build, ffmpeg compiled with NVENC)
- **Reverse proxy**: `nginx/transcode.agi-so.fr.conf`
- **Waker scale-to-zero**: `waker/src/main.ts` + `waker/transcode-waker.service`
- **Repo origin**: `~/projetsperso/transcode-service/` (Mac), rsynced to Spark A
- **Operator host**: `pablo@192.168.1.31` (Spark A), `pablito@192.168.1.60` (nginx)

## 13. Versioning

Service version is exposed at `GET /` and `GET /health` (`version` field).
Current: `0.2.0` (jobs API). No version negotiation header — assume backward
compatible additions, breaking changes will bump major.

---

**Last verified**: 2026-05-24 — `GET /codecs` returns `[av1_nvenc, h264_nvenc, hevc_nvenc]`,
`POST /jobs` accepts 12 GB max body, `MAX_CONCURRENT_JOBS=1` confirmed.
