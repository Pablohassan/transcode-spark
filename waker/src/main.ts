/**
 * transcode-waker — scale-to-zero + cluster orchestrator.
 *
 * Modes (auto-detected via env):
 *   - worker (default, BACKEND_B_URL absent): proxy catch-all vers backend local 8001
 *   - orchestrator (BACKEND_B_URL set): dispatch /jobs entre Spark A et Spark B
 *
 * Variables d'environnement:
 *   BACKEND_URL        (default http://127.0.0.1:8001) — container local
 *   BACKEND_B_URL      (optional)                     — waker peer (active orchestrator)
 *   MAX_RUNNING_LOCAL  (default 3)                    — seuil dispatch local -> B
 *   COMPOSE_DIR        (default /home/pablo/transcode-service)
 *   IDLE_TIMEOUT_MIN   (default 30)
 *   WAKE_TIMEOUT_S     (default 30)
 *   LISTEN_PORT        (default 8000)
 */
import { Hono, type Context } from 'hono'
import { logger } from 'hono/logger'

const VERSION = '0.2.0'

const BACKEND_URL = process.env.BACKEND_URL ?? 'http://127.0.0.1:8001'
const BACKEND_B_URL = process.env.BACKEND_B_URL
const MAX_RUNNING_LOCAL = Number(process.env.MAX_RUNNING_LOCAL ?? '3')
const COMPOSE_DIR = process.env.COMPOSE_DIR ?? '/home/pablo/transcode-service'
const IDLE_TIMEOUT_MIN = Number(process.env.IDLE_TIMEOUT_MIN ?? '30')
const WAKE_TIMEOUT_S = Number(process.env.WAKE_TIMEOUT_S ?? '30')
const LISTEN_PORT = Number(process.env.LISTEN_PORT ?? '8000')

const IS_ORCHESTRATOR = !!BACKEND_B_URL

let lastActivity = Date.now()
let activeJobs = 0
let containerState: 'unknown' | 'up' | 'down' = 'unknown'

// Cluster state (orchestrator only)
const jobBackends = new Map<string, 'A' | 'B'>()
let backendBHealthy = false
let pendingDispatchA = 0
let pendingDispatchB = 0

// Phase 1 (analyse GPT 2026-05-25): mode cluster active si batch detecte
// (>= BATCH_THRESHOLD POSTs cumules depuis dernier idle reel). En mode cluster,
// scheduler ETA-based: assign job au node avec la plus basse ETA, tie-break A.
const BATCH_THRESHOLD = Number(process.env.BATCH_THRESHOLD ?? '3')
const SPILL_MARGIN_S = Number(process.env.SPILL_MARGIN_S ?? '5')
const TRANSFER_PENALTY_B_S = Number(process.env.TRANSFER_PENALTY_B_S ?? '1')
const AVG_ENCODE_S = Number(process.env.AVG_ENCODE_S ?? '50')

let postsReceived = 0
let lastPostAt = 0

// Log dispatch + timestamps detailled pour analyse post-batch
interface DispatchLog {
  backend: 'A' | 'B'
  assignedAt: number
  postReceivedAt: number
  etaA: number
  etaB: number
}
const dispatchLogs = new Map<string, DispatchLog>()

function trackPost(): void {
  postsReceived++
  lastPostAt = Date.now()
}

function isBatchMode(): boolean {
  return postsReceived >= BATCH_THRESHOLD
}

// ETA approximative: (slots busy / max) * avg_encode + transfer_penalty(B uniquement).
// active = jobs en running + queued reels backends + pending dispatch du waker.
function etaForNode(
  node: 'A' | 'B',
  running: number,
  queued: number,
  pending: number,
  max: number,
): number {
  const slotsBusy = running + queued + pending
  const wavesAhead = Math.ceil(slotsBusy / Math.max(1, max))
  let eta = wavesAhead * AVG_ENCODE_S
  if (node === 'B') eta += TRANSFER_PENALTY_B_S
  return eta
}

// -- Helpers --------------------------------------------------------

async function isBackendHealthy(): Promise<boolean> {
  try {
    const res = await fetch(`${BACKEND_URL}/health`, { signal: AbortSignal.timeout(2000) })
    return res.ok
  } catch {
    return false
  }
}

async function checkBackendBHealth(): Promise<boolean> {
  if (!BACKEND_B_URL) return false
  try {
    const res = await fetch(`${BACKEND_B_URL}/waker/health`, { signal: AbortSignal.timeout(2000) })
    return res.ok
  } catch {
    return false
  }
}

// Mutex: si startContainer est deja en cours, les nouveaux appels attendent
// la meme promise (evite la cascade N x docker compose up en parallele -> SIGABRT).
let containerStartPromise: Promise<boolean> | null = null

async function startContainer(): Promise<boolean> {
  if (containerStartPromise) return containerStartPromise
  containerStartPromise = doStartContainer()
  try {
    return await containerStartPromise
  } finally {
    containerStartPromise = null
  }
}

async function doStartContainer(): Promise<boolean> {
  // Double-check: si l'app a deja recover entre les appels concurrents, skip
  if (await isBackendHealthy()) {
    containerState = 'up'
    return true
  }
  console.log('[waker] starting container...')
  const t0 = Date.now()
  const proc = Bun.spawn(['docker', 'compose', 'up', '-d'], {
    cwd: COMPOSE_DIR,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  await proc.exited
  if (proc.exitCode !== 0) {
    const err = await new Response(proc.stderr).text()
    console.error('[waker] docker compose up failed:', err.slice(0, 500))
    return false
  }
  const deadline = Date.now() + WAKE_TIMEOUT_S * 1000
  while (Date.now() < deadline) {
    if (await isBackendHealthy()) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
      console.log(`[waker] container ready in ${elapsed}s`)
      containerState = 'up'
      return true
    }
    await Bun.sleep(500)
  }
  console.error(`[waker] container failed healthcheck within ${WAKE_TIMEOUT_S}s`)
  return false
}

async function stopContainer(): Promise<void> {
  console.log(`[waker] stopping container (idle > ${IDLE_TIMEOUT_MIN}min, ${activeJobs} active jobs)`)
  const proc = Bun.spawn(['docker', 'compose', 'stop'], {
    cwd: COMPOSE_DIR,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  await proc.exited
  containerState = 'down'
}

// Cache running + queued count per backend (TTL 1s)
interface BackendLoad { running: number; queued: number; ts: number }
const loadCache = new Map<string, BackendLoad>()

async function getBackendLoad(url: string): Promise<{ running: number; queued: number }> {
  const cached = loadCache.get(url)
  if (cached && Date.now() - cached.ts < 1000) return { running: cached.running, queued: cached.queued }
  try {
    const res = await fetch(`${url}/jobs`, { signal: AbortSignal.timeout(2000) })
    if (!res.ok) return { running: cached?.running ?? 0, queued: cached?.queued ?? 0 }
    const data = (await res.json()) as { jobs?: Array<{ status: string }> }
    const jobs = data.jobs ?? []
    const running = jobs.filter((j) => j.status === 'running').length
    const queued = jobs.filter((j) => j.status === 'queued').length
    loadCache.set(url, { running, queued, ts: Date.now() })
    return { running, queued }
  } catch {
    return { running: cached?.running ?? 0, queued: cached?.queued ?? 0 }
  }
}

// Compat helper utilise dans le idle check
async function countRunningOn(url: string): Promise<number> {
  return (await getBackendLoad(url)).running
}

function chooseBackend(
  aRunning: number,
  bRunning: number,
  aQueued: number,
  bQueued: number,
): { backend: 'A' | 'B'; etaA: number; etaB: number } {
  if (!backendBHealthy) {
    const etaA = etaForNode('A', aRunning, aQueued, pendingDispatchA, MAX_RUNNING_LOCAL)
    return { backend: 'A', etaA, etaB: Infinity }
  }
  // Mode single (postsReceived < BATCH_THRESHOLD): tout sur A, B reste idle.
  const etaA = etaForNode('A', aRunning, aQueued, pendingDispatchA, MAX_RUNNING_LOCAL)
  const etaB = etaForNode('B', bRunning, bQueued, pendingDispatchB, MAX_RUNNING_LOCAL)
  if (!isBatchMode()) return { backend: 'A', etaA, etaB }
  // Mode cluster: ETA-based, tie-break A avec SPILL_MARGIN.
  if (etaB + SPILL_MARGIN_S < etaA) return { backend: 'B', etaA, etaB }
  return { backend: 'A', etaA, etaB }
}

function backendUrl(name: 'A' | 'B'): string {
  return name === 'A' ? BACKEND_URL : BACKEND_B_URL!
}

async function proxyTo(targetUrl: string, c: Context): Promise<Response> {
  const url = new URL(c.req.url)
  const full = `${targetUrl}${c.req.path}${url.search}`
  const headers = new Headers(c.req.raw.headers)
  headers.delete('host')
  const res = await fetch(full, {
    method: c.req.method,
    headers,
    body: ['GET', 'HEAD'].includes(c.req.method) ? undefined : c.req.raw.body,
    // @ts-ignore — Bun-specific: duplex pour streaming body
    duplex: 'half',
  })
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  })
}

// -- App / routes ---------------------------------------------------

const app = new Hono()
app.use('*', logger())

// /waker/health: public, pour monitoring externe (Prometheus blackbox)
app.get('/waker/health', (c) =>
  c.json({ status: 'ok', service: 'transcode-waker', version: VERSION }),
)

// /waker/status: etat detaille (incluant cluster info si orchestrator)
app.get('/waker/status', async (c) => {
  const idleMin = (Date.now() - lastActivity) / 60_000
  const base: Record<string, unknown> = {
    version: VERSION,
    role: IS_ORCHESTRATOR ? 'orchestrator' : 'worker',
    containerState,
    lastActivity: new Date(lastActivity).toISOString(),
    idleMinutes: Math.round(idleMin * 10) / 10,
    activeJobs,
    config: {
      backendUrl: BACKEND_URL,
      idleTimeoutMin: IDLE_TIMEOUT_MIN,
      wakeTimeoutS: WAKE_TIMEOUT_S,
      ...(IS_ORCHESTRATOR && {
        backendBUrl: BACKEND_B_URL,
        maxRunningLocal: MAX_RUNNING_LOCAL,
      }),
    },
  }
  if (!IS_ORCHESTRATOR) return c.json(base)

  const aRunning = await countRunningOn(BACKEND_URL)
  const bRunning = backendBHealthy ? await countRunningOn(BACKEND_B_URL!) : 0
  return c.json({
    ...base,
    cluster: {
      A: { running: aRunning, healthy: containerState === 'up', url: BACKEND_URL, pending: pendingDispatchA },
      B: { running: bRunning, healthy: backendBHealthy, url: BACKEND_B_URL, pending: pendingDispatchB },
    },
    totalRunning: aRunning + bRunning,
    jobMappings: jobBackends.size,
    dispatch: {
      algorithm: 'ETA-based + batch threshold',
      mode: isBatchMode() ? 'batch' : 'single',
      postsReceived,
      threshold: BATCH_THRESHOLD,
      avgEncodeS: AVG_ENCODE_S,
      spillMarginS: SPILL_MARGIN_S,
      lastPostAt: lastPostAt ? new Date(lastPostAt).toISOString() : null,
      dispatchLogsSize: dispatchLogs.size,
    },
  })
})

// Endpoint d'analyse post-batch: tous les dispatch logs avec timestamps
app.get('/waker/dispatch-logs', (c) => {
  if (!IS_ORCHESTRATOR) return c.json({ logs: [] })
  const logs = Array.from(dispatchLogs.entries()).map(([jobId, log]) => ({
    jobId,
    backend: log.backend,
    postReceivedAt: new Date(log.postReceivedAt).toISOString(),
    assignedAt: new Date(log.assignedAt).toISOString(),
    uploadDurationMs: log.assignedAt - log.postReceivedAt,
    etaAtDispatchA: log.etaA,
    etaAtDispatchB: log.etaB,
  }))
  return c.json({ count: logs.length, logs })
})

// -- Orchestrator routes (si BACKEND_B_URL defini) ------------------

if (IS_ORCHESTRATOR) {
  // POST /jobs: ETA-based scheduler. Stocke mapping + log timestamps detailled.
  app.post('/jobs', async (c) => {
    const postReceivedAt = Date.now()
    lastActivity = postReceivedAt
    trackPost()
    if (!(await isBackendHealthy())) {
      const ok = await startContainer()
      if (!ok) return c.json({ error: 'backend_unavailable' }, 503)
    }
    const loadA = await getBackendLoad(BACKEND_URL)
    const loadB = backendBHealthy ? await getBackendLoad(BACKEND_B_URL!) : { running: 0, queued: 0 }
    const { backend: choice, etaA, etaB } = chooseBackend(
      loadA.running, loadB.running, loadA.queued, loadB.queued,
    )
    const mode = isBatchMode() ? 'batch' : 'single'

    activeJobs++
    if (choice === 'A') pendingDispatchA++
    else pendingDispatchB++

    try {
      const res = await proxyTo(backendUrl(choice), c)
      const text = await res.clone().text()
      try {
        const job = JSON.parse(text) as { id?: string }
        if (job.id) {
          const assignedAt = Date.now()
          jobBackends.set(job.id, choice)
          dispatchLogs.set(job.id, { backend: choice, assignedAt, postReceivedAt, etaA, etaB })
          console.log(
            `[dispatch] job ${job.id} -> ${choice} (mode:${mode}, posts:${postsReceived}, ` +
            `loadA:${loadA.running}r${loadA.queued}q+${pendingDispatchA}p, ` +
            `loadB:${loadB.running}r${loadB.queued}q+${pendingDispatchB}p, ` +
            `ETA: A=${etaA.toFixed(0)}s B=${etaB.toFixed(0)}s, ` +
            `upload:${assignedAt - postReceivedAt}ms)`
          )
        }
      } catch {/* ignore non-JSON */}
      return new Response(text, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      })
    } catch (err) {
      console.error('[dispatch] proxy error:', err)
      return c.json({ error: 'dispatch_error', detail: String(err) }, 502)
    } finally {
      activeJobs--
      if (choice === 'A') pendingDispatchA--
      else pendingDispatchB--
    }
  })

  // GET /jobs: agrege A + B (tries par createdAt desc)
  app.get('/jobs', async (c) => {
    const fetchSafe = (url: string) =>
      fetch(`${url}/jobs`, { signal: AbortSignal.timeout(2000) })
        .then((r) => (r.ok ? r.json() : { jobs: [] }))
        .catch(() => ({ jobs: [] })) as Promise<{ jobs: Array<{ createdAt: number }> }>

    const tasks: Promise<{ jobs: Array<{ createdAt: number }> }>[] = [fetchSafe(BACKEND_URL)]
    if (backendBHealthy) tasks.push(fetchSafe(BACKEND_B_URL!))
    const results = await Promise.all(tasks)
    const allJobs = results.flatMap((r) => r.jobs ?? [])
    allJobs.sort((a, b) => b.createdAt - a.createdAt)
    return c.json({ count: allJobs.length, jobs: allJobs })
  })

  // GET /jobs/:id, GET /jobs/:id/output, DELETE /jobs/:id: route par mapping
  const routeById = async (c: Context): Promise<Response> => {
    lastActivity = Date.now()
    const id = c.req.param('id') as string
    const backend = jobBackends.get(id) ?? 'A'
    const isLongOp = c.req.path.endsWith('/output')
    if (isLongOp) activeJobs++
    try {
      const res = await proxyTo(backendUrl(backend), c)
      if (c.req.method === 'DELETE' && res.ok) jobBackends.delete(id)
      return res
    } finally {
      if (isLongOp) activeJobs--
    }
  }
  app.get('/jobs/:id', routeById)
  app.delete('/jobs/:id', routeById)
  app.get('/jobs/:id/output', routeById)
}

// Catch-all: proxy local (routes /codecs, /health, /, etc.)
app.all('*', async (c) => {
  lastActivity = Date.now()
  if (!(await isBackendHealthy())) {
    const ok = await startContainer()
    if (!ok) return c.json({ error: 'backend_unavailable' }, 503)
  }
  const path = c.req.path
  const isLongOp = (path.startsWith('/jobs') && c.req.method === 'POST') || path.endsWith('/output')
  if (isLongOp) activeJobs++
  try {
    return await proxyTo(BACKEND_URL, c)
  } catch (err) {
    console.error('[waker] proxy error:', err)
    return c.json({ error: 'proxy_error', detail: String(err) }, 502)
  } finally {
    if (isLongOp) activeJobs--
  }
})

// -- Background loops -----------------------------------------------

// Idle monitor: stop container si rien en cours + > IDLE_TIMEOUT_MIN
setInterval(async () => {
  const idleMin = (Date.now() - lastActivity) / 60_000
  if (idleMin > IDLE_TIMEOUT_MIN && activeJobs === 0 && containerState === 'up') {
    await stopContainer()
  }
}, 60_000)

// Periodic health poll (LOCAL A + remote B si orchestrator) + batch counter reset
setInterval(async () => {
  // Refresh local container state (evite croyance stale apres incident)
  const aHealthy = await isBackendHealthy()
  if (aHealthy && containerState !== 'up') {
    console.log(`[waker] backend A recovered: ${containerState} -> up`)
    containerState = 'up'
  } else if (!aHealthy && containerState === 'up') {
    console.log(`[waker] backend A lost: up -> down`)
    containerState = 'down'
  }

  if (IS_ORCHESTRATOR) {
    const newHealth = await checkBackendBHealth()
    if (newHealth !== backendBHealthy) {
      console.log(`[cluster] backend B ${newHealth ? 'recovered' : 'down'}`)
      backendBHealthy = newHealth
    }
    // Reset compteur batch quand cluster VRAIMENT idle. Critere = jobs running
    // reels sur les backends (pas activeJobs local qui revient a 0 entre POSTs
    // avec PARALLEL=4 -> reset premature). Conditions cumulees:
    //  - >30s sans nouveau POST
    //  - 0 pending dispatch
    //  - 0 jobs running sur backend A
    //  - 0 jobs running sur backend B
    const idleMs = Date.now() - lastPostAt
    if (
      lastPostAt > 0 &&
      idleMs > 30_000 &&
      pendingDispatchA === 0 &&
      pendingDispatchB === 0 &&
      postsReceived > 0
    ) {
      const aRunning = await countRunningOn(BACKEND_URL)
      const bRunning = backendBHealthy ? await countRunningOn(BACKEND_B_URL!) : 0
      if (aRunning === 0 && bRunning === 0) {
        console.log(`[batch] cluster truly idle ${Math.round(idleMs / 1000)}s -> reset counter (was ${postsReceived})`)
        postsReceived = 0
      }
    }
  }
}, 10_000)

// -- Startup --------------------------------------------------------

console.log(`[transcode-waker v${VERSION}] listening on :${LISTEN_PORT}`)
console.log(`  runtime: Bun ${Bun.version}`)
console.log(`  role: ${IS_ORCHESTRATOR ? 'orchestrator' : 'worker'}`)
console.log(`  backend: ${BACKEND_URL}`)
if (IS_ORCHESTRATOR) {
  console.log(`  backend_b: ${BACKEND_B_URL}`)
  console.log(`  max_running_local: ${MAX_RUNNING_LOCAL}`)
  console.log(`  dispatch: ETA-based, batch threshold=${BATCH_THRESHOLD} POSTs, spill_margin=${SPILL_MARGIN_S}s, avg_encode=${AVG_ENCODE_S}s`)
}
console.log(`  compose_dir: ${COMPOSE_DIR}`)
console.log(`  idle_timeout: ${IDLE_TIMEOUT_MIN} min`)

void (async () => {
  containerState = (await isBackendHealthy()) ? 'up' : 'down'
  console.log(`  initial backend state: ${containerState}`)
  if (IS_ORCHESTRATOR) {
    backendBHealthy = await checkBackendBHealth()
    console.log(`  initial backend B: ${backendBHealthy ? 'healthy' : 'unhealthy'}`)
  }
})()

export default {
  port: LISTEN_PORT,
  fetch: app.fetch,
  idleTimeout: 0,
  maxRequestBodySize: 12 * 1024 * 1024 * 1024,
}
