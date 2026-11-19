// internal/lru.ts — bounded LRU map (insertion/recency-ordered, evicts oldest on overflow).
export type LruOptions<K, V> = {
  max: number;
  onEvict?: (key: K, value: V) => void;
};

export class LruMap<K, V> {
  #map = new Map<K, V>();
  #max: number;
  #onEvict: ((key: K, value: V) => void) | undefined;

  constructor({ max, onEvict }: LruOptions<K, V>) {
    this.#max = max;
    this.#onEvict = onEvict;
  }

  get(key: K): V | undefined {
    if (!this.#map.has(key)) return undefined;
    const v = this.#map.get(key)!;
    this.#map.delete(key);
    this.#map.set(key, v);
    return v;
  }

  set(key: K, value: V): this {
    if (this.#map.has(key)) this.#map.delete(key);
    else if (this.#max > 0 && this.#map.size >= this.#max) {
      const oldest = this.#map.keys().next().value as K;
      this.#onEvict?.(oldest, this.#map.get(oldest)!);
      this.#map.delete(oldest);
    }
    this.#map.set(key, value);
    return this;
  }

  peek(key: K): V | undefined { return this.#map.get(key); }
  has(key: K): boolean { return this.#map.has(key); }
  delete(key: K): boolean { return this.#map.delete(key); }
  get size(): number { return this.#map.size; }
  keys(): IterableIterator<K> { return this.#map.keys(); }
  values(): IterableIterator<V> { return this.#map.values(); }
  entries(): IterableIterator<[K, V]> { return this.#map.entries(); }
  clear(): void { this.#map.clear(); }
}

export function lruMap<K, V>(opts: LruOptions<K, V>): LruMap<K, V> {
  return new LruMap(opts);
}

export function boundedMap<K, V>(opts: Partial<LruOptions<K, V>> = {}): LruMap<K, V> {
  const config: LruOptions<K, V> = { max: opts.max ?? 0 };
  if (opts.onEvict) config.onEvict = opts.onEvict;
  return new LruMap(config);
}
