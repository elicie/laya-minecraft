"""Download the pinned official model revision; no third-party source patches."""
from huggingface_hub import snapshot_download
from common import BASE, MODEL_ID, REVISION

if __name__ == '__main__':
    print(snapshot_download(MODEL_ID, revision=REVISION, local_dir=str(BASE),
                            allow_patterns=['*.safetensors','*.json','*.txt','*.jinja','LICENSE'], max_workers=4))
