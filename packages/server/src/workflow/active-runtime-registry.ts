export interface ActiveRuntime {
  abort(): void;
}

export const activeRuntimes = new Map<string, ActiveRuntime>();
