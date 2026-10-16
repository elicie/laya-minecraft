#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
python3 -m venv .venv-qwen
# Share installed CUDA/PyTorch wheels, without installing into or editing that environment.
QWEN_SHARED_SITE_PACKAGES="${QWEN_SHARED_SITE_PACKAGES:-/home/elicie/.venvs/comfyui/lib/python3.12/site-packages}" .venv-qwen/bin/python - <<'PY'
import os
import sysconfig
from pathlib import Path
shared = Path(os.environ['QWEN_SHARED_SITE_PACKAGES'])
if not shared.is_dir():
    raise SystemExit('Set QWEN_SHARED_SITE_PACKAGES to the existing torch/transformers site-packages')
(Path(sysconfig.get_paths()['purelib'])/'shared-torch-transformers.pth').write_text(str(shared)+'\n')
PY
.venv-qwen/bin/python -m pip install -r training/qwen-decision/requirements.txt
.venv-qwen/bin/python training/qwen-decision/download.py
