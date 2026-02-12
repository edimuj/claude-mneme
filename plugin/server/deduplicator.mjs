/**
 * Deduplicator
 *
 * Detects duplicate entries within a sliding time window.
 * Uses content-based hashing (ignores timestamp).
 */

export class Deduplicator {
  constructor({ windowMs = 5000 } = {}) {
    this.windowMs = windowMs;
    this.recentHashes = new Map(); // hash -> timestamp
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000); // Clean every minute
  }

  /**
   * Check if entry is a duplicate
   * Returns true if duplicate, false otherwise
   */
  isDuplicate(entry) {
    const hash = this.hashEntry(entry);
    const lastSeen = this.recentHashes.get(hash);
    const now = Date.now();

    if (lastSeen && now - lastSeen < this.windowMs) {
      // Duplicate within window, update timestamp
      this.recentHashes.set(hash, now);
      return true;
    }

    // Not a duplicate, record it
    this.recentHashes.set(hash, now);
    return false;
  }

  /**
   * Hash entry based on type and content (ignore timestamp)
   */
  hashEntry(entry) {
    const { type, content, action, outcome, subject } = entry;

    // For task entries, include action/outcome/subject
    if (type === 'task') {
      return `task:${action || ''}:${outcome || ''}:${subject || ''}`;
    }

    // For other entries, use type + content
    return `${type}:${content || ''}`;
  }

  /**
   * Clean up old entries (older than window + 1 minute buffer)
   */
  cleanup() {
    const now = Date.now();
    const expiry = this.windowMs + 60000; // Window + 1 minute buffer

    for (const [hash, timestamp] of this.recentHashes) {
      if (now - timestamp > expiry) {
        this.recentHashes.delete(hash);
      }
    }
  }

  /**
   * Get current cache size
   */
  size() {
    return this.recentHashes.size;
  }

  /**
   * Shutdown deduplicator
   */
  shutdown() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
}
