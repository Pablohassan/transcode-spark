# syntax=docker/dockerfile:1.7
#
# Multi-stage Dockerfile pour transcode-service
# Cible: aarch64 (DGX Spark A, puce GB10 Grace+Blackwell)
#
# Stage 1 (builder): compile ffmpeg 7.1 avec support NVENC + libnpp + codecs courants
# Stage 2 (runtime): image legere avec ffmpeg installe + FastAPI + dependances runtime

# =====================================================================
# Stage 1: Builder
# =====================================================================
FROM nvidia/cuda:12.6.0-devel-ubuntu22.04 AS builder

ARG FFMPEG_VERSION=n7.1
ARG NV_CODEC_HEADERS_VERSION=n12.2.72.0

ENV DEBIAN_FRONTEND=noninteractive

# Build dependencies + codec libs
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    pkg-config \
    yasm \
    nasm \
    git \
    ca-certificates \
    libssl-dev \
    libnuma-dev \
    libfreetype6-dev \
    libtool \
    autoconf \
    automake \
    cmake \
    libx264-dev \
    libx265-dev \
    libvpx-dev \
    libfdk-aac-dev \
    libopus-dev \
    libmp3lame-dev \
    libvorbis-dev \
    libtheora-dev \
    libaom-dev \
    libdav1d-dev \
    libwebp-dev \
    && rm -rf /var/lib/apt/lists/*

# nv-codec-headers (interface NVENC/NVDEC pour ffmpeg)
WORKDIR /tmp
RUN git clone --depth 1 --branch ${NV_CODEC_HEADERS_VERSION} \
        https://git.videolan.org/git/ffmpeg/nv-codec-headers.git && \
    cd nv-codec-headers && \
    make install PREFIX=/usr/local && \
    cd /tmp && rm -rf nv-codec-headers

# Compile ffmpeg
WORKDIR /tmp
RUN git clone --depth 1 --branch ${FFMPEG_VERSION} \
        https://git.ffmpeg.org/ffmpeg.git ffmpeg

WORKDIR /tmp/ffmpeg
RUN ./configure \
        --prefix=/opt/ffmpeg \
        --pkg-config-flags="--static" \
        --extra-cflags="-I/usr/local/cuda/include -I/usr/local/include" \
        --extra-ldflags="-L/usr/local/cuda/lib64 -L/usr/local/lib" \
        --extra-libs="-lpthread -lm" \
        --enable-nonfree \
        --enable-gpl \
        --enable-version3 \
        --enable-cuda-nvcc \
        --enable-cuvid \
        --enable-nvdec \
        --enable-nvenc \
        --enable-libnpp \
        --enable-libx264 \
        --enable-libx265 \
        --enable-libvpx \
        --enable-libaom \
        --enable-libdav1d \
        --enable-libfdk-aac \
        --enable-libopus \
        --enable-libmp3lame \
        --enable-libvorbis \
        --enable-libtheora \
        --enable-libwebp \
        --enable-libfreetype \
        --disable-debug \
        --disable-doc \
        --disable-shared \
        --enable-static \
    && make -j"$(nproc)" \
    && make install \
    && rm -rf /tmp/ffmpeg

# =====================================================================
# Stage 2: Runtime
# =====================================================================
FROM nvidia/cuda:12.6.0-runtime-ubuntu22.04 AS runtime

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

# Runtime deps (libs dynamiques utilisees par ffmpeg statique compile en stage 1)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    libnuma1 \
    ca-certificates \
    curl \
    tini \
    && rm -rf /var/lib/apt/lists/*

# Copy ffmpeg binaries from builder
COPY --from=builder /opt/ffmpeg/bin/ffmpeg /usr/local/bin/ffmpeg
COPY --from=builder /opt/ffmpeg/bin/ffprobe /usr/local/bin/ffprobe

# Python FastAPI app
WORKDIR /app
COPY app/requirements.txt /app/requirements.txt
RUN pip3 install --no-cache-dir -r /app/requirements.txt

COPY app/ /app/

# Data volumes
RUN mkdir -p /data/incoming /data/output /data/state \
    && chown -R 1000:1000 /data

# Run as non-root user
RUN useradd -u 1000 -m -s /bin/bash transcoder && \
    chown -R transcoder:transcoder /app /data
USER transcoder

EXPOSE 8001

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8001/health || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8001", "--workers", "1"]
