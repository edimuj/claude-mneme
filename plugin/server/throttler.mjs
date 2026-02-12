/**
 * Throttler
 *
 * Rate-limits operations with:
 * - Max concurrent executions
 * - Cooldown period between executions (per key)
 */

export class Throttler {
  constructor({ maxConcurrent = 1, cooldownMs = 30000 } = {}) {
    this.maxConcurrent = maxConcurrent;
    this.cooldownMs = cooldownMs;
    this.running = 0;
    this.lastRun = new Map(); // key -> timestamp
  }

  /**
   * Execute function with throttling
   * @param {string} key - Throttle key (e.g., project path)
   * @param {Function} fn - Async function to execute
   * @returns {Promise} - Result of fn() or throws if throttled
   */
  async execute(key, fn) {
    // Check cooldown
    const lastRun = this.lastRun.get(key);
    if (lastRun) {
      const elapsed = Date.now() - lastRun;
      if (elapsed < this.cooldownMs) {
        const retryAfter = this.cooldownMs - elapsed;
        throw new ThrottleError('cooldown', retryAfter);
      }
    }

    // Check concurrency
    if (this.running >= this.maxConcurrent) {
      throw new ThrottleError('concurrency', 0);
    }

    this.running++;
    try {
      const result = await fn();
      this.lastRun.set(key, Date.now());
      return result;
    } finally {
      this.running--;
    }
  }

  /**
   * Check if key is throttled
   */
  isThrottled(key) {
    const lastRun = this.lastRun.get(key);
    if (!lastRun) return false;

    const elapsed = Date.now() - lastRun;
    return elapsed < this.cooldownMs;
  }

  /**
   * Get time until key can run again (ms)
   */
  getRetryAfter(key) {
    const lastRun = this.lastRun.get(key);
    if (!lastRun) return 0;

    const elapsed = Date.now() - lastRun;
    return Math.max(0, this.cooldownMs - elapsed);
  }

  /**
   * Get current running count
   */
  getRunning() {
    return this.running;
  }

  /**
   * Clear throttle state for a key
   */
  clear(key) {
    this.lastRun.delete(key);
  }

  /**
   * Clear all throttle state
   */
  clearAll() {
    this.lastRun.clear();
  }
}

/**
 * Custom error for throttled operations
 */
export class ThrottleError extends Error {
  constructor(reason, retryAfterMs) {
    super(`Throttled: ${reason}`);
    this.name = 'ThrottleError';
    this.reason = reason; // 'cooldown' or 'concurrency'
    this.retryAfterMs = retryAfterMs;
  }
}
