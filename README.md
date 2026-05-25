# transcode-service

Service de transcodage video on-demand exploitant le hardware NVENC 9eme generation
(Blackwell) sur cluster DGX Spark A (.31) + B (.59).

## Architecture (cluster 2-noeuds)

```
Internet --HTTPS--> Freebox --DNAT 443--> VIP .200 -> Pi nginx .60
                                                              |
                                                              v HTTP plain LAN
                                              Spark A .31:8000 (orchestrator)
                                              transcode-waker (Bun+Hono)
                                              dispatch logic + scale-to-zero
                                              ├──> http://127.0.0.1:8001 (container A)
                                              │      NVENC GB10 #A
                                              │
                                              └──> http://10.0.0.2:8000 (waker B)
                                                     via lien direct ConnectX-7 200 Gbps
                                                     mesure 110 Gbit/s iperf3
                                                              |
                                                              v
                                                Spark B .59:8000 (worker)
                                                ├──> http://127.0.0.1:8001 (container B)
                                                       NVENC GB10 #B
```

**Dispatch logic** (orchestrator sur Spark A) :
- POST /jobs:
  - Compteur `postsReceived` cumulé depuis le dernier idle réel du cluster
  - `postsReceived < BATCH_THRESHOLD` (default 6) → **mode single**, tout sur A (B reste idle, scale-to-zero possible)
  - `postsReceived >= 6` → **mode batch**, least-loaded entre A et B (tie-break A)
  - Reset auto du compteur quand cluster vraiment idle: >30s sans POST + 0 pending + 0 jobs running sur A ET B (interrogation réelle des backends, pas un compteur local)
- GET/DELETE /jobs/{id}, GET /jobs/{id}/output: route par mapping jobId -> backend (RAM)
- GET /jobs: agregation A + B (tries par createdAt desc)
- Failure: si Spark B down (poll 30s), fallback automatique tout sur A

Capacite cluster: **6 jobs running simultanes** (3 par Spark). Transparent cote client.
Pour batch > 5 fichiers: PARALLEL=4 client → mode batch s'active au 6e POST → B s'active → distribution équilibrée sur le reste du batch.

## Composants

| Dossier | Role | Tourne ou |
|---|---|---|
| `docker/Dockerfile` | Image multi-stage: builder (compile ffmpeg+NVENC) + runtime (CUDA + Bun + Hono) | Build sur Spark A + B |
| `app/` | Code Hono+Bun (TS) dans le container | Container ffmpeg sur Spark A + B |
| `waker/` | Service Bun+Hono systemd toujours up (orchestrator A / worker B) | Host Spark A + B (`/home/pablo/transcode-waker/`) |
| `waker/systemd-orchestrator.conf` | Drop-in systemd qui active mode orchestrator (BACKEND_B_URL + MAX_RUNNING_LOCAL) | Spark A uniquement |
| `nginx/` | Config nginx reverse proxy | Pi nginx .60 (`/etc/nginx/sites-enabled/`) |
| `scripts/` | Deploy + build helpers | Lance depuis ton poste |
| `docker-compose.yml` | Orchestration du container ffmpeg | Spark A + B |

## Endpoints API (via container :8001 → proxifie via waker :8000 → nginx)

```
POST   /jobs                 multipart upload + params codec → renvoie {job_id, status}
GET    /jobs/{job_id}        → {status, progress, eta}
GET    /jobs/{job_id}/output streaming download du resultat
DELETE /jobs/{job_id}        cleanup input + output + entry
GET    /codecs               liste des codecs/preset disponibles
GET    /health               healthcheck (utilise par waker)
GET    /metrics              Prometheus metrics
```

## Performance attendue (mesures 2026-05-24)

- LAN Pi.60 <-> Spark.31: 943 Mbps wire speed
- WAN Freebox up: 866 Mbps
- TLS Pi 4 single-core (AES-256-GCM): 461 Mbps
- **Goulot single-stream: TLS Pi nginx ~460 Mbps = 57 MB/s**
- Vidéo 1 GB upload: ~18 s, 4 GB: ~71 s

**Multi-stream**: 4 streams x 250 MiB → 626 Mbps cumulé. PARALLEL=2 default, PARALLEL=4 OK sur fibre 1 Gbps.

**Cluster 2-noeuds (mesure 2026-05-25)**:
- 6 POST paralleles via orchestrator -> distribution 3+3 (A+B) en <1s
- Test E2E: 6/6 done, 6/6 downloads OK
- Lien inter-Spark 10.0.0.0/24 = 110 Gbit/s sustained iperf3 (vs LAN .60/.31 = 2.5 Gbps)
- Gain attendu batch 20+ fichiers: ~1.5x-2x wall time selon PARALLEL client (utiliser PARALLEL=6 pour saturer les 6 slots cluster)

NVENC GB10 Blackwell: H.264/HEVC/AV1 hardware encoding.
4K AV1 encode: ~100+ fps. Transcode = nettement plus rapide que le transfert.

## Scale-to-zero

- Le container ffmpeg ne tourne **pas en permanence**
- Premier appel API → waker fait `docker compose up -d` (cold start ~5-10s)
- Pendant l'activite, le container reste up
- Apres 30 min sans aucune requete → waker fait `docker compose stop`
- VRAM/RAM/CPU libere automatiquement

## Deploy

Voir `scripts/deploy.sh`. Workflow:

1. Edit code sur Mac (ce repo)
2. `./scripts/deploy.sh` → rsync vers Spark A `/opt/transcode-service/`
3. SSH Spark A → `docker compose build` (si Dockerfile change)
4. `systemctl restart transcode-waker.service` (si waker change)
5. Test: `curl https://transcode.agi-so.fr/health`

## Securite

- Basic Auth nginx (htpasswd `/etc/nginx/.htpasswd-transcode`)
- TLS Let's Encrypt auto-renew
- Container Docker isole: pas d'acces au reste du LAN
- Volume /data isole (pas de bind mount sur des chemins sensibles)
- Quota: `client_max_body_size 12G`, `proxy_read_timeout 7200s`

## Documentation cluster

- Cluster K3s docs: `ssh pablo1@192.168.1.171 'cat ~/CLAUDE.md'`
- Reverse proxy HA: `~/docs/cluster/reverse-proxy-ha.md` sur rpi1
- Spark infra: `~/docs/cluster/spark-infrastructure.md` sur rpi1
