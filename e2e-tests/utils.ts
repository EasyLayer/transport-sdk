export class TestCleanup {
  private fns: Array<() => Promise<void> | void> = [];

  add(fn: () => Promise<void> | void) { this.fns.push(fn); }

  async run() {
    for (const fn of this.fns.reverse()) {
      try { await fn(); } catch { /* ignore */ }
    }
    this.fns.length = 0;
  }
}


export async function waitFor(
  condition: () => boolean, 
  timeoutMs: number = 2000, 
  intervalMs: number = 50
): Promise<void> {
  const startTime = Date.now();
  
  return new Promise((resolve, reject) => {
    const check = () => {
      if (condition()) {
        resolve();
        return;
      }
      
      if (Date.now() - startTime > timeoutMs) {
        reject(new Error(`Timeout after ${timeoutMs}ms waiting for condition`));
        return;
      }
      
      setTimeout(check, intervalMs);
    };
    
    check();
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function generateTestId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
}

export function timeout(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`Operation timed out after ${ms}ms`)), ms);
  });
}