import type { FleetCheckpoint } from '../../../packages/contracts/src';
import type { CommandReceipt, ControlStore } from './store';

/** Resolve receipt writes interrupted by a crash without replaying the command. */
export function reconcileCommandReceipts(store: ControlStore, checkpoint: FleetCheckpoint | undefined): CommandReceipt[] {
  const awaiting = new Set<string>(checkpoint?.pendingRuleCommands.map(command => command.commandId));
  for (const agent of checkpoint?.agents ?? []) for (const commandId of agent.pendingCommandIds) awaiting.add(commandId);
  const updates: CommandReceipt[] = [];
  for (const receipt of store.pendingCommands()) {
    const event = store.commandEvent(receipt.id);
    if (event?.type === 'command.applied') {
      updates.push(store.updateCommand(receipt.id, 'applied', event.data)!);
    } else if (event?.type === 'command.failed') {
      updates.push(store.updateCommand(receipt.id, 'failed', undefined, String(event.message ?? '명령 적용 실패'))!);
    } else if (awaiting.has(receipt.id)) {
      updates.push(store.updateCommand(receipt.id, 'applying')!);
    } else {
      updates.push(store.updateCommand(receipt.id, 'failed', undefined, '컨트롤러 재시작으로 적용을 확인하지 못했습니다. 실제 상태를 확인한 뒤 새 요청으로 등록해 주세요.')!);
    }
  }
  return updates;
}
