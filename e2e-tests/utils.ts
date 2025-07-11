let globalCleanupCounter = 0;
const MAX_LISTENERS = 50;

export class TestCleanup {
  private cleanupFunctions: Array<() => Promise<void> | void> = [];
  private isDestroyed = false;
  private readonly id: number;

  constructor() {
    this.id = ++globalCleanupCounter;
    
    if (this.id === 1) {
      process.setMaxListeners(MAX_LISTENERS);
    }
  }

  add(fn: () => Promise<void> | void): void {
    if (this.isDestroyed) {
      return;
    }
    this.cleanupFunctions.push(fn);
  }

  async cleanup(): Promise<void> {
    if (this.isDestroyed) {
      return;
    }

    this.isDestroyed = true;
    
    const functions = [...this.cleanupFunctions].reverse();
    this.cleanupFunctions = [];

    for (const fn of functions) {
      try {
        const result = fn();
        if (result instanceof Promise) {
          await result;
        }
      } catch (error) {
        // Silent cleanup errors
      }
    }
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