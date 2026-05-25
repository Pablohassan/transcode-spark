#!/usr/bin/env bash
# transcode-api-client.sh - Wrapper bash pour transcode.agi-so.fr
#
# Sourcez ce fichier dans votre script pour exposer la fonction:
#   transcode_via_api <input_file> <output_file> [--key=value]...
#
# Variables d'environnement requises:
#   TRANSCODE_API_URL    Defaut: https://transcode.agi-so.fr
#   TRANSCODE_API_AUTH   user:password Basic Auth (obligatoire)
#
# Variables optionnelles:
#   TRANSCODE_POLL_SECS  Intervalle de poll en secondes (defaut: 2)
#   TRANSCODE_MAX_WAIT   Timeout total en secondes (defaut: 7200)
#
# Usage example dans votre script:
#   #!/usr/bin/env bash
#   source /path/to/transcode-api-client.sh
#   export TRANSCODE_API_AUTH='transcode:VOTRE_PASSWORD'
#
#   transcode_via_api input.mkv output.mp4 \
#       --target_codec=h264_nvenc \
#       --target_height=720 \
#       --preset=p1 \
#       --target_bitrate=2000k \
#       --audio_mode=auto
#
# Exit code:
#   0 = success (output_file ecrit)
#   1 = error config (URL/AUTH manquant, fichier introuvable)
#   2 = upload echec
#   3 = transcode echec cote serveur
#   4 = download echec
#   5 = timeout

set -o pipefail

# Defaults
: "${TRANSCODE_API_URL:=https://transcode.agi-so.fr}"
: "${TRANSCODE_POLL_SECS:=2}"
: "${TRANSCODE_MAX_WAIT:=7200}"

# Internal: curl with auth. Force HTTP/1.1 pour eviter le piege HTTP/2:
# multiplexing sur 1 connexion TCP + INITIAL_WINDOW_SIZE 64KB cap le throughput
# upload a ~55 Mbps/stream (vs ~88 Mbps en HTTP/1.1 4 connexions distinctes,
# mesure 2026-05-25: gain x7.8 sur upload concurrent).
_transcode_curl() {
    if [[ -z "${TRANSCODE_API_AUTH:-}" ]]; then
        echo "transcode-api-client: TRANSCODE_API_AUTH not set (format: user:password)" >&2
        return 1
    fi
    curl --http1.1 --silent --show-error -u "$TRANSCODE_API_AUTH" "$@"
}

# Verifie que le service est joignable + retourne les codecs dispo
transcode_api_health() {
    local response
    response=$(_transcode_curl --max-time 10 "${TRANSCODE_API_URL}/codecs") || return 1
    echo "$response" | jq -r '.nvenc_encoders[]' 2>/dev/null
}

# Cleanup d'un job (kill + delete files cote serveur)
transcode_api_delete_job() {
    local job_id=$1
    _transcode_curl --max-time 10 -X DELETE "${TRANSCODE_API_URL}/jobs/${job_id}" > /dev/null 2>&1
}

# Fonction principale: upload + poll + download
# Args:
#   $1            input file (path)
#   $2            output file (path)
#   $3..$N        --key=value pairs forwardes en multipart fields
#                 (target_codec, target_height, preset, cq, target_bitrate,
#                  audio_mode, audio_bitrate, audio_stream)
transcode_via_api() {
    local input=$1
    local output=$2
    shift 2

    if [[ -z "$input" || -z "$output" ]]; then
        echo "Usage: transcode_via_api <input_file> <output_file> [--key=value]..." >&2
        return 1
    fi
    if [[ ! -f "$input" ]]; then
        echo "transcode_via_api: input file not found: $input" >&2
        return 1
    fi
    if [[ -z "${TRANSCODE_API_AUTH:-}" ]]; then
        echo "transcode_via_api: TRANSCODE_API_AUTH not set (format: user:password)" >&2
        return 1
    fi

    # Build -F args from --key=value
    local curl_args=()
    for arg in "$@"; do
        if [[ "$arg" == --* ]]; then
            curl_args+=("-F" "${arg#--}")
        fi
    done

    local input_size
    input_size=$(stat -c%s "$input" 2>/dev/null || stat -f%z "$input" 2>/dev/null || echo "?")
    echo "  [transcode-api] upload $input ($input_size bytes) -> $TRANSCODE_API_URL/jobs"

    # POST /jobs (multipart streaming - curl gere ca nativement avec -F)
    local response
    response=$(_transcode_curl --max-time "$TRANSCODE_MAX_WAIT" \
        -X POST \
        -F "file=@${input}" \
        "${curl_args[@]}" \
        "${TRANSCODE_API_URL}/jobs") || {
        echo "transcode_via_api: POST /jobs failed" >&2
        return 2
    }

    local job_id status
    job_id=$(echo "$response" | jq -r '.id // empty')
    status=$(echo "$response" | jq -r '.status // "unknown"')

    if [[ -z "$job_id" ]]; then
        echo "transcode_via_api: server response missing job id:" >&2
        echo "$response" | head -c 500 >&2
        return 2
    fi

    echo "  [transcode-api] job=$job_id status=$status"

    # Poll
    local start_time=$(date +%s)
    local last_pct=0
    while true; do
        local now=$(date +%s)
        if (( now - start_time > TRANSCODE_MAX_WAIT )); then
            echo "transcode_via_api: timeout (>${TRANSCODE_MAX_WAIT}s)" >&2
            transcode_api_delete_job "$job_id"
            return 5
        fi

        local job_state
        job_state=$(_transcode_curl --max-time 10 "${TRANSCODE_API_URL}/jobs/${job_id}") || {
            echo "transcode_via_api: poll failed, retry..." >&2
            sleep "$TRANSCODE_POLL_SECS"
            continue
        }

        status=$(echo "$job_state" | jq -r '.status // "unknown"')
        local pct
        pct=$(echo "$job_state" | jq -r '.progress.percent // 0')

        if [[ "$pct" != "$last_pct" ]]; then
            local fps speed
            fps=$(echo "$job_state" | jq -r '.progress.fps // 0')
            speed=$(echo "$job_state" | jq -r '.progress.speed // "-"')
            echo "  [transcode-api] progress=${pct}% fps=${fps} speed=${speed}"
            last_pct=$pct
        fi

        if [[ "$status" == "done" ]]; then
            break
        elif [[ "$status" == "failed" ]]; then
            local err
            err=$(echo "$job_state" | jq -r '.error // "no error message"')
            echo "transcode_via_api: server reported failure: $err" >&2
            transcode_api_delete_job "$job_id"
            return 3
        fi

        sleep "$TRANSCODE_POLL_SECS"
    done

    # Download
    echo "  [transcode-api] downloading output -> $output"
    _transcode_curl --max-time "$TRANSCODE_MAX_WAIT" \
        -o "$output" \
        "${TRANSCODE_API_URL}/jobs/${job_id}/output" || {
        echo "transcode_via_api: download failed" >&2
        transcode_api_delete_job "$job_id"
        return 4
    }

    # Verify output is non-empty
    if [[ ! -s "$output" ]]; then
        echo "transcode_via_api: downloaded output is empty" >&2
        rm -f "$output"
        transcode_api_delete_job "$job_id"
        return 4
    fi

    # Cleanup server-side (libere disque du Spark)
    transcode_api_delete_job "$job_id"

    local out_size
    out_size=$(stat -c%s "$output" 2>/dev/null || stat -f%z "$output" 2>/dev/null || echo "?")
    local elapsed=$(( $(date +%s) - start_time ))
    echo "  [transcode-api] done: $output ($out_size bytes) en ${elapsed}s"

    return 0
}

# Si execute directement (pas source), test minimal
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    if [[ -z "${TRANSCODE_API_AUTH:-}" ]]; then
        echo "ERREUR: export TRANSCODE_API_AUTH='transcode:PASSWORD' avant d'utiliser ce script"
        echo
        echo "Usage:"
        echo "  source $0"
        echo "  transcode_via_api input.mkv output.mp4 --target_height=720 --preset=p1 --target_bitrate=2000k"
        echo
        echo "Test rapide health:"
        echo "  TRANSCODE_API_AUTH='transcode:PASSWORD' $0 --health"
        exit 1
    fi

    case "${1:-}" in
        --health)
            echo "GET ${TRANSCODE_API_URL}/codecs"
            transcode_api_health
            ;;
        *)
            echo "Sourcez ce fichier puis appelez transcode_via_api"
            exit 0
            ;;
    esac
fi
