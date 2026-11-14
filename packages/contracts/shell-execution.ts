// The transcript index carries a short command label. The full command lives in the item.
export interface ShellExecution {
  command?: string;
  started_at_ms?: number;
  duration_ms?: number;
  exit_code?: number;
  outcome?: 'success' | 'failed' | 'stopped' | 'declined';
}

export function shellExecution(value: unknown): ShellExecution {
  const input = (value ?? {}) as ShellExecution;
  const result: ShellExecution = {};
  if (typeof input.command === 'string') result.command = input.command.slice(0,512).replace(/[\uD800-\uDBFF]$/, '').replaceAll('\0','');
  for (const key of ['started_at_ms','duration_ms','exit_code'] as const) {
    const n = input[key];
    if (typeof n === 'number' && Number.isSafeInteger(n) && (key==='exit_code' || n>=0)) result[key]=n;
  }
  if (['success','failed','stopped','declined'].includes(input.outcome ?? '')) result.outcome=input.outcome;
  return result;
}

export function shellCommand(args: string): string {
  if (!args.trimStart().startsWith('{')) return args;
  try {
    const input = JSON.parse(args);
    return typeof input?.command === 'string' ? input.command : '';
  } catch { return ''; }
}
