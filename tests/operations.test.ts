import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetController } from "../packages/core/src";
import { operationsView, trainingSummary } from "../apps/server/src/operations";
import type { Observation } from "../packages/contracts/src";

test("operational view separates unobserved stock, stale stock and foreign world evidence without changing execution state", () => {
  const core = new FleetController({
      send() {},
      controllerEpoch: "ops",
      now: () => 100000,
      rules: {
        world: "village",
        autonomyEnabled: false,
        warehouse: {
          id: "chest",
          world: "village",
          dimension: "overworld",
          position: { x: 0, y: 64, z: 0 },
        },
      },
    }),
    s = core.getSnapshot(),
    model = { status: "unconfigured" as const, checkedAt: 0 };
  const first = operationsView(s, model, [], 100000);
  assert.equal(first.stock.bread, null);
  assert.equal(first.stock.stale, true);
  const obs = {
    id: "stock",
    controllerEpoch: "ops",
    observedAt: 60000,
    receivedAt: 60000,
    botId: "bot",
    sessionId: "session",
    world: "village",
    dimension: "overworld",
    kind: "container",
    data: {
      container: s.rules.warehouse!,
      items: [{ name: "bread", count: 3 }],
    },
  } as Observation;
  s.observations = [
    obs,
    {
      ...obs,
      id: "foreign",
      world: "other",
      observedAt: 100000,
      data: { ...obs.data, items: [{ name: "bread", count: 99 }] },
    } as Observation,
  ];
  const before = JSON.stringify(s),
    view = operationsView(s, model, [], 100000);
  assert.equal(view.stock.bread, 3);
  assert.equal(view.stock.stale, true);
  assert.equal(JSON.stringify(s), before);
});
test("training view shows actual optimizer progress separately from deployment approval and hides raw paths/data", () => {
  const root = mkdtempSync(join(tmpdir(), "laya-ops-"));
  const reports = join(root, "reports"),
    runs = join(root, "runs");
  mkdirSync(reports);
  mkdirSync(runs);
  try {
    const run = join(runs, "qwen35-base-v7-20261016");
    mkdirSync(run);
    writeFileSync(
      join(run, "progress.jsonl"),
      "broken partial line\n" +
        JSON.stringify({ step: 4, total_steps: 10 }) +
        "\n",
    );
    writeFileSync(
      join(run, "manifest.json"),
      JSON.stringify({
        counts: { train: 64 },
        adapter: "/private/checkpoints",
        raw: "private gameplay",
      }),
    );
    const progress = trainingSummary(reports, runs);
    assert.equal(progress[0]!.state, "training");
    assert.equal(progress[0]!.step, 4);
    assert.equal(progress[0]!.broadApproved, null);
    assert.ok(!JSON.stringify(progress).includes("/private"));
    writeFileSync(
      join(run, "training.json"),
      JSON.stringify({ optimizer_steps: 10 }),
    );
    assert.equal(trainingSummary(reports, runs)[0]!.state, "evaluating");
    writeFileSync(
      join(reports, "v7.json"),
      JSON.stringify({
        model: "qwen35-base-v7-20261016",
        optimizerSteps: 10,
        trainRows: 64,
        canonicalProfileApproved: true,
        canonicalProfile: "canonical-base-v1",
        broadEvaluationApproved: false,
        canonicalEvaluation: {
          "qwen35-base-v7-20261016": { correct: 24, total: 24, illegal: 0 },
        },
      }),
    );
    const evaluated = trainingSummary(reports, runs)[0]!;
    assert.equal(evaluated.state, "qualified");
    assert.equal(evaluated.broadApproved, false);
    assert.equal(evaluated.correct, 24);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("last actual warehouse result remains visible after rolling samples expire or reconnect, without becoming fresh execution evidence",()=>{
 const core=new FleetController({send(){},controllerEpoch:'current',rules:{world:'village',autonomyEnabled:false,warehouse:{id:'base',world:'village',dimension:'overworld',position:{x:1,y:64,z:1}}}}),s=core.getSnapshot(),model={status:'unconfigured' as const,checkedAt:0};
 const observation={id:'last-stock',observedAt:99000,world:'village',dimension:'overworld',kind:'container' as const,data:{container:s.rules.warehouse!,items:[{name:'bread',count:3}]}};
 s.attempts=[{id:'old-attempt',taskId:'old-task',botId:'bot',sessionId:'old-session',controllerEpoch:'previous',reason:'initial',state:'completed',assignedAt:98000,startedAt:98000,finishedAt:99500,result:{outcome:'completed',observations:[observation],evidence:[],checkpoint:{}}}];
 const before=JSON.stringify(s),v=operationsView(s,model,[],100000);assert.equal(v.stock.bread,3);assert.equal(v.stock.observedAt,99000);assert.equal(v.stock.stale,true,'previous connection must remain marked stale even with a recent timestamp');assert.equal(JSON.stringify(s),before);assert.equal(s.observations.length,0,'history is not injected into fresh verification');
 s.attempts[0]!.result!.observations.push({...observation,id:'foreign',observedAt:99999,world:'other',data:{...observation.data,items:[{name:'bread',count:99}]}});assert.equal(operationsView(s,model,[],100000).stock.bread,3);
 s.observations=[{...observation,id:'fresh',controllerEpoch:'current',botId:'bot',sessionId:'current',receivedAt:100000,observedAt:100000,data:{...observation.data,items:[{name:'bread',count:0}]}}];const fresh=operationsView(s,model,[],100000);assert.equal(fresh.stock.bread,0);assert.equal(fresh.stock.stale,false,'a new actual empty chest replaces historical stock');
 s.rules.warehouse={...s.rules.warehouse!,id:'new-base',position:{x:20,y:64,z:20}};assert.equal(operationsView(s,model,[],100000).stock.bread,null,'history cannot follow a different warehouse');
});
