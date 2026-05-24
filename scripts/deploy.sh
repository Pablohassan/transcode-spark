#!/usr/bin/env bash
# Deploy transcode-service vers Spark A via rsync, en passant par le bastion .60
#
# Usage:
#   ./scripts/deploy.sh          # rsync + reload waker si en place
#   ./scripts/deploy.sh build    # rsync + docker compose build sur le Spark
#   ./scripts/deploy.sh test     # rsync + docker compose run --rm pour test
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASTION="lazone@82.65.17.134"
SPARK="pablo@192.168.1.31"
REMOTE_DIR="/home/pablo/transcode-service"
PI_NGINX="pablito@192.168.1.200"
PI_DOC_DIR="/var/www/transcode"

ACTION="${1:-sync}"

echo "==> rsync ${REPO_DIR} -> ${SPARK}:${REMOTE_DIR}"
rsync -avz --delete \
    --exclude '.git' \
    --exclude 'data/' \
    --exclude '__pycache__' \
    --exclude '.DS_Store' \
    -e "ssh -J ${BASTION} -o ConnectTimeout=10" \
    "${REPO_DIR}/" \
    "${SPARK}:${REMOTE_DIR}/"

case "${ACTION}" in
    sync)
        echo "==> Sync docs publiques vers Pi nginx (${PI_DOC_DIR})"
        # Copie atomique via /tmp puis sudo cp (NOPASSWD configure)
        rsync -avz \
            "${REPO_DIR}/AGENTS.md" \
            "${REPO_DIR}/README.md" \
            "${REPO_DIR}/nginx/llms.txt" \
            "${REPO_DIR}/scripts/transcode-api-client.sh" \
            "${PI_NGINX}:/tmp/" 2>&1 | tail -5
        ssh "${PI_NGINX}" "sudo mkdir -p ${PI_DOC_DIR} && sudo cp /tmp/AGENTS.md /tmp/README.md /tmp/llms.txt /tmp/transcode-api-client.sh ${PI_DOC_DIR}/ && sudo chmod 644 ${PI_DOC_DIR}/*"
        echo "==> Sync done. Pour build l'image: ./scripts/deploy.sh build"
        ;;
    build)
        echo "==> docker compose build sur Spark A (ca peut prendre 15-25 min compile ffmpeg)"
        ssh -J "${BASTION}" "${SPARK}" "cd ${REMOTE_DIR} && docker compose build --progress=plain 2>&1 | tail -40"
        ;;
    test)
        echo "==> docker compose up + test endpoints"
        ssh -J "${BASTION}" "${SPARK}" "cd ${REMOTE_DIR} && docker compose up -d && sleep 15 && curl -sS http://127.0.0.1:8001/health && echo && curl -sS http://127.0.0.1:8001/codecs"
        ;;
    *)
        echo "Usage: $0 [sync|build|test]"
        exit 1
        ;;
esac
