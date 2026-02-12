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
  }

  /**
   * Add item to queue
   */
  add(item) {
    this.batch.push(item);

    // Flush immediately if batch is full
    if (this.batch.length >= this.maxSize) {
      this.flush();
      return;
    }

    // Schedule flush if not already scheduled
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.maxWaitMs);
    }
  }

  /**
   * Flush current batch
   */
  async flush() {
    if (this.flushing || this.batch.length === 0) return;

    // Clear timer
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    // Take current batch
    const items = this.batch;
    this.batch = [];
    this.flushing = true;

    try {
      await this.processor(items);
    } catch (err) {
      // Log error but don't throw (non-critical, best-effort)
      console.error('[batch-queue] Flush error:', err.message);
    } finally {
      this.flushing = false;
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
