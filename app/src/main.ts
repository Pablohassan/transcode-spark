/**
 * transcode-service — Hono+Bun app dans le container Docker.
 * Expose:
 *   GET  /             descripteur
 *   GET  /health       healthcheck (waker + Docker HEALTHCHECK)
 *   GET  /codecs       liste NVENC encoders (introspection ffmpeg)
 *   POST /jobs         upload + lance transcode -> {job_id, status, input, params}
 *   GET  /jobs         liste jobs (queued/running/done/failed)
 *   GET  /jobs/{id}    status + progress d'un job
 *   GET  /jobs/{id}/output  streaming download du fichier transcode
 *   DELETE /jobs/{id}  cleanup (kill ffmpeg, delete files)
 */
import { Hono } from 'hono'
import { logger } from 'hono/logger'
import {
  createJob,
  deleteJob,
  getJob,
  listJobs,
  exportJobForApi,
  config,
  type TargetCodec,
  type JobParams,
} from './jobs.ts'

const VERSION = '0.2.0'
const app = new Hono()
app.use('*', logger())

const VALID_CODECS: TargetCodec[] = ['h264_nvenc', 'hevc_nvenc', 'av1_nvenc']
const VALID_PRESETS = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']
const VALID_AUDIO_MODES = ['auto', 'copy', 'aac']

// -----------------------------------------------------------------------------
// Endpoints simples (health, codecs, racine)
// -----------------------------------------------------------------------------

app.get('/', (c) =>
  c.json({
    service: 'transcode-service',
    version: VERSION,
    description: 'ffmpeg + NVENC transcode API (h264/hevc/av1)',
    endpoints: [
      'GET    /health',
      'GET    /codecs',
      'POST   /jobs',
      'GET    /jobs',
      'GET    /jobs/{id}',
      'GET    /jobs/{id}/output',
      'DELETE /jobs/{id}',
    ],
    config: {
      max_concurrent_jobs: config.MAX_CONCURRENT_JOBS,
      job_ttl_minutes: config.JOB_TTL_MINUTES,
    },
  }),
)

app.get('/health', (c) =>
  c.json({
    status: 'ok',
    version: VERSION,
    runtime: 'bun',
    framework: 'hono',
  }),
)

app.get('/codecs', async (c) => {
  try {
    const proc = Bun.spawn(['ffmpeg', '-hide_banner', '-encoders'], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const stdout = await new Response(proc.stdout).text()
    await proc.exited
    const nvencEncoders = stdout
      .split('\n')
      .filter((l) => l.toLowerCase().includes('nvenc'))
      .map((l) => l.trim())
    return c.json({
      ffmpeg_ok: proc.exitCode === 0,
      nvenc_encoders: nvencEncoders,
      supported_target_codecs: VALID_CODECS,
      supported_presets: VALID_PRESETS,
      supported_audio_modes: VALID_AUDIO_MODES,
      supported_target_heights: [0, 480, 720, 1080, 1440, 2160],
    })
  } catch (err) {
    return c.json(
      {
        error: 'ffmpeg execution failed',
        detail: err instanceof Error ? err.message : String(err),
      },
      500,
    )
  }
})

// -----------------------------------------------------------------------------
// Jobs API
// -----------------------------------------------------------------------------

/**
 * POST /jobs  multipart upload:
 *   file               required, la video
 *   target_codec       h264_nvenc | hevc_nvenc | av1_nvenc       (defaut: h264_nvenc)
 *   target_height      0|480|720|1080|...                        (defaut: 720, 0=source)
 *   preset             p1..p7                                     (defaut: p4)
 *   cq                 0..51 NVENC constant quality              (defaut: 23)
 *   target_bitrate     bitrate cible (ex: '1500k', '2M')         (optionnel, prend le pas sur cq si fourni)
 *   audio_mode         auto|copy|aac                              (defaut: auto)
 *   audio_bitrate      ex: 128k                                   (defaut: 128k)
 *   audio_stream       'auto' ou index numerique                  (defaut: auto)
 */
app.post('/jobs', async (c) => {
  let formData: FormData
  try {
    formData = await c.req.formData()
  } catch (err) {
    return c.json({ error: 'invalid_multipart', detail: String(err) }, 400)
  }

  const file = formData.get('file')
  if (!(file instanceof File) || file.size === 0) {
    return c.json({ error: 'missing_file', detail: 'multipart field "file" required' }, 400)
  }

  // Parse params
  const targetCodec = (formData.get('target_codec') as string | null) ?? 'h264_nvenc'
  const targetHeightRaw = (formData.get('target_height') as string | null) ?? '720'
  const preset = (formData.get('preset') as string | null) ?? 'p4'
  const cqRaw = (formData.get('cq') as string | null) ?? '23'
  const targetBitrate = (formData.get('target_bitrate') as string | null) || undefined
  const audioMode = (formData.get('audio_mode') as string | null) ?? 'auto'
  const audioBitrate = (formData.get('audio_bitrate') as string | null) ?? '128k'
  const audioStream = (formData.get('audio_stream') as string | null) ?? 'auto'

  // Validation
  if (!VALID_CODECS.includes(targetCodec as TargetCodec)) {
    return c.json(
      { error: 'invalid_target_codec', allowed: VALID_CODECS, got: targetCodec },
      400,
    )
  }
  if (!VALID_PRESETS.includes(preset)) {
    return c.json(
      { error: 'invalid_preset', allowed: VALID_PRESETS, got: preset },
      400,
    )
  }
  if (!VALID_AUDIO_MODES.includes(audioMode)) {
    return c.json(
      { error: 'invalid_audio_mode', allowed: VALID_AUDIO_MODES, got: audioMode },
      400,
    )
  }
  const targetHeight = Number(targetHeightRaw)
  if (!Number.isFinite(targetHeight) || targetHeight < 0) {
    return c.json({ error: 'invalid_target_height', got: targetHeightRaw }, 400)
  }
  const cq = Number(cqRaw)
  if (!Number.isInteger(cq) || cq < 0 || cq > 51) {
    return c.json({ error: 'invalid_cq', allowed: '0..51', got: cqRaw }, 400)
  }
  if (targetBitrate && !/^\d+[kKmM]?$/.test(targetBitrate)) {
    return c.json({ error: 'invalid_target_bitrate', allowed: 'ex: 1500k, 2M, 8000000', got: targetBitrate }, 400)
  }

  const params: JobParams = {
    targetCodec: targetCodec as TargetCodec,
    targetHeight,
    preset,
    cq,
    targetBitrate,
    audioMode: audioMode as JobParams['audioMode'],
    audioBitrate,
    audioStream,
  }

  try {
    const job = await createJob({ file, params })
    return c.json(exportJobForApi(job), 201)
  } catch (err) {
    return c.json(
      { error: 'job_creation_failed', detail: err instanceof Error ? err.message : String(err) },
      500,
    )
  }
})

app.get('/jobs', (c) => {
  return c.json({
    count: listJobs().length,
    jobs: listJobs().map(exportJobForApi),
  })
})

app.get('/jobs/:id', (c) => {
  const id = c.req.param('id')
  const job = getJob(id)
  if (!job) return c.json({ error: 'not_found', job_id: id }, 404)
  return c.json(exportJobForApi(job))
})

app.get('/jobs/:id/output', async (c) => {
  const id = c.req.param('id')
  const job = getJob(id)
  if (!job) return c.json({ error: 'not_found', job_id: id }, 404)
  if (job.status !== 'done' || !job.output?.ready) {
    return c.json(
      {
        error: 'output_not_ready',
        status: job.status,
        progress: job.progress,
      },
      409,
    )
  }
  const fileBun = Bun.file(job.output.path)
  if (!(await fileBun.exists())) {
    return c.json({ error: 'output_file_missing', path: job.output.path }, 500)
  }

  // Streaming download (le browser/client telecharge le fichier)
  const downloadName = job.input.filename.replace(/\.[^.]+$/, '') + '.mp4'
  return new Response(fileBun.stream(), {
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Length': String(job.output.sizeBytes),
      'Content-Disposition': `attachment; filename="${downloadName}"`,
      'Cache-Control': 'no-store',
    },
  })
})

app.delete('/jobs/:id', async (c) => {
  const id = c.req.param('id')
  const ok = await deleteJob(id)
  if (!ok) return c.json({ error: 'not_found', job_id: id }, 404)
  return c.json({ deleted: true, job_id: id })
})

// -----------------------------------------------------------------------------
// Server
// -----------------------------------------------------------------------------

export default {
  port: 8001,
  fetch: app.fetch,
  // Disable Bun idle timeout for long uploads/downloads
  idleTimeout: 0,
  // 8 GB max body (mirror nginx config)
  maxRequestBodySize: 8 * 1024 * 1024 * 1024,
}

console.log(`[transcode-service v${VERSION}] listening on :8001 (Bun ${Bun.version})`)
console.log(`  max concurrent jobs: ${config.MAX_CONCURRENT_JOBS}`)
console.log(`  job ttl (minutes):   ${config.JOB_TTL_MINUTES}`)
console.log(`  data dir:            ${config.DATA_DIR}`)
