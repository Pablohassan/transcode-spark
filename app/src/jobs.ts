/**
 * Jobs lifecycle: state in-memory + spawn ffmpeg + progress tracking + queue.
 *
 * Pattern: async jobs avec polling (cf. reencode-tui.sh qui lance N transcodes en parallele
 * et doit pouvoir tracker chacun individuellement).
 *
 * State stocke en RAM (Map). Acceptable car:
 *   - le scale-to-zero stoppera le container apres 30 min d'idle (waker)
 *   - les fichiers /data/{incoming,output}/ persistent sur le volume Docker
 *   - au re-wake, le state est neuf - les vieux jobs disparaissent (acceptable pour notre cas,
 *     les clients sont supposes finir leurs polls dans une session active)
 * Pour persistance vraie (jobs qui survivent les restarts): basculer vers Bun.SQLite ou Redis.
 */
import { spawn, type Subprocess } from 'bun'
import { randomUUID } from 'node:crypto'
import { mkdir, unlink, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'

export type JobStatus = 'queued' | 'running' | 'done' | 'failed'

export type TargetCodec = 'h264_nvenc' | 'hevc_nvenc' | 'av1_nvenc'

export interface JobInput {
  filename: string
  sizeBytes: number
  codec?: string
  height?: number
  width?: number
  audioCodec?: string
  durationSeconds?: number
}

export interface JobParams {
  targetCodec: TargetCodec
  targetHeight: number // 0 = no rescale
  preset: string       // p1..p7
  /** Constant Quality (utilise si targetBitrate non fourni). 0..51, ~equivalent CRF libx264. */
  cq: number
  /** Bitrate cible alternatif au cq (ex: '1500k', '2M'). Prend le pas sur cq si defini. */
  targetBitrate?: string
  audioMode: 'auto' | 'copy' | 'aac'
  audioBitrate: string
  audioStream: string  // 'auto' or numeric index
}

export interface JobProgress {
  percent: number
  outTimeSeconds: number
  fps: number
  speed: string
  frame: number
}

export interface JobOutput {
  path: string
  sizeBytes: number
  ready: boolean
}

export interface Job {
  id: string
  status: JobStatus
  createdAt: number
  startedAt?: number
  finishedAt?: number
  input: JobInput
  inputPath: string
  params: JobParams
  output?: JobOutput
  progress: JobProgress
  error?: string
  proc?: Subprocess
}

const DATA_DIR = process.env.DATA_DIR ?? '/data'
const MAX_CONCURRENT_JOBS = Number(process.env.MAX_CONCURRENT_JOBS ?? '4')
const JOB_TTL_MINUTES = Number(process.env.JOB_TTL_MINUTES ?? '60')

const incomingDir = `${DATA_DIR}/incoming`
const outputDir = `${DATA_DIR}/output`

await mkdir(incomingDir, { recursive: true }).catch(() => {})
await mkdir(outputDir, { recursive: true }).catch(() => {})

const jobs = new Map<string, Job>()

export function listJobs(): Job[] {
  return [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt)
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id)
}

export function countRunning(): number {
  let n = 0
  for (const j of jobs.values()) if (j.status === 'running') n++
  return n
}

/**
 * Probe input file via ffprobe. Renvoie codec, dimensions, duree, audio codec.
 */
export async function probeInput(filepath: string): Promise<Partial<JobInput>> {
  const proc = spawn(
    [
      'ffprobe',
      '-v', 'error',
      '-show_entries', 'stream=codec_name,codec_type,height,width:format=duration',
      '-of', 'json',
      filepath,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  const out = await new Response(proc.stdout).text()
  await proc.exited
  if (proc.exitCode !== 0) {
    throw new Error(`ffprobe failed: ${await new Response(proc.stderr).text()}`)
  }
  try {
    const data = JSON.parse(out) as {
      streams?: Array<{
        codec_name: string
        codec_type: 'video' | 'audio'
        height?: number
        width?: number
      }>
      format?: { duration?: string }
    }
    const video = data.streams?.find((s) => s.codec_type === 'video')
    const audio = data.streams?.find((s) => s.codec_type === 'audio')
    return {
      codec: video?.codec_name,
      height: video?.height,
      width: video?.width,
      audioCodec: audio?.codec_name,
      durationSeconds: data.format?.duration ? Math.floor(Number(data.format.duration)) : undefined,
    }
  } catch (err) {
    throw new Error(`ffprobe parse error: ${err}`)
  }
}

/**
 * Build ffmpeg args from job params.
 * Aligne sur la logique de reencode-tui.sh (target_height, audio copy si compatible, etc.)
 * mais avec h264_nvenc au lieu de libx264.
 */
function buildFfmpegArgs(job: Job, outPath: string, progressPath: string): string[] {
  const args: string[] = ['-y', '-nostdin', '-hide_banner', '-loglevel', 'warning']

  // Input avec hardware decode si possible (NVENC peut aussi decoder via cuvid)
  // On laisse ffmpeg auto-detect le decodeur pour rester compatible (h264_cuvid, hevc_cuvid...)
  args.push('-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda')
  args.push('-i', job.inputPath)

  // Audio mapping
  if (job.params.audioStream !== 'auto') {
    args.push('-map', '0:v:0', '-map', `0:${job.params.audioStream}`)
  } else {
    args.push('-map', '0:v:0', '-map', '0:a:0?')
  }

  // Video: rescale + encode NVENC
  // Avec hwaccel cuda, le frame est sur GPU - utiliser scale_npp ou scale_cuda pour rester GPU-side
  const vfilters: string[] = []
  if (job.params.targetHeight > 0 && (job.input.height ?? 0) > job.params.targetHeight) {
    // scale_cuda preserve aspect ratio (-2:H = round to even, keep aspect)
    vfilters.push(`scale_cuda=-2:${job.params.targetHeight}`)
  }
  if (vfilters.length > 0) {
    args.push('-vf', vfilters.join(','))
  }

  // Codec video NVENC
  args.push('-c:v', job.params.targetCodec)
  args.push('-preset', job.params.preset)

  // Rate control: bitrate cible (CBR) ou Constant Quality (VBR)
  // - targetBitrate fourni -> rate control par bitrate (predictible, plus rapide)
  // - sinon -> -cq <N> + -b:v 0 (Constant Quality, qualite cible, varie en taille)
  if (job.params.targetBitrate) {
    args.push('-b:v', job.params.targetBitrate)
    args.push('-maxrate', job.params.targetBitrate)
    args.push('-bufsize', job.params.targetBitrate)
  } else {
    args.push('-cq', String(job.params.cq))
    args.push('-b:v', '0')
  }

  // Audio
  const audioMode = job.params.audioMode === 'auto'
    ? (job.input.audioCodec === 'aac' ? 'copy' : 'aac')
    : job.params.audioMode
  if (audioMode === 'copy') {
    args.push('-c:a', 'copy')
  } else {
    args.push('-c:a', 'aac', '-b:a', job.params.audioBitrate)
  }

  // Flags MP4
  args.push('-movflags', '+faststart')

  // Progress vers fichier (parsable par worker)
  args.push('-progress', progressPath)

  args.push(outPath)
  return args
}

/**
 * Demarre ffmpeg pour un job (passe en status running).
 * Lance un loop de progress tracking en parallele (non bloquant).
 */
async function startFfmpeg(job: Job): Promise<void> {
  // CRITIQUE: reserver le slot avant tout await. Sinon processQueue itere sur les
  // jobs queued, lance startFfmpeg(job1), await Bun.write rend la main au caller,
  // job1.status est encore 'queued' -> countRunning() = 0 -> lance job2, job3...
  // Resultat: MAX_CONCURRENT_JOBS=1 contourne, 4 ffmpeg parallels -> OOM/SIGKILL 137.
  job.status = 'running'
  job.startedAt = Date.now()

  const outPath = `${outputDir}/${job.id}.mp4`
  const progressPath = `${outputDir}/${job.id}.progress`

  await Bun.write(progressPath, '')

  job.output = { path: outPath, sizeBytes: 0, ready: false }

  const args = buildFfmpegArgs(job, outPath, progressPath)
  console.log(`[job ${job.id}] spawn: ffmpeg ${args.join(' ')}`)

  const proc = spawn(['ffmpeg', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  job.proc = proc

  // Parse progress file periodiquement
  const progressInterval = setInterval(async () => {
    try {
      const text = await Bun.file(progressPath).text()
      const lines = text.trim().split('\n')
      const parsed: Record<string, string> = {}
      for (const line of lines) {
        const eq = line.indexOf('=')
        if (eq < 0) continue
        parsed[line.slice(0, eq)] = line.slice(eq + 1)
      }
      const outTimeUs = Number(parsed.out_time_us || '0')
      const outTimeS = outTimeUs / 1_000_000
      const duration = job.input.durationSeconds || 1
      job.progress = {
        percent: Math.min(100, Math.round((outTimeS / duration) * 100)),
        outTimeSeconds: Math.round(outTimeS),
        fps: Number(parsed.fps || '0'),
        speed: parsed.speed || '0x',
        frame: Number(parsed.frame || '0'),
      }
    } catch {
      // file pas encore ecrit ou disparu
    }
  }, 1000)

  // Capture stderr en arriere-plan (pour rapport erreur)
  const stderrChunks: string[] = []
  ;(async () => {
    const reader = proc.stderr.getReader()
    const decoder = new TextDecoder()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      stderrChunks.push(decoder.decode(value))
    }
  })()

  // Attendre la fin du proc
  ;(async () => {
    const exitCode = await proc.exited
    clearInterval(progressInterval)
    job.finishedAt = Date.now()

    if (exitCode === 0) {
      // Verifier que le fichier output existe
      try {
        const s = await stat(outPath)
        job.output = { path: outPath, sizeBytes: s.size, ready: true }
        job.progress.percent = 100
        job.status = 'done'
        console.log(`[job ${job.id}] done (${s.size} bytes)`)
      } catch {
        job.status = 'failed'
        job.error = 'output file missing after ffmpeg exit 0'
      }
    } else {
      job.status = 'failed'
      job.error = `ffmpeg exit code ${exitCode}\n${stderrChunks.join('').slice(-2000)}`
      console.error(`[job ${job.id}] failed:`, job.error.slice(0, 500))
    }

    // Cleanup progress file
    await unlink(progressPath).catch(() => {})

    // Lance le job suivant en queue
    processQueue()
  })()
}

/**
 * Cherche un job queued et le demarre si capacite dispo.
 */
function processQueue(): void {
  if (countRunning() >= MAX_CONCURRENT_JOBS) return
  for (const job of jobs.values()) {
    if (job.status === 'queued') {
      startFfmpeg(job).catch((err) => {
        job.status = 'failed'
        job.error = `failed to start ffmpeg: ${err}`
      })
      if (countRunning() >= MAX_CONCURRENT_JOBS) break
    }
  }
}

/**
 * Cree un job et stream le file body vers /data/incoming/<id>.<ext>
 */
export async function createJob(opts: {
  file: File
  params: JobParams
}): Promise<Job> {
  const id = randomUUID()
  const ext = opts.file.name.includes('.') ? opts.file.name.split('.').pop() : 'bin'
  const inputPath = `${incomingDir}/${id}.${ext}`

  // Streaming write (Bun.write avec Blob/File streame en interne, pas de
  // bufferisation RAM. Attention: file.stream() serialiserait en "[object ReadableStream]"
  // car Bun.write ne stream pas correctement un ReadableStream brut)
  await Bun.write(inputPath, opts.file)

  const sizeBytes = (await stat(inputPath)).size

  // Probe
  let probed: Partial<JobInput> = {}
  try {
    probed = await probeInput(inputPath)
  } catch (err) {
    await unlink(inputPath).catch(() => {})
    throw new Error(`input probe failed: ${err}`)
  }

  const job: Job = {
    id,
    status: 'queued',
    createdAt: Date.now(),
    input: {
      filename: opts.file.name,
      sizeBytes,
      ...probed,
    },
    inputPath,
    params: opts.params,
    progress: { percent: 0, outTimeSeconds: 0, fps: 0, speed: '0x', frame: 0 },
  }
  jobs.set(id, job)

  processQueue()

  return job
}

/**
 * Cleanup d'un job: kill ffmpeg si running, delete input + output, retire de la Map.
 */
export async function deleteJob(id: string): Promise<boolean> {
  const job = jobs.get(id)
  if (!job) return false

  if (job.proc && job.status === 'running') {
    try {
      job.proc.kill('SIGKILL')
    } catch {}
  }
  await unlink(job.inputPath).catch(() => {})
  if (job.output?.path) await unlink(job.output.path).catch(() => {})
  await unlink(`${outputDir}/${id}.progress`).catch(() => {})
  jobs.delete(id)
  return true
}

/**
 * Background: nettoie les jobs terminés depuis > JOB_TTL_MINUTES.
 * Tick toutes les 5 min.
 */
setInterval(async () => {
  const now = Date.now()
  const ttlMs = JOB_TTL_MINUTES * 60 * 1000
  for (const job of jobs.values()) {
    if (
      (job.status === 'done' || job.status === 'failed') &&
      job.finishedAt &&
      now - job.finishedAt > ttlMs
    ) {
      console.log(`[cleanup] removing old job ${job.id} (age: ${Math.round((now - job.finishedAt) / 60000)} min)`)
      await deleteJob(job.id).catch(() => {})
    }
  }
}, 5 * 60 * 1000)

export function exportJobForApi(job: Job): Omit<Job, 'proc'> {
  const { proc, ...safe } = job
  return safe
}

export const config = {
  DATA_DIR,
  MAX_CONCURRENT_JOBS,
  JOB_TTL_MINUTES,
}
