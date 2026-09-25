#!/bin/bash
# Provisions tooling that agent sessions on this repo rely on: the
# mattpocock/skills bundle (wayfinder, grilling, domain-modeling, ...) and
# the GitHub CLI. Safe to re-run; only touches things that are missing or
# out of date.
set -euo pipefail

# Local dev machines set this up themselves; only web sessions need it.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# --- Agent skills -----------------------------------------------------
# The `skills` CLI version is pinned via package.json. It always installs
# the current HEAD of mattpocock/skills (the CLI has no documented flag to
# pin an upstream ref) — skills-lock.json records the hashes actually
# installed, so `git diff skills-lock.json` after a run shows any drift.
# Use explicit --skill/--agent rather than --all: --all expands to
# `--agent '*'`, which overrides the narrower flag and fans the install out
# to every agent target the CLI knows about, leaving a stray ./agent/ dir.
npm install --no-audit --no-fund
npx skills add mattpocock/skills --skill '*' --agent claude-code -y

# --- GitHub CLI ---------------------------------------------------------
# There is no official npm package for the real `gh` binary — the "gh"
# package on the npm registry is an unrelated third-party tool (nodegh)
# with a different command surface, and installing it as `gh` would break
# every `gh api ...` call silently. Pin a specific release instead and
# verify it against GitHub's published checksums before trusting it.
GH_VERSION="2.63.2"
GH_BIN_DIR="$HOME/.local/bin"
GH_RELEASE_BASE="https://github.com/cli/cli/releases/download/v${GH_VERSION}"

installed_gh_version="$(gh --version 2>/dev/null | head -1 | awk '{print $3}' || true)"
if [ "$installed_gh_version" != "$GH_VERSION" ]; then
  arch="$(uname -m)"
  case "$arch" in
    x86_64) gh_arch="amd64" ;;
    aarch64) gh_arch="arm64" ;;
    *) gh_arch="" ;;
  esac

  if [ -n "$gh_arch" ]; then
    tmp="$(mktemp -d)"
    tarball="gh_${GH_VERSION}_linux_${gh_arch}.tar.gz"
    curl -fsSL -o "$tmp/checksums.txt" "${GH_RELEASE_BASE}/gh_${GH_VERSION}_checksums.txt"
    curl -fsSL -o "$tmp/$tarball" "${GH_RELEASE_BASE}/${tarball}"
    ( cd "$tmp" && grep " ${tarball}\$" checksums.txt | sha256sum -c - )
    tar -xzf "$tmp/$tarball" -C "$tmp"
    mkdir -p "$GH_BIN_DIR"
    cp "$tmp/gh_${GH_VERSION}_linux_${gh_arch}/bin/gh" "$GH_BIN_DIR/gh"
    chmod +x "$GH_BIN_DIR/gh"
    rm -rf "$tmp"
  else
    echo "session-start: unsupported arch '$arch' for pinned gh $GH_VERSION, skipping gh install" >&2
  fi
fi

case ":$PATH:" in
  *":$GH_BIN_DIR:"*) ;;
  *)
    if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
      echo "export PATH=\"$GH_BIN_DIR:\$PATH\"" >> "$CLAUDE_ENV_FILE"
    fi
    ;;
esac
