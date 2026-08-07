// internal/store.ts — small async key/value store with memory and disk backends.
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "./atomic-write.mjs";

export type Store<T = unknown> = {
  get(key: string): Promise<T | undefined>;
  set(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  has(key: string): Promise<boolean>;
  entries(): AsyncIterable<[string, T]>;
  clear(): Promise<void>;
  close(): Promise<void>;
};

export function memoryStore<T = unknown>(): Store<T> {
  const map = new Map<string, T>();
  return {
    async get(key) { return map.has(key) ? structuredClone(map.get(key)) : undefined; },
    async set(key, value) { map.set(key, structuredClone(value)); },
    async delete(key) { return map.delete(key); },
    async has(key) { return map.has(key); },
    async *entries() {
      for (const [key, value] of map) yield [key, structuredClone(value)];
    },
    async clear() { map.clear(); },
    async close() {},
  };
}

function toFile(key: string): string {
  return `${encodeURIComponent(key)}.json`;
}

function fromFile(name: string): string {
  return decodeURIComponent(name.replace(/\.json$/, ""));
}

export function diskStore<T = unknown>({ dir }: { dir: string }): Store<T> {
  const ensure = fsp.mkdir(dir, { recursive: true }).catch(() => {});
  const path = (key: string) => join(dir, toFile(key));
  return {
    async get(key) {
      await ensure;
      try {
        return JSON.parse(await fsp.readFile(path(key), "utf8")) as T;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    },
    async set(key, value) {
      await ensure;
      await atomicWrite(path(key), JSON.stringify(value));
    },
    async delete(key) {
      await ensure;
      try {
        await fsp.rm(path(key)); // law-allow: delete-not-trace — KV eviction at the caller's explicit request (delete contract); forgetting with its declared price
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    },
    async has(key) {
      await ensure;
      try {
        await fsp.access(path(key));
        return true;
      } catch {
        return false;
      }
    },
    async *entries() {
      await ensure;
      let names: string[];
      try {
        names = await fsp.readdir(dir);
      } catch {
        return;
      }
      for (const name of names) {
        if (!name.endsWith(".json")) continue;
        try {
          yield [fromFile(name), JSON.parse(await fsp.readFile(join(dir, name), "utf8")) as T];
        } catch {}
      }
    },
    async clear() {
      await fsp.rm(dir, { recursive: true, force: true }); // law-allow: delete-not-trace — clear() is whole-store eviction by contract
      await fsp.mkdir(dir, { recursive: true });
    },
    async close() {},
  };
}
