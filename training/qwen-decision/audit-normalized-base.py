"""Paired scoped API audit; preserve raw model evaluation as a separate result.
Only already audited instructions/descriptions are normalized to the canonical
question. Observation text and all twelve logits are retained, without masking
illegal actions. Old failed examples are regression tests, never fresh evidence.
"""
import argparse,json,hashlib,copy,time
import torch
from transformers import AutoTokenizer
from peft import PeftModel
from common import ROOT,BASE,read_json,write_json,load_base
from train import evaluate,summarize,load_rows
from serve import prepare_inference_base
from question_contract import NORMALIZED_BASE_PROFILE,inference_question

p=argparse.ArgumentParser();p.add_argument('--name',required=True);a=p.parse_args();torch.set_num_threads(6)
run=ROOT/'training/runs'/a.name;manifest=read_json(run/'manifest.json');adapter=ROOT/'checkpoints'/a.name
policy=read_json(run/'normalized-profile-policy.json');raw=read_json(run/'report.json');trained=read_json(run/'training.json');config=read_json(adapter/'decision-config.json')
assert not (run/'normalized-profile-report.json').exists()
assert hashlib.sha256((adapter/'adapter_model.safetensors').read_bytes()).hexdigest()==trained['adapter_sha256']
questions=manifest['questions'];profile={**config,'deployment_profile':NORMALIZED_BASE_PROFILE}
rows=load_rows(run,'eval',manifest);fresh=[r for r in rows if r['task']=='base_action'];known=[r for r in map(json.loads,(ROOT/'training/runs/qwen35-base-v6-20261016/eval.jsonl').read_text().splitlines()) if r['task']=='base_action']
assert len({r.get('original_id',r['id']) for r in fresh})==24
assert not {r.get('episode_id') for r in fresh}&{r.get('episode_id') for r in map(json.loads,(run/'train.jsonl').read_text().splitlines()) if r['task']=='base_action'}
def normalized(group):
 out=[]
 for row in group:
  source={row['task']:row.get('question',questions[row['task']])};q,aliases=inference_question(row['task'],source,profile)
  out.append({**row,'question':q[row['task']],'option_actions':list(q[row['task']]['criteria'])})
 return out
fresh_n=normalized(fresh);known_n=normalized(known)
tokenizer=AutoTokenizer.from_pretrained(str(BASE),padding_side='left');tokenizer.pad_token=tokenizer.pad_token or tokenizer.eos_token
model=PeftModel.from_pretrained(prepare_inference_base(load_base()),manifest['parent_adapter']).eval();started=time.perf_counter()
before=evaluate(model,tokenizer,fresh_n,questions,4,'PARENT NORMALIZED FRESH')
model.load_adapter(str(adapter),adapter_name='new',is_trainable=False);model.set_adapter('new')
after=evaluate(model,tokenizer,fresh_n,questions,4,'CANDIDATE NORMALIZED FRESH')
known_after=evaluate(model,tokenizer,known_n,questions,4,'KNOWN REGRESSION NORMALIZED')
# Raw regression is independent of the input-normalized serving qualification.
known_raw=evaluate(model,tokenizer,known,questions,4,'KNOWN REGRESSION RAW')
bs,ns,ks,kr=map(lambda r:summarize(r)['all'],[before,after,known_after,known_raw])
legacy_before=raw['before']['all'];old_legacy=[r for r in read_json(run/'before.json')['results'] if r['task']!='base_action'];new_legacy=[r for r in read_json(run/'after.json')['results'] if r['task']!='base_action'];old_s=summarize(old_legacy)['all'];new_s=summarize(new_legacy)['all']
approved=(ns['illegal']==0 and ns['accuracy']>=bs['accuracy'] and ks['illegal']==0 and new_s['illegal']<=old_s['illegal'] and new_s['accuracy']>=old_s['accuracy']-.01)
report={'deployment_profile':NORMALIZED_BASE_PROFILE,'deployment_approved':approved,'adapter_sha256':trained['adapter_sha256'],'policy':policy,'fresh_before':bs,'fresh_after':ns,'fresh_controlled_originals':24,'fresh_production_originals':0,'fresh_variants':len(fresh)-24,'known_regression_normalized':ks,'known_regression_raw':kr,'legacy_before':old_s,'legacy_after':new_s,'raw_fresh_base':raw['after']['base_action'],'raw_fresh_approved':raw['deployment_approved'],'raw_report_preserved':True,'raw_model_accuracy_gain_over_parent':raw['after']['base_action']['accuracy']-raw['before']['base_action']['accuracy'],'normalization_is_code_not_weight_training':True,'note':'Scope covers only validated equivalent descriptions/instructions and order/key variants. It does not accept arbitrary natural-language questions. Fresh controlled evaluation and known regressions are reported separately; no illegal class logits are hidden.','seconds':round(time.perf_counter()-started,1)}
write_json(run/'normalized-profile-results.json',{'before':before,'after':after,'known_after':known_after,'known_raw':known_raw});write_json(run/'normalized-profile-report.json',report);write_json(adapter/'normalized-profile-report.json',report)
if approved:
 config.update(deployment_approved=True,evaluation_pending=False,deployment_profile=NORMALIZED_BASE_PROFILE,normalized_profile_report_sha256=hashlib.sha256((adapter/'normalized-profile-report.json').read_bytes()).hexdigest(),broader_raw_evaluation_approved=raw['deployment_approved']);write_json(adapter/'decision-config.json',config)
print(json.dumps(report,ensure_ascii=False),flush=True)
