/**
 * transcode-service — app Hono+Bun tournant dans le container Docker.
 * Expose les endpoints de transcodage video utilisant ffmpeg + NVENC sur GPU GB10.
 *
 * Cette version initiale (placeholder) fournit /health et /codecs pour permettre
 * le build + healthcheck Docker. Le vrai code metier (jobs, transcode, queue)
 * viendra ensuite.
 */
import { Hono } from 'hono'
import { logger } from 'hono/logger'

const app = new Hono()
app.use('*', logger())

const VERSION = '0.1.0'

app.get('/', (c) =>
  c.json({
    service: 'transcode-service',
    version: VERSION,
    note: 'placeholder - endpoints jobs viennent ensuite',
    endpoints: ['/health', '/codecs', '/'],
  }),
)

app.get('/health', (c) =>
  c.json({ status: 'ok', version: VERSION, runtime: 'bun', framework: 'hono' }),
)

/**
 * Introspection ffmpeg: liste les encoders NVENC disponibles.
 * Utile pour confirmer que le build a bien embarqué le support NVENC.
 */
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

    const cudaEncoders = stdout
      .split('\n')
      .filter((l) => /cuda|cuvid|nvdec/i.test(l))
      .map((l) => l.trim())

    return c.json({
      ffmpeg_ok: proc.exitCode === 0,
      nvenc_encoders: nvencEncoders,
      cuda_decoders: cudaEncoders,
      total_lines: stdout.split('\n').length,
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

export default {
  port: 8001,
  fetch: app.fetch,
}

console.log(`[transcode-service v${VERSION}] listening on :8001 (Bun ${Bun.version})`)
