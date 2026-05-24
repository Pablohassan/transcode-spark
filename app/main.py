"""
transcode-service — FastAPI app tournant dans le container Docker.
Expose les endpoints de transcodage video utilisant ffmpeg + NVENC sur GPU GB10.

Cette version initiale (placeholder) fournit juste /health pour permettre le build
+ healthcheck Docker. Le vrai code metier (jobs, transcode, queue) viendra ensuite.
"""
from fastapi import FastAPI
import os
import shutil
import subprocess

app = FastAPI(title="transcode-service", version="0.1.0")


@app.get("/health")
def health():
    """Healthcheck utilise par Docker HEALTHCHECK et par le waker."""
    return {"status": "ok", "version": "0.1.0"}


@app.get("/codecs")
def codecs():
    """Liste des encoders disponibles dans ffmpeg (introspection)."""
    ffmpeg_path = shutil.which("ffmpeg")
    if not ffmpeg_path:
        return {"error": "ffmpeg not found"}

    try:
        result = subprocess.run(
            [ffmpeg_path, "-hide_banner", "-encoders"],
            capture_output=True, text=True, timeout=5,
        )
        nvenc_encoders = [
            line.strip() for line in result.stdout.splitlines()
            if "nvenc" in line.lower()
        ]
        return {
            "ffmpeg_version_check": result.returncode == 0,
            "nvenc_encoders": nvenc_encoders,
        }
    except Exception as e:
        return {"error": str(e)}


@app.get("/")
def root():
    return {
        "service": "transcode-service",
        "version": "0.1.0",
        "note": "placeholder - endpoints jobs viennent ensuite",
        "endpoints": ["/health", "/codecs"],
    }
