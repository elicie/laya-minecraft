import { z } from 'zod';

export interface ChoiceCandidate { id: string; description: string; }
export interface ModelChoice { id: string; source: 'laya' | 'code'; reason: string; confidence?: number; model?: string; }
const answerSchema = z.object({ choice: z.string(), confidence: z.number().min(0).max(1).optional(), probabilities: z.record(z.string(), z.number()).optional() });
const responseSchema = z.object({ answers: z.record(z.string(), answerSchema), model: z.string().optional(), state_truncated: z.boolean().optional() });

export class LayaClient {
  private readonly endpoint: string;
  constructor(private readonly options: { url?: string; model?: string; timeoutMs?: number; fetchImpl?: typeof fetch } = {}) {
    this.endpoint = `${(options.url ?? process.env.LAYA_URL ?? 'http://127.0.0.1:8081').replace(/\/$/, '')}/api/decide`;
  }

  async choose(input: { state: string; candidates: ChoiceCandidate[]; signal?: AbortSignal }): Promise<ModelChoice> {
    if (input.candidates.length === 0) throw new Error('실행 가능한 행동이 없습니다.');
    if (new Set(input.candidates.map((c) => c.id)).size !== input.candidates.length) throw new Error('행동 후보 식별자가 중복됐습니다.');
    const fallback = (reason: string): ModelChoice => ({ id: input.candidates[0].id, source: 'code', reason });
    try {
      const criteria = Object.fromEntries(input.candidates.map((c) => [c.id, c.description]));
      const signal = input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(this.options.timeoutMs ?? 5000)]) : AbortSignal.timeout(this.options.timeoutMs ?? 5000);
      const response = await (this.options.fetchImpl ?? fetch)(this.endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
        body: JSON.stringify({ model: this.options.model ?? process.env.LAYA_MODEL ?? 'laya:multilingual', state: input.state, questions: { village_action: { type: 'choice', instructions: 'Choose one feasible action from the listed candidates. Respect the current role and user goal priority.', criteria } } }),
      });
      if (!response.ok) return fallback(`Laya 응답 실패 (${response.status}); 검증된 후보 순서를 사용합니다.`);
      const result = responseSchema.parse(await response.json());
      const answer = result.answers.village_action;
      if (!answer || result.state_truncated || !criteria[answer.choice]) return fallback('Laya 응답이 허용된 행동과 일치하지 않아 코드 판단을 사용합니다.');
      const confidence = answer.probabilities?.[answer.choice] ?? answer.confidence;
      return { id: answer.choice, source: 'laya', reason: '현재 관측과 허용된 행동 후보에서 Laya가 선택했습니다.', model: result.model, ...(confidence !== undefined && confidence >= 0 && confidence <= 1 ? { confidence } : {}) };
    } catch (error) {
      if (input.signal?.aborted) throw input.signal.reason;
      return fallback(`Laya를 사용할 수 없어 코드 판단을 사용합니다: ${error instanceof Error ? error.message : '응답 검증 실패'}`);
    }
  }
}
