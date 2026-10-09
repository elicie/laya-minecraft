#!/usr/bin/env bash
set -euo pipefail
cd /home/elicie/Dev/minecraft
export PATH=/home/elicie/tools/node22/bin:$PATH
exec node --env-file-if-exists=.env bot.js "$@"
