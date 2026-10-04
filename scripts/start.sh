#!/usr/bin/env bash
# Sets up whatever is missing, then starts the simulator's server.
#
#   npm start                    # from the repository folder
#   npm start -- --port 8080     # extra arguments go to Vite
#
# Safe to run every time: each step is skipped when it is already done. It
# installs the Node packages, creates .venv with the Python packages the AI
# agent needs (.venv is git-ignored, so a fresh clone or pull never has it),
# and checks that sign-in is configured.
set -euo pipefail

cd "$(dirname "$0")/.."

say() { printf '\033[1m[iressa]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[iressa]\033[0m %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null || die "Node.js is not installed. Install Node 20 or newer, then run this again."
command -v npm >/dev/null || die "npm is not installed. It ships with Node.js."

# --- Node packages ----------------------------------------------------------
if [ ! -x node_modules/.bin/vite ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  say "Installing Node packages"
  npm ci
fi

# --- Python environment for the AI agent ------------------------------------
PYTHON="${IRESSA_PYTHON:-}"
if [ -n "$PYTHON" ]; then
  "$PYTHON" -c 'import numpy' 2>/dev/null || die "IRESSA_PYTHON ($PYTHON) cannot import numpy."
else
  if [ ! -x .venv/bin/python ]; then
    command -v python3 >/dev/null || die "python3 is not installed. Install Python 3.10 or newer, then run this again."
    say "Creating the Python environment in .venv"
    python3 -m venv .venv || die "Could not create .venv. On Debian or Ubuntu: sudo apt install python3-venv"
  fi
  if ! .venv/bin/python -c 'import numpy, matplotlib' 2>/dev/null; then
    say "Installing Python packages"
    .venv/bin/python -m pip install --quiet --upgrade pip
    .venv/bin/python -m pip install --quiet -r requirements.txt
  fi
  .venv/bin/python -c 'import numpy' || die "numpy still cannot be imported from .venv. Delete .venv and run this again."
fi

# --- Sign-in settings -------------------------------------------------------
if [ ! -f .env.local ] && [ ! -f .env ]; then
  say "No .env.local found: the simulator will show a configuration notice instead of sign-in."
  say "Copy .env.example to .env.local and fill it in (docs/research-access.md)."
fi

say "Starting the server"
exec node_modules/.bin/vite "$@"
