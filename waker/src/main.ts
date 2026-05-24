/**
 * transcode-waker — scale-to-zero orchestrator pour transcode-service.
 *
 * Roles:
 *   1. Toujours up (~15-20 Mo RAM) sur l'host Spark A, port :8000
 *   2. Tous les appels HTTP sont proxifies vers le container ffmpeg :8001
 *   3. Si le container est down -> `docker compose up -d` + wait healthcheck
 *   4. Track last_activity timestamp
 *   5. Background tick (60s): si idle > IDLE_TIMEOUT_MIN ET 0 job actif -> stop
 *
 * Variables d'environnement:
 *   BACKEND_URL        (default http://127.0.0.1:8001)
 *   COMPOSE_DIR        (default /home/pablo/transcode-service)
 *   IDLE_TIMEOUT_MIN   (default 30)
 *   WAKE_TIMEOUT_S     (default 30) - temps max pour qu'un container devienne healthy
 *   LISTEN_PORT        (default 8000)
 */
import { Hono } from 'hono'
import { logger } from 'hono/logger'

const VERSION = '0.1.0'

const BACKEND_URL = process.env.BACKEND_URL ?? 'http://127.0.0.1:8001'
const COMPOSE_DIR = process.env.COMPOSE_DIR ?? '/home/pablo/transcode-service'
const IDLE_TIMEOUT_MIN = Number(process.env.IDLE_TIMEOUT_MIN ?? '30')
const WAKE_TIMEOUT_S = Number(process.env.WAKE_TIMEOUT_S ?? '30')
const LISTEN_PORT = Number(process.env.LISTEN_PORT ?? '8000')

let lastActivity = Date.now()
let activeJobs = 0
let containerState: 'unknown' | 'up' | 'down' = 'unknown'

// -- Helpers --------------------------------------------------------

async function isBackendHealthy(): Promise<boolean> {
  try {
    const res = await fetch(`${BACKEND_URL}/health`, {
      signal: AbortSignal.timeout(2000),
    })
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
  // Wait for healthcheck
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

// -- App / routes ---------------------------------------------------

const app = new Hono()
app.use('*', logger())

// Endpoints de monitoring du waker lui-meme (preferer /waker/* pour ne pas
// collisionner avec les routes du backend)
app.get('/waker/health', (c) =>
  c.json({ status: 'ok', service: 'transcode-waker', version: VERSION }),
)

app.get('/waker/status', (c) => {
  const idleMin = (Date.now() - lastActivity) / 60_000
  return c.json({
    version: VERSION,
    containerState,
    lastActivity: new Date(lastActivity).toISOString(),
    idleMinutes: Math.round(idleMin * 10) / 10,
    activeJobs,
    config: {
      backendUrl: BACKEND_URL,
      idleTimeoutMin: IDLE_TIMEOUT_MIN,
      wakeTimeoutS: WAKE_TIMEOUT_S,
    },
  })
})

// Proxy catch-all vers le container ffmpeg
app.all('*', async (c) => {
  lastActivity = Date.now()

  // Lazy wake si backend down
  if (!(await isBackendHealthy())) {
    const ok = await startContainer()
    if (!ok) {
      return c.json(
        { error: 'backend_unavailable', detail: 'failed to start ffmpeg container' },
        503,
      )
    }
  }

  // Long-running operations (upload/download) tracked pour eviter shutdown au milieu
  const path = c.req.path
  const isLongOp =
    (path.startsWith('/jobs') && c.req.method === 'POST') ||
    path.endsWith('/output')
  if (isLongOp) activeJobs++

  try {
    const url = new URL(c.req.url)
    const targetUrl = `${BACKEND_URL}${path}${url.search}`

    // Clone headers, retire host (sinon le backend croit recevoir la requete d'un autre host)
    const headers = new Headers(c.req.raw.headers)
    headers.delete('host')

    const res = await fetch(targetUrl, {
      method: c.req.method,
      headers,
      body: ['GET', 'HEAD'].includes(c.req.method) ? undefined : c.req.raw.body,
      // @ts-ignore - Bun-specific: duplex pour streaming body
      duplex: 'half',
    })

    // Streaming response: re-emette tel quel au client
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    })
  } catch (err) {
    console.error('[waker] proxy error:', err)
    return c.json(
      { error: 'proxy_error', detail: err instanceof Error ? err.message : String(err) },
      502,
    )
  } finally {
    if (isLongOp) activeJobs--
  }
})

// -- Background idle monitor ----------------------------------------

setInterval(async () => {
  const idleMin = (Date.now() - lastActivity) / 60_000
  if (idleMin > IDLE_TIMEOUT_MIN && activeJobs === 0 && containerState === 'up') {
    await stopContainer()
  }
}, 60_000)

// -- Startup --------------------------------------------------------

console.log(`[transcode-waker v${VERSION}] listening on :${LISTEN_PORT}`)
console.log(`  runtime: Bun ${Bun.version}`)
console.log(`  backend: ${BACKEND_URL}`)
console.log(`  compose_dir: ${COMPOSE_DIR}`)
console.log(`  idle_timeout: ${IDLE_TIMEOUT_MIN} min`)

// Check initial state du backend
;(async () => {
  const ok = await isBackendHealthy()
  containerState = ok ? 'up' : 'down'
  console.log(`  initial backend state: ${containerState}`)
})()

export default {
  port: LISTEN_PORT,
  fetch: app.fetch,
  // Important: 0 = pas de timeout idle Bun sur les connexions (sinon coupe les uploads longs)
  idleTimeout: 0,
}
