export interface CallRecord {
  toolName: string;
  toolArgs?: Record<string, unknown>;
}

const MAX_HISTORY = 10;
const history: CallRecord[] = [];

export function recordCall(toolName: string, toolArgs?: Record<string, unknown>): void {
  history.push({ toolName, toolArgs });
  if (history.length > MAX_HISTORY) {
    history.shift();
  }
}

export function getRecentCalls(n = 3): CallRecord[] {
  return history.slice(-n);
}
