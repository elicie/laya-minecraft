import type { Bot } from 'mineflayer';
import type { Evidence, JsonObject, ObservationInput, Position, Rules } from '../../contracts/src';

export class ConditionWait extends Error {
  readonly code = 'CONDITION_WAIT';
  constructor(message: string, readonly checkpoint: JsonObject = {}) { super(message); }
}

export class ActionFailure extends Error {
  constructor(message: string, readonly code: string, readonly retryable: boolean, readonly effectsKnown: boolean) { super(message); }
}

export interface ActionServices {
  bot: Bot;
  rules: Rules;
  signal: AbortSignal;
  checkpoint: JsonObject;
  observations: ObservationInput[];
  evidence: Evidence[];
  check(): void;
  pause(ms: number): Promise<void>;
  near(position: Position, radius?: number): Promise<void>;
  ensureItem(item: string, quantity: number): Promise<void>;
  place(position: Position, item: string, expectedName?: string, face?: Position): Promise<void>;
  recoverDrops?(position: Position, item: string, minimum: number, avoidSupports?: Position[]): Promise<void>;
  observeInventory(): ObservationInput;
  progress(action: string, reason: string): void;
}

export function inVillage(position: Position, rules: Pick<Rules, 'center' | 'radius'>): boolean {
  return rules.center !== null && Math.hypot(position.x - rules.center.x, position.z - rules.center.z) <= rules.radius;
}

export function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw new ActionFailure('현재 작업을 안전하게 중단합니다.', 'CANCELLED', false, true);
}

export function pause(ms: number, signal: AbortSignal): Promise<void> {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); reject(new ActionFailure('현재 작업을 안전하게 중단합니다.', 'CANCELLED', false, true)); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
