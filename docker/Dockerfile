# syntax=docker/dockerfile:1.7
#
# Multi-stage Dockerfile pour transcode-service
# Cible: aarch64 (DGX Spark A, puce GB10 Grace+Blackwell)
#
# Stage 1 (builder): compile ffmpeg 7.1 statique avec NVENC + libnpp + codecs courants
# Stage 2 (runtime): image legere avec ffmpeg + Bun + Hono app

# =====================================================================
# Stage 1: Builder ffmpeg
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
# Stage 2: Runtime - Bun + Hono + ffmpeg
# =====================================================================
FROM nvidia/cuda:12.6.0-runtime-ubuntu22.04 AS runtime

ENV DEBIAN_FRONTEND=noninteractive

# Runtime deps:
# - libs dynamiques utilisees par le binaire ffmpeg compile en stage 1
#   (ffmpeg --enable-static rend les libs internes statiques mais reste linke
#    dynamiquement aux codecs externes libvpx/libaom/libfreetype/etc.)
# - curl pour healthcheck
# - unzip pour installer Bun
# - tini comme init proper (zombie reaping)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnuma1 \
    libfreetype6 \
    libvpx7 \
    libwebp7 \
    libwebpmux3 \
    libdav1d5 \
    libaom3 \
    libfdk-aac2 \
    libmp3lame0 \
    libopus0 \
    libtheora0 \
    libvorbis0a \
    libvorbisenc2 \
    libx264-163 \
    libx265-199 \
    libssl3 \
    ca-certificates \
    curl \
    unzip \
    tini \
    && rm -rf /var/lib/apt/lists/*

# Copy ffmpeg binaries from builder
COPY --from=builder /opt/ffmpeg/bin/ffmpeg /usr/local/bin/ffmpeg
COPY --from=builder /opt/ffmpeg/bin/ffprobe /usr/local/bin/ffprobe

# Install Bun (single binary aarch64)
ARG BUN_VERSION=1.1.42
RUN curl -fL -o /tmp/bun.zip \
        "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-aarch64.zip" \
    && cd /tmp && unzip -q bun.zip \
    && mv bun-linux-aarch64/bun /usr/local/bin/bun \
    && chmod +x /usr/local/bin/bun \
    && rm -rf /tmp/bun* \
    && bun --version

# Hono app dependencies
WORKDIR /app
COPY app/package.json ./
# Note: pas de bun.lockb au premier build - bun install sans --frozen-lockfile
RUN bun install --production

# App source code
COPY app/tsconfig.json ./
COPY app/src ./src

# Data volumes
RUN mkdir -p /data/incoming /data/output /data/state

# Run as non-root user (UID 1000 pour matcher pablo sur host)
RUN useradd -u 1000 -m -s /bin/bash transcoder \
    && chown -R transcoder:transcoder /app /data
USER transcoder

EXPOSE 8001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8001/health || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bun", "run", "src/main.ts"]
