import type { MemoryProvider, CircuitBreakerState } from "../types.js";
import { CircuitBreaker } from "./circuit-breaker.js";
import { retryWithBackoff } from "../utils/retry.js";

export class ResilientProvider implements MemoryProvider {
  private breaker = new CircuitBreaker();
  private deadLetterQueue: Array<{ 
    operation: string; 
    payload: unknown; 
    error: unknown; 
    timestamp: string; 
    retries: number 
  }> = [];
  name: string;
  private maxRetries: number;

  constructor(private inner: MemoryProvider, maxRetries: number = 3) {
    this.name = `resilient(${inner.name})`;
    this.maxRetries = maxRetries;
  }

  private async callWithRetry<T>(operation: () => Promise<T>, operationName: string): Promise<T> {
    if (!this.breaker.isAllowed) {
      throw new Error("circuit_breaker_open");
    }
    
    try {
      const result = await retryWithBackoff(
        operation,
        this.maxRetries,
        100, // baseDelayMs
        5000, // maxDelayMs
        (error) => {
          // Don't retry on circuit breaker errors or validation errors
          const errorStr = String(error).toLowerCase();
          return !errorStr.includes("circuit_breaker_open") && 
                 !errorStr.includes("validation") &&
                 !errorStr.includes("invalid");
        }
      );
      
      this.breaker.recordSuccess();
      return result;
    } catch (err) {
      this.breaker.recordFailure();
      
      // Add to dead letter queue for persistent failures
      this.deadLetterQueue.push({
        operation: operationName,
        payload: {}, // In a real implementation, we'd serialize the payload
        error: err,
        timestamp: new Date().toISOString(),
        retries: this.maxRetries
      });
      
      // Keep only last 1000 entries in dead letter queue
      if (this.deadLetterQueue.length > 1000) {
        this.deadLetterQueue.shift();
      }
      
      throw err;
    }
  }

  async compress(systemPrompt: string, userPrompt: string): Promise<string> {
    return this.callWithRetry(
      () => this.inner.compress(systemPrompt, userPrompt),
      "compress"
    );
  }

  async summarize(systemPrompt: string, userPrompt: string): Promise<string> {
    return this.callWithRetry(
      () => this.inner.summarize(systemPrompt, userPrompt),
      "summarize"
    );
  }

  get circuitState(): CircuitBreakerState {
    return this.breaker.getState();
  }

  getDeadLetterQueue(): Array<{ 
    operation: string; 
    payload: unknown; 
    error: unknown; 
    timestamp: string; 
    retries: number 
  }> {
    return [...this.deadLetterQueue];
  }

  clearDeadLetterQueue(): number {
    const cleared = this.deadLetterQueue.length;
    this.deadLetterQueue = [];
    return cleared;
  }

  // Self-healing method to attempt recovery from failed operations
  async attemptSelfHeal(): Promise<number> {
    const failedOps = [...this.deadLetterQueue];
    let healedCount = 0;
    
    for (const failedOp of failedOps) {
      try {
        // Attempt to retry the operation
        // In a full implementation, we would reconstruct the payload
        // For now, we'll just clear old entries as a form of healing
        const ageHours = (Date.now() - new Date(failedOp.timestamp).getTime()) / (1000 * 60 * 60);
        if (ageHours > 24) {
          // Remove entries older than 24 hours
          const index = this.deadLetterQueue.findIndex(
            entry => entry.timestamp === failedOp.timestamp
          );
          if (index !== -1) {
            this.deadLetterQueue.splice(index, 1);
            healedCount++;
          }
        }
      } catch (healError) {
        // If self-healing fails, continue to next operation
        console.error(`Self-heal failed for ${failedOp.operation}:`, healError);
      }
    }
    
    return healedCount;
  }
}
