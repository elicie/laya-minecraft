#!/usr/bin/env bash
set -euo pipefail
cd /home/elicie/Dev/minecraft
export OMP_NUM_THREADS=4 PYTHONUNBUFFERED=1
exec .venv/bin/python training/run.py "$@"
