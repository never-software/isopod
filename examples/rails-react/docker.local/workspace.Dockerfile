# workspace.Dockerfile — Example development environment
#
# Base: Ubuntu 24.04 with Ruby, Node, PostgreSQL, and code-server.
# Dependencies are pre-installed via cache-hook instructions so only
# changed lockfiles trigger a reinstall. Source code is synced at runtime.
#
# Build (from repo root):
#   docker build -f docker.local/workspace.Dockerfile -t isopod-workspace .

# layer: base
FROM ubuntu:24.04 AS workspace

# layer: system-deps
RUN apt-get update -qq && apt-get install -y --no-install-recommends \
  build-essential \
  ca-certificates \
  libpq-dev \
  libyaml-dev \
  libffi-dev \
  zlib1g-dev \
  libssl-dev \
  libreadline-dev \
  autoconf \
  bison \
  git \
  curl \
  rsync \
  gpg \
  lsof \
  && rm -rf /var/lib/apt/lists/*

# layer: postgresql
RUN . /etc/os-release && \
  echo "deb http://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" > /etc/apt/sources.list.d/pgdg.list && \
  curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /etc/apt/trusted.gpg.d/pgdg.gpg && \
  apt-get update -qq && \
  apt-get install -y --no-install-recommends postgresql-17 postgresql-client-17 && \
  rm -rf /var/lib/apt/lists/*

# layer: code-server
COPY docker.local/extensions/startup-terminals/startup-terminals-1.0.0.vsix /tmp/startup-terminals.vsix
RUN curl -fsSL https://code-server.dev/install.sh | sh && \
  code-server --install-extension /tmp/startup-terminals.vsix && \
  mkdir -p /root/.local/share/code-server/User

# Postgres data directory (volume mount point)
RUN mkdir -p /pgdata && chown postgres:postgres /pgdata

# layer: ruby
RUN cd /tmp && \
  curl -fsSL https://cache.ruby-lang.org/pub/ruby/3.4/ruby-3.4.4.tar.gz | tar xz && \
  cd ruby-3.4.4 && \
  ./configure --disable-install-doc --enable-shared --disable-debug && \
  make -j$(nproc) && \
  make install && \
  cd / && rm -rf /tmp/ruby-3.4.4 && \
  ldconfig && \
  ruby --version

# layer: node
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
  apt-get install -y nodejs && \
  rm -rf /var/lib/apt/lists/* && \
  node --version

# ── Workspace directory structure ─────────────────────────────────────────
RUN mkdir -p /workspace/example-api /workspace/example-frontend
WORKDIR /workspace

# layer: gems
# ── Pre-install Ruby gems (cached layer) ──────────────────────────────────
# Copy only Gemfile + Gemfile.lock so this layer is cached until deps change.
COPY repos/example-api/Gemfile repos/example-api/Gemfile.lock /workspace/example-api/
RUN cd /workspace/example-api && bundle install --jobs=4 --retry=3 && \
  rm -rf /usr/local/bundle/cache/*.gem

# layer: node-modules
# ── Pre-install Node modules (cached layer) ───────────────────────────────
COPY repos/example-frontend/package.json repos/example-frontend/package-lock.json /workspace/example-frontend/
RUN cd /workspace/example-frontend && npm ci

# layer: startup
COPY docker.local/workspace-start.sh /usr/local/bin/workspace-start.sh
RUN chmod +x /usr/local/bin/workspace-start.sh

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD pg_isready -q || exit 1

CMD ["/usr/local/bin/workspace-start.sh"]
