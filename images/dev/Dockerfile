# imp dev image: images/base plus the toolchains a coding agent reaches for.
#   docker build -t imp/dev images/dev
ARG BASE=imp/base
FROM ${BASE}

ARG DEBIAN_FRONTEND=noninteractive
ARG NODE_MAJOR=24
# Empty means the current stable release from go.dev.
ARG GO_VERSION=

# build-essential: native npm modules and Python wheels without a binary
# build need a compiler. docker-compose-plugin: dev stacks use compose.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential pkg-config python3 python3-pip python3-venv python-is-python3 \
      unzip xz-utils jq docker-compose-plugin \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/*.bin /var/log/apt /var/log/dpkg.log

# Node LTS from nodejs.org (npm and corepack come with it).
RUN v=$(curl -fsSL https://nodejs.org/dist/index.json \
        | jq -r --arg m "v${NODE_MAJOR}." '[.[] | select(.version | startswith($m))][0].version') \
 && curl -fsSL "https://nodejs.org/dist/${v}/node-${v}-linux-x64.tar.xz" \
      | tar -xJ -C /usr/local --strip-components=1 --exclude='*.md' --exclude=LICENSE \
 && node --version && npm --version

# Go from go.dev.
RUN v=${GO_VERSION:-$(curl -fsSL 'https://go.dev/VERSION?m=text' | head -1)} \
 && curl -fsSL "https://go.dev/dl/${v}.linux-amd64.tar.gz" | tar -xz -C /usr/local \
 && /usr/local/go/bin/go version

# Bun and uv from their official images.
COPY --from=oven/bun:1 /usr/local/bin/bun /usr/local/bin/bun
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/
RUN ln -s bun /usr/local/bin/bunx && bun --version && uv --version

# Claude Code, native installer (installs for root under ~/.local).
RUN curl -fsSL https://claude.ai/install.sh | bash \
 && /root/.local/bin/claude --version

ENV PATH=/root/.local/bin:/root/go/bin:/usr/local/go/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
