import type { FleetCheckpoint } from '../../contracts/src';

function freezeEvidence(value: unknown): void {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freezeEvidence(child);
  Object.freeze(value);
}

/** Completed result payloads and accepted observations are immutable evidence.
 * Reuse their JSON while serializing all mutable execution state afresh. The
 * saved format remains the full ordinary checkpoint, without archive pointers.
 */
export class CheckpointJson {
  private readonly evidence = new WeakMap<object, string>();

  private immutable(value: object): string {
    let encoded = this.evidence.get(value);
    if (encoded === undefined) {
      freezeEvidence(value);
      encoded = JSON.stringify(value);
      this.evidence.set(value, encoded);
    }
    return encoded;
  }

  serialize(state: FleetCheckpoint): string {
    return `{${Object.entries(state).filter(([, value]) => value !== undefined).map(([key, value]) => {
      let encoded: string;
      if (key === 'observations') encoded = `[${state.observations.map(observation => this.immutable(observation)).join(',')}]`;
      else if (key === 'attempts') encoded = `[${state.attempts.map(attempt => {
        const { result, ...mutable } = attempt;
        const envelope = JSON.stringify(mutable);
        return result === undefined ? envelope : `${envelope.slice(0,-1)},"result":${this.immutable(result)}}`;
      }).join(',')}]`;
      else encoded = JSON.stringify(value);
      return `${JSON.stringify(key)}:${encoded}`;
    }).join(',')}}`;
  }
}
