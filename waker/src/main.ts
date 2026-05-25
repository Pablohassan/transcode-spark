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

// Seuil d'activation cluster: a partir du Nieme POST cumule, mode batch active.
// Reset uniquement quand le cluster est REELLEMENT idle (jobs running backends = 0
// ET 0 pending ET 30s sans POST). N'utilise PAS activeJobs local qui revient a 0
// entre les POSTs avec PARALLEL=4 -> reset premature -> bug observe 2026-05-25.
const BATCH_THRESHOLD = Number(process.env.BATCH_THRESHOLD ?? '6')
let postsReceived = 0
let lastPostAt = 0

function trackPost(): void {
  postsReceived++
  lastPostAt = Date.now()
}

function isBatchMode(): boolean {
  return postsReceived >= BATCH_THRESHOLD
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

async function startContainer(): Promise<boolean> {
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

// Cache running count per backend (TTL 1s pour eviter rafale de fetches sur dispatch parallels)
const runningCache = new Map<string, { running: number; ts: number }>()

async function countRunningOn(url: string): Promise<number> {
  const cached = runningCache.get(url)
  if (cached && Date.now() - cached.ts < 1000) return cached.running
  try {
    const res = await fetch(`${url}/jobs`, { signal: AbortSignal.timeout(2000) })
    if (!res.ok) return cached?.running ?? 0
    const data = (await res.json()) as { jobs?: Array<{ status: string }> }
    const running = (data.jobs ?? []).filter((j) => j.status === 'running').length
    runningCache.set(url, { running, ts: Date.now() })
    return running
  } catch {
    return cached?.running ?? 0
  }
}

function chooseBackend(aRunning: number, bRunning: number): 'A' | 'B' {
  if (!backendBHealthy) return 'A'
  // Mode single (postsReceived < 6): tout sur A, B reste idle.
  if (!isBatchMode()) return 'A'
  // Mode batch (>= 6 POSTs cumules depuis dernier idle reel): least-loaded.
  const aLoad = aRunning + pendingDispatchA
  const bLoad = bRunning + pendingDispatchB
  if (aLoad <= bLoad) return 'A'
  return 'B'
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
    batchMode: {
      active: isBatchMode(),
      postsReceived,
      threshold: BATCH_THRESHOLD,
      lastPostAt: lastPostAt ? new Date(lastPostAt).toISOString() : null,
    },
  })
})

// -- Orchestrator routes (si BACKEND_B_URL defini) ------------------

if (IS_ORCHESTRATOR) {
  // POST /jobs: choisit le backend selon charge, capture jobId, store mapping
  app.post('/jobs', async (c) => {
    lastActivity = Date.now()
    trackPost() // tracker pour basculer en mode batch au-dela de BATCH_THRESHOLD
    if (!(await isBackendHealthy())) {
      const ok = await startContainer()
      if (!ok) return c.json({ error: 'backend_unavailable' }, 503)
    }
    const aRunning = await countRunningOn(BACKEND_URL)
    const bRunning = backendBHealthy ? await countRunningOn(BACKEND_B_URL!) : 0
    const choice = chooseBackend(aRunning, bRunning)

    activeJobs++
    if (choice === 'A') pendingDispatchA++
    else pendingDispatchB++

    try {
      const res = await proxyTo(backendUrl(choice), c)
      const text = await res.clone().text()
      try {
        const job = JSON.parse(text) as { id?: string }
        if (job.id) {
          jobBackends.set(job.id, choice)
          const mode = isBatchMode() ? 'batch' : 'single'
          console.log(`[dispatch] job ${job.id} -> ${choice} (A:${aRunning + pendingDispatchA}/B:${bRunning + pendingDispatchB}, mode:${mode}, posts:${postsReceived})`)
        }
      } catch {
        // ignore parse: pas un JSON, ou error response
      }
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

// Backend B health poll + batch counter reset (orchestrator only)
if (IS_ORCHESTRATOR) {
  setInterval(async () => {
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
  }, 10_000)
}

// -- Startup --------------------------------------------------------

console.log(`[transcode-waker v${VERSION}] listening on :${LISTEN_PORT}`)
console.log(`  runtime: Bun ${Bun.version}`)
console.log(`  role: ${IS_ORCHESTRATOR ? 'orchestrator' : 'worker'}`)
console.log(`  backend: ${BACKEND_URL}`)
if (IS_ORCHESTRATOR) {
  console.log(`  backend_b: ${BACKEND_B_URL}`)
  console.log(`  max_running_local: ${MAX_RUNNING_LOCAL}`)
  console.log(`  batch_threshold: ${BATCH_THRESHOLD} POSTs cumules (reset sur idle backends reel)`)
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
