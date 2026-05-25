# transcode-service

Service de transcodage video on-demand exploitant le hardware NVENC 9eme generation
(Blackwell) sur DGX Spark A (.31).

## Architecture (single node)

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

**Sweet spot empirique (validation batch Maries deux enfants 2026-05-25)** :
- 1 Spark + MAX=3 + PARALLEL=4 client = **3.28-3.42 OK/min** sur 576p PAL -> H.264 480p
- Upload moyen 13 s/fichier (apres fix concurrence pipeline)
- Wall median 60 s/fichier (upload + transcode + download couples HTTP)
- Bottleneck = **NVENC GB10 d'UN chip sature a 96%** sur ce contenu
- Fibre Mac upload ~860 Mbps max, pic observe ~600 Mbps = **PAS saturee**

**Test cluster 2-Sparks (v9 ETA-based, mesure complete avec monitoring NVENC live)** :

| Indicateur | 1 Spark sweet spot | Cluster ETA | Delta |
|---|---|---|---|
| Throughput | 3.28 OK/min | 3.42 OK/min | +4.3 % |
| Wall 20 fichiers | 6m20s | 5m33s | -12 % |
| Upload moyen/fichier | 38 s (avant fixes) | 13 s | -66 % |
| NVENC A+B sustained >=85% simultane | n/a | **1 %** du temps mesure | tres faible |

**Pourquoi seulement +4 %** : le pipeline HTTP synchrone `upload -> ffprobe ->
transcode -> download` couple les phases. A.NVENC se libere plus vite que le
client n'envoie le suivant -> A reprend la priorite -> B perd sa charge. Les
2 chips NVENC ne sont saturees simultanement que 1 % du temps mesure (vs
~50 % theorique pour vrai 2x). Le gain reel observe vient surtout des fixes
collateraux pipeline (HTTP/1.1 implicite Node, maxRequestBodySize 12 GB,
rate limit 600 r/m burst 50), pas du deuxieme NVENC.

**Pour atteindre vrai 2x** : refonte API async (endpoints /batches + workers
picking depuis queue interne sans coupling au upload client). Non implemente,
~6-8h dev. Code cluster reste deploye pour reactivation future.

**Spark B (.59)** : container stop, waker B up idle (~20 MB RAM, scale-to-zero
NVENC). Reactivation cluster = 3 etapes :
1. `docker compose up -d` sur Spark B
2. `sudo cp /home/pablo/transcode-waker/systemd-orchestrator.conf /etc/systemd/system/transcode-waker.service.d/`
3. `sudo systemctl daemon-reload && sudo systemctl restart transcode-waker` sur Spark A

Utile uniquement si **multi-client uploader** (ex: Damso depuis sa propre fibre
en parallele de toi) : 2 fibres = 2x bandwidth ingress -> les 2 chips NVENC
vraiment sollicitees simultanement.

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
