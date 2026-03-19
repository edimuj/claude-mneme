/**
 * BatchQueue
 *
 * Collects items and flushes them in batches based on:
 * - Size threshold (max items)
 * - Time threshold (max wait time)
 */

export class BatchQueue {
  constructor({ maxSize = 100, maxWaitMs = 1000, processor }) {
    this.maxSize = maxSize;
    this.maxWaitMs = maxWaitMs;
    this.processor = processor; // async function(batch)
    this.batch = [];
    this.timer = null;
    this.flushing = false;
    this.flushRequested = false;
    this.flushPromise = null;
  }

  /**
   * Add item to queue
   */
  add(item) {
    this.batch.push(item);

    // Flush immediately if batch is full
    if (this.batch.length >= this.maxSize) {
      this.requestFlush();
      return;
    }

    // Schedule flush if not already scheduled
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.requestFlush();
      }, this.maxWaitMs);
    }
  }

  /**
   * Flush current batch
   */
  async flush() {
    return this.requestFlush();
  }

  requestFlush() {
    if (this.flushing) {
      this.flushRequested = true;
      return this.flushPromise || Promise.resolve();
    }

    if (this.batch.length === 0) {
      return Promise.resolve();
    }

    this.flushPromise = this.runFlushLoop();
    return this.flushPromise;
  }

  async runFlushLoop() {
    this.flushing = true;

    try {
      while (this.batch.length > 0) {
        this.flushRequested = false;

        // Clear timer
        if (this.timer) {
          clearTimeout(this.timer);
          this.timer = null;
        }

        // Take current batch
        const items = this.batch;
        this.batch = [];

        try {
          await this.processor(items);
        } catch (err) {
          // Log error but don't throw (non-critical, best-effort)
          console.error('[batch-queue] Flush error:', err.message);
        }

        if (this.batch.length === 0) {
          break;
        }

        if (this.flushRequested || this.batch.length >= this.maxSize) {
          continue;
        }

        if (!this.timer) {
          this.timer = setTimeout(() => {
            this.timer = null;
            this.requestFlush();
          }, this.maxWaitMs);
        }

        break;
      }
    } finally {
      this.flushing = false;
      this.flushPromise = null;
    }
  }

  /**
   * Get current queue depth
   */
  depth() {
    return this.batch.length;
  }

  /**
   * Shutdown queue (flush and clear timer)
   */
  async shutdown() {
    await this.flush();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
