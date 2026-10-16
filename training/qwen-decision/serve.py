"""Local serialized GPU decision endpoint. Does not execute Minecraft actions."""
import argparse
import json
import hashlib
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import torch
from peft import PeftModel
from transformers import AutoTokenizer
from transformers.utils import logging
from common import ROOT, load_base, predict, read_json, score
from question_contract import CANONICAL_BASE_PROFILE, NORMALIZED_BASE_PROFILE, inference_question, remap_answer


def prepare_inference_base(base):
    """Match the final training dtypes without materializing FP32 vocabulary tables."""
    keep_bf16 = {id(parameter) for module in (base.get_input_embeddings(), base.get_output_embeddings())
                 for parameter in module.parameters()}
    with torch.no_grad():
        for parameter in base.parameters():
            parameter.requires_grad_(False)
            if (id(parameter) not in keep_bf16 and parameter.dtype in (torch.float16, torch.bfloat16)
                    and parameter.__class__.__name__ != 'Params4bit'):
                parameter.data = parameter.data.to(torch.float32)
    return base


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--adapter', required=True)
    parser.add_argument('--port', type=int, default=8085)
    args = parser.parse_args()
    adapter = Path(args.adapter).resolve()
    config = read_json(adapter/'decision-config.json')
    if config.get('evaluation_pending') or config.get('deployment_approved') is False:
        raise ValueError('Adapter has not passed its held-out deployment evaluation')
    if config.get('deployment_profile') == CANONICAL_BASE_PROFILE:
        proof = (adapter/'canonical-profile-report.json').read_bytes()
        report = json.loads(proof)
        if (hashlib.sha256(proof).hexdigest() != config.get('canonical_profile_report_sha256')
                or report.get('deployment_approved') is not True
                or report.get('deployment_profile') != CANONICAL_BASE_PROFILE
                or report.get('adapter_sha256') != config.get('adapter_sha256')
                or hashlib.sha256((adapter/'adapter_model.safetensors').read_bytes()).hexdigest() != report['adapter_sha256']):
            raise ValueError('Canonical deployment qualification does not match these weights')
    torch.set_num_threads(6)
    logging.disable_progress_bar()
    if config.get('deployment_profile') == NORMALIZED_BASE_PROFILE:
        proof = (adapter/'normalized-profile-report.json').read_bytes()
        report = json.loads(proof)
        if (hashlib.sha256(proof).hexdigest() != config.get('normalized_profile_report_sha256')
                or report.get('deployment_approved') is not True
                or report.get('adapter_sha256') != config.get('adapter_sha256')
                or report.get('deployment_profile') != NORMALIZED_BASE_PROFILE):
            raise ValueError('Normalized profile qualification differs from deployed weights')
    tokenizer = AutoTokenizer.from_pretrained(str(adapter), padding_side='left')
    base = prepare_inference_base(load_base())
    model = PeftModel.from_pretrained(base, str(adapter)).eval()
    # Release temporary checkpoint-loading allocations before accepting requests.
    torch.cuda.empty_cache()
    lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def reply(self, status, payload):
            body = json.dumps(payload, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def do_GET(self):
            if self.path != '/health':
                return self.reply(404, {'error': 'Unknown endpoint'})
            self.reply(200, {'status': 'ready', 'model': config['name'], 'base': config['base'], 'adapter': str(adapter), 'deployment_profile': config.get('deployment_profile')})

        def do_POST(self):
            if self.path != '/api/decide':
                return self.reply(404, {'error': 'Unknown endpoint'})
            try:
                length = int(self.headers.get('Content-Length', '0'))
                if not 0 < length <= 32768:
                    return self.reply(413, {'error': 'Request size outside bounds'})
                value = json.loads(self.rfile.read(length))
                if not isinstance(value, dict):
                    raise ValueError('Request must be an object')
                task, state = value.get('task'), value.get('state')
                if task not in config['questions'] or not isinstance(state, str) or not state.strip() or len(state) > 6000:
                    raise ValueError('Invalid task or observation')
                supplied = value.get('questions')
                question, aliases = inference_question(task, supplied, config)
                # One model call at a time; callers fall back promptly under contention.
                if not lock.acquire(blocking=False):
                    return self.reply(503, {'error': 'Decision model busy'})
                try:
                    started = time.perf_counter()
                    values, tokens = score(model, tokenizer, task, state, question)
                    answer = remap_answer(predict(values, task, question, config['temperatures'][task]['temperature']), aliases)
                    answer['type'] = 'choice'
                    self.reply(200, {'model': config['name'], 'backend': 'qwen', 'base': config['base'],
                                     'answers': {task: answer}, 'calibrated': True, 'state_truncated': False,
                                     'usage': {'tokens': tokens, 'truncated': False},
                                     'latency_ms': round((time.perf_counter()-started)*1000, 2)})
                finally:
                    lock.release()
            except (ValueError, TypeError, KeyError) as error:
                self.reply(400, {'error': str(error)})
            except Exception as error:
                print('INFERENCE ERROR', str(error), flush=True)
                self.reply(500, {'error': 'Decision inference failed'})

    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    server.daemon_threads = True
    print('READY', args.port, config['name'], flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
