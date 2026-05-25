# Guide d'integration `transcode-service` dans `reencode-tui.sh`

Salut Damso. Ce service expose **ffmpeg + NVENC du Spark GB10** via une API REST HTTPS.
Au lieu de faire tourner libx264 sur ton CPU, tu pousses la video, le Spark la transcode
sur le bloc NVENC hardware (jusqu'a ~100x realtime sur 480p), et tu downloads le resultat.

## Setup en 30 secondes

### Etape 1 — Recupere le credential via Vault wrap (one-shot, 24h)

Rusmir te transmet via Signal/Telegram un wrap token de la forme `hvs.CAESI...`.
Tu deroules le wrap (USAGE UNIQUE, expire dans 24h):

```bash
CRED=$(curl -sS -X POST -H "X-Vault-Token: hvs.CAESI..." \
     https://vault.agi-so.fr/v1/sys/wrapping/unwrap | jq -r '.data.TRANS_SPARK_API')

# Stocke dans ton shell ou ~/.bashrc:
export TRANSCODE_API_AUTH="$CRED"
unset CRED
```

Le credential est deja au format Basic Auth `user:password` direct.

### Etape 2 — Source le wrapper bash

```bash
source <(curl -s https://transcode.agi-so.fr/transcode-api-client.sh)
```

### Etape 3 — Test

```bash
transcode_api_health
# Devrait afficher 3 lignes (av1_nvenc, h264_nvenc, hevc_nvenc)
```

Si tu vois les 3 encoders → tout marche. Tu peux passer a l'integration dans
ton `reencode-tui.sh` (section ci-dessous).

### En cas de probleme

- Wrap rate (expire ou deja utilise) → demande a Rusmir d'en regenerer un
- Wrap accepte mais credential ne marche pas (401) → Rusmir doit verifier
  la coherence Vault/htpasswd (rotation possiblement incomplete)
- Decentralise / pas envie de wrap: Rusmir peut creer un user Vault dedie
  pour toi (userpass `damso` + policy `transcode-reader`) qui te donne acces
  long terme sans dependance au wrap

## Test minimal

```bash
# Transcode une video locale via le Spark
transcode_via_api ./S01E01.mkv ./S01E01.mp4 \
    --target_codec=h264_nvenc \
    --target_height=480 \
    --preset=p1 \
    --target_bitrate=1500k
```

Output attendu:
```
  [transcode-api] upload ./S01E01.mkv (126 MB) -> https://transcode.agi-so.fr/jobs
  [transcode-api] job=a3f8d... status=running
  [transcode-api] progress=50% fps=1048 speed=41.9x
  [transcode-api] done: ./S01E01.mp4 (196 MB) en 23s
```

## Integration dans `reencode-tui.sh`

Dans ton script, trouve la fonction `encode_one()` et la ligne ffmpeg.
Voici ce qui change:

### Avant (ton script actuel, encode local libx264)

```bash
encode_one() {
    local file="$1"
    ...
    if ffmpeg -i "$file" \
        $AUDIO_MAP \
        $vf_opts \
        $video_opts \
        $audio_opts \
        -movflags +faststart \
        -progress "$progress_file" \
        -nostdin -nostats -loglevel error \
        -y \
        "$output_file" 2>"$error_output"; then
        ...
    fi
}
```

### Apres (encode distant NVENC via API)

Au debut du script (apres le shebang):
```bash
source "$(dirname "$0")/transcode-api-client.sh"
# OU chemin absolu si ailleurs
```

Puis dans `encode_one()`, remplace le bloc ffmpeg par:

```bash
encode_one() {
    local file="$1"
    local filename=$(basename "$file")
    local output_file="$OUTPUT_DIR/${filename%.*}.mp4"

    # Skip si deja existant
    if [[ -f "$output_file" && -s "$output_file" ]]; then
        local size=$(du -h "$output_file" | cut -f1)
        increment skipped
        log_activity "SKIP $filename ($size)"
        rm -f "$STATE_DIR/active/$$"
        return
    fi
    rm -f "$output_file"

    # Marque le job comme actif (pour le dashboard TUI)
    echo "$filename" > "$STATE_DIR/active/$$"

    # === REMPLACEMENT FFMPEG -> API ===
    local err_log=$(mktemp)
    if transcode_via_api "$file" "$output_file" \
        --target_codec=h264_nvenc \
        --target_height="$TARGET_HEIGHT" \
        --preset=p1 \
        --target_bitrate=2000k \
        --audio_mode=auto \
        > "$err_log" 2>&1; then
        local size=$(du -h "$output_file" | cut -f1)
        increment processed
        log_activity "OK   $filename ($size)"
        rm -f "$err_log"
    else
        local exit_code=$?
        increment failed
        {
            echo "=== $(date) ==="
            echo "Fichier: $filename"
            echo "Exit code transcode_via_api: $exit_code"
            cat "$err_log"
            echo ""
        } >> "$LOG_FILE"
        log_activity "FAIL $filename (code: $exit_code)"
        rm -f "$output_file" "$err_log"
    fi

    rm -f "$STATE_DIR/active/$$"
}
```

## ⚡ Parametre `PARALLEL` — utilise PARALLEL=2 (ou 4 si fibre 1 Gbps)

| Cote | Limite | Impact |
|---|---|---|
| Toi (client) | Fibre ~1 Gbps upload | PARALLEL=1 limite a ~250 Mbps single-stream HTTP/1.1, tu sous-exploites ta fibre |
| Pi nginx (reverse proxy) | TLS ~461 Mbps par core, 4 cores | PARALLEL=2 = 2 cores TLS en parallele = ~700-900 Mbps, PARALLEL=4 plafonne a ta fibre |
| Spark (transcode) | NVENC 3 jobs concurrents max | PARALLEL>1 cote toi -> uploads simultanes masquent la latence reseau pendant les transcodes |
| Serveur queue | FIFO, sans limite | Les jobs au-dela des 3 actifs attendent en queued, OK |

### Usage

```bash
./reencode-tui.sh /media/torrents/Birdman/ /out 4 1 480
#                                          ^ PARALLEL=4 (recommande sur fibre 1+ Gbps)
#                                            ^ THREADS=1 (pas utilise: c'est NVENC sur Spark)
#                                              ^ TARGET_HEIGHT=480
```

### Notes pratiques

- Cold-start (>30 min idle): 1 503 possible sur le 1er essai, retry suffit
- Le wrapper force HTTP/1.1 dans curl (`--http1.1`) pour eviter le piege HTTP/2:
  multiplexing sur 1 connexion TCP + INITIAL_WINDOW_SIZE 64 KB cap le throughput
  upload a ~55 Mbps/stream. HTTP/1.1 = 4 connexions distinctes = 4 cores TLS Pi
  en parallele = ~175-250 Mbps/stream sur fibre 1+ Gbps.

## Parametres recommandes selon use case

| Use case | preset | target_bitrate ou cq | Note |
|---|---|---|---|
| **Batch series 480p** (le tien) | `p1` | `target_bitrate=1500k` | ~109x realtime, ~30MB par episode |
| Batch series 720p HD | `p1` | `target_bitrate=2500k` | ~50x realtime |
| Batch films 1080p | `p2` | `target_bitrate=4000k` | ~25-30x realtime, qualite proche x264 medium |
| Archive long terme 1080p | `p4` | `cq=21` | Plus lent (~15x) mais meilleure compression |
| Streaming low latency | `p1` | `target_bitrate=2000k` | Encode rapide |

## Limites du service

- **Upload max**: 12 GB par fichier
- **Timeout**: 7200s (2h) cote nginx, suffit pour transcode de Blu-ray
- **Concurrent jobs serveur**: 1 (la queue stocke les suivants)
- **Codecs sortie**: `h264_nvenc`, `hevc_nvenc`, `av1_nvenc`
- **Bitrate WAN**: ~860 Mbps upload, ~460 Mbps via TLS Pi (single stream)
- **Scale-to-zero**: si le service est idle >30 min, le 1er appel attend ~700ms de cold wake

## Debugging

```bash
# Voir le state du waker (container up? idle minutes?)
curl -u "$TRANSCODE_API_AUTH" https://transcode.agi-so.fr/waker/status | jq .

# Lister les jobs en cours
curl -u "$TRANSCODE_API_AUTH" https://transcode.agi-so.fr/jobs | jq '.jobs[] | {id, status, progress: .progress.percent}'

# Si un job foire et que tu veux le details
curl -u "$TRANSCODE_API_AUTH" https://transcode.agi-so.fr/jobs/<JOB_ID> | jq .error

# Cleanup manuel d'un job (libere disque cote Spark)
curl -u "$TRANSCODE_API_AUTH" -X DELETE https://transcode.agi-so.fr/jobs/<JOB_ID>

# Verbose mode (curl -v) pour debug TLS
transcode_via_api file.mkv out.mp4 --target_codec=h264_nvenc
# Si erreur SSL: ton DNS local cache peut-etre encore IP IONOS parking
# Solution: flush DNS local OU --resolve transcode.agi-so.fr:443:82.65.17.134
```

## Exemple complet de batch

```bash
#!/usr/bin/env bash
source ./transcode-api-client.sh
export TRANSCODE_API_AUTH='transcode:PWD'

INPUT_DIR=/media/torrents/Birdman/
OUTPUT_DIR=/out/

mkdir -p "$OUTPUT_DIR"
for episode in "$INPUT_DIR"*.mkv; do
    name=$(basename "$episode" .mkv)
    out="$OUTPUT_DIR$name.mp4"
    [[ -s "$out" ]] && { echo "skip $name"; continue; }
    echo "=== $name ==="
    transcode_via_api "$episode" "$out" \
        --target_height=480 \
        --preset=p1 \
        --target_bitrate=1500k \
        --audio_mode=auto
done
```

## Que faire en cas de probleme ?

1. **Test health**: `transcode_api_health` doit lister les 3 NVENC encoders
2. **Test direct curl**: `curl -u "$TRANSCODE_API_AUTH" https://transcode.agi-so.fr/`
3. **DNS**: `dig +short @8.8.8.8 transcode.agi-so.fr` doit retourner `82.65.17.134`
4. **TLS**: `echo | openssl s_client -servername transcode.agi-so.fr -connect transcode.agi-so.fr:443 2>&1 | grep -E "subject|issuer"`
5. **Si bloque**: ping Rusmir, il debug avec toi en live

Bon transcode !
