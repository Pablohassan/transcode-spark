# transcode-service

Service de transcodage video on-demand exploitant le hardware NVENC 9eme generation
(Blackwell) du DGX Spark A (192.168.1.31).

## Architecture

```
Internet --HTTPS--> Freebox 82.65.17.134 --DNAT 443--> VIP .200 (keepalived)
                                                              |
                                                              v
                                              Pi nginx .60 (raspberrypi)
                                              site: transcode.agi-so.fr
                                              + Let's Encrypt + Basic Auth
                                              + proxy_request_buffering off
                                                              |
                                                              v HTTP plain LAN
                                              Spark A .31:8000
                                                              |
                                                              v
                                              transcode-waker.service (systemd)
                                              - FastAPI proxy toujours up (~30 MB RAM)
                                              - Spawn container ffmpeg a la demande
                                              - Stop apres 30 min d'inactivite
                                                              |
                                                              v http://127.0.0.1:8001
                                              container Docker "transcode-ffmpeg"
                                              - base nvidia/cuda:12.6.0-runtime
                                              - ffmpeg compile avec NVENC + libnpp
                                              - app Bun + Hono (~50 Mo RAM)
                                              - Endpoints: POST /jobs, etc.
                                              - Volume /data
                                                              |
                                                              v
                                              GPU NVIDIA GB10 (Blackwell)
                                              NVENC h264/hevc/av1 hardware
```

## Composants

| Dossier | Role | Tourne ou |
|---|---|---|
| `docker/Dockerfile` | Image multi-stage: builder (compile ffmpeg+NVENC) + runtime (CUDA + Bun + Hono) | Build sur Spark A |
| `app/` | Code Hono+Bun (TS) dans le container | Container ffmpeg sur Spark A |
| `waker/` | Service Bun+Hono systemd toujours up qui orchestre le container | Host Spark A (`/opt/transcode-waker/`) |
| `nginx/` | Config nginx reverse proxy | Pi nginx .60 (`/etc/nginx/sites-enabled/`) |
| `scripts/` | Deploy + build helpers | Lance depuis ton poste |
| `docker-compose.yml` | Orchestration du container ffmpeg | Spark A |

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
- Quota: `client_max_body_size 8G`, `proxy_read_timeout 7200s`

## Documentation cluster

- Cluster K3s docs: `ssh pablo1@192.168.1.171 'cat ~/CLAUDE.md'`
- Reverse proxy HA: `~/docs/cluster/reverse-proxy-ha.md` sur rpi1
- Spark infra: `~/docs/cluster/spark-infrastructure.md` sur rpi1
