/**
 * MemoryCache
 *
 * Simple in-memory cache with:
 * - TTL (time-to-live) expiration
 * - LRU eviction when full
 * - Hit rate tracking
 */

export class MemoryCache {
  constructor({ maxSize = 100, ttlMs = 5 * 60 * 1000 } = {}) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
    this.cache = new Map(); // key -> { value, expiry, accessed }
    this.stats = {
      hits: 0,
      misses: 0,
      evictions: 0
    };
  }

  /**
   * Get value from cache
   */
  get(key) {
    const entry = this.cache.get(key);

    if (!entry) {
      this.stats.misses++;
      return null;
    }

    // Check expiry
    if (Date.now() > entry.expiry) {
      this.cache.delete(key);
      this.stats.misses++;
      return null;
    }

    // Update access time for LRU
    entry.accessed = Date.now();
    this.stats.hits++;

    return entry.value;
  }

  /**
   * Set value in cache
   */
  set(key, value, ttlMs = this.ttlMs) {
    // Evict oldest if full
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      this.evictOldest();
    }

    this.cache.set(key, {
      value,
      expiry: Date.now() + ttlMs,
      accessed: Date.now()
    });
  }

  /**
   * Evict least recently accessed entry
   */
  evictOldest() {
    let oldestKey = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.cache) {
      if (entry.accessed < oldestTime) {
        oldestTime = entry.accessed;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey);
      this.stats.evictions++;
    }
  }

  /**
   * Delete entry from cache
   */
  delete(key) {
    return this.cache.delete(key);
  }

  /**
   * Clear entire cache
   */
  clear() {
    this.cache.clear();
  }

  /**
   * Get cache size
   */
  size() {
    return this.cache.size;
  }

  /**
   * Get hit rate (0-1)
   */
  hitRate() {
    const total = this.stats.hits + this.stats.misses;
    if (total === 0) return 0;
    return this.stats.hits / total;
  }

  /**
   * Get cache stats
   */
  getStats() {
    return {
      ...this.stats,
      size: this.cache.size,
      maxSize: this.maxSize,
      hitRate: this.hitRate()
    };
  }

  /**
   * Cleanup expired entries (call periodically)
   */
  cleanup() {
    const now = Date.now();
    const expired = [];

    for (const [key, entry] of this.cache) {
      if (now > entry.expiry) {
        expired.push(key);
      }
    }

    for (const key of expired) {
      this.cache.delete(key);
    }

    return expired.length;
  }
}
