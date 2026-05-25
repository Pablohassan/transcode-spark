# transcode-service

Service de transcodage video on-demand exploitant le hardware NVENC GB10 (Blackwell)
du DGX Spark A (192.168.1.31). API HTTP REST avec auth Basic via reverse proxy nginx.

## Architecture

```
Internet --HTTPS--> Freebox --DNAT 443--> VIP .200 -> Pi nginx .60
                                                              |
                                                              v HTTP plain LAN
                                              Spark A .31:8000
                                              transcode-waker (Bun+Hono)
                                              scale-to-zero (idle 30 min)
                                                              |
                                                              v http://127.0.0.1:8001
                                              container ffmpeg
                                              NVENC GB10 (Blackwell)
                                              MAX_CONCURRENT_JOBS=3
```

## Composants

| Dossier | Role | Tourne ou |
|---|---|---|
| `docker/Dockerfile` | Image multi-stage (compile ffmpeg+NVENC + runtime CUDA + Bun) | Build sur Spark A |
| `app/` | Code Hono+Bun (TS) dans le container | Container ffmpeg sur Spark A |
| `waker/` | Service Bun+Hono systemd toujours up qui orchestre le container | Host Spark A (`/home/pablo/transcode-waker/`) |
| `nginx/` | Config nginx reverse proxy | Pi nginx .60 (`/etc/nginx/sites-enabled/`) |
| `scripts/` | Deploy + helpers + wrapper bash client | Lance depuis ton poste |
| `docker-compose.yml` | Orchestration du container ffmpeg | Spark A |

## Endpoints API

```
POST   /jobs                   multipart upload + params codec -> {job_id, status}
GET    /jobs/{job_id}          -> {status, progress, eta}
GET    /jobs/{job_id}/output   streaming download du resultat
DELETE /jobs/{job_id}          cleanup input + output + entry
GET    /codecs                 liste des codecs/preset disponibles
GET    /health                 healthcheck (utilise par waker)
GET    /waker/health           public, monitoring externe (sans auth)
GET    /waker/status           etat detaille waker + container
```

## Configuration optimale (mesure empirique 2026-05-25)

- 1 Spark + `MAX_CONCURRENT_JOBS=3` + PARALLEL=4 client = **3.28-3.42 OK/min** sur 576p PAL -> H.264 480p
- Upload moyen 13 s/fichier, wall median 60 s/fichier
- Client wrapper bash force HTTP/1.1 (gain x7.8 sur upload concurrent vs HTTP/2)
- nginx: `client_max_body_size 12G`, rate limit 600 r/m burst 50
- Waker: `maxRequestBodySize 12 GB` (override Bun default 128 MB)

## Scale-to-zero

- Container ne tourne pas en permanence
- 1er appel API -> waker fait `docker compose up -d` (cold start ~700 ms)
- Pendant l'activite, container reste up
- Apres 30 min sans requete -> waker fait `docker compose stop`
- VRAM/RAM/CPU libere automatiquement

## Deploy

Voir `scripts/deploy.sh`. Workflow:

1. Edit code sur Mac (ce repo)
2. `./scripts/deploy.sh` -> rsync vers Spark A `/home/pablo/transcode-service/`
3. SSH Spark A -> `docker compose build` (si Dockerfile change) ou `docker compose up -d` (si docker-compose ou env change)
4. `sudo systemctl restart transcode-waker.service` (si waker change)
5. Test: `curl https://transcode.agi-so.fr/waker/health`

## Securite

- Basic Auth nginx (htpasswd `/etc/nginx/.htpasswd-transcode`), credential dans Vault `secret/transcode-spark`
- TLS Let's Encrypt auto-renew
- Container Docker isole (pas d'acces au reste du LAN)
- Volume /data isole (pas de bind mount sur chemins sensibles)
- Quota: `client_max_body_size 12G`, `proxy_read_timeout 7200s`

## Code cluster A+B (dormant)

Le repo contient aussi un code de cluster 2-Sparks (waker orchestrator + worker,
dispatcher ETA-based, mapping jobId->backend, lien direct ConnectX-7 200 Gbps).
**Inactif par defaut** apres mesures montrant un gain net trop faible (+4.3 %)
pour un single client uploader, faute de refonte API async (pipeline HTTP couple
upload+transcode+download empeche les 2 chips NVENC d'etre sustained simultanement).

**Reactivation utile uniquement si multi-client** (2 fibres distinctes uploadant
en parallele). Etapes :

```bash
# 1. Spark B container up
ssh pablo@192.168.1.59 'cd /home/pablo/transcode-service && docker compose up -d'
# 2. Waker A en mode orchestrator (sudo sur Spark A)
ssh -t pablo@192.168.1.31 'sudo cp /home/pablo/transcode-waker/systemd-orchestrator.conf /etc/systemd/system/transcode-waker.service.d/ && sudo systemctl daemon-reload && sudo systemctl restart transcode-waker'
```

Pour redesign vrai 2x throughput cluster: implementer endpoints `/batches` +
workers picking depuis queue async (~6-8h dev).

## Documentation cluster K3s (infra parente)

- Cluster K3s docs: `ssh pablo1@192.168.1.171 'cat ~/CLAUDE.md'`
- Reverse proxy HA: `~/docs/cluster/reverse-proxy-ha.md` sur rpi1
- Spark infra: `~/docs/cluster/spark-infrastructure.md` sur rpi1
