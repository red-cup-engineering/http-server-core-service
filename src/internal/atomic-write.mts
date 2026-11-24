// internal/atomic-write.ts — durable file writes via temp-sibling then rename.
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { promises as fsp } from "node:fs";
import { dirname } from "node:path";

let counter = 0;

function tempName(dest: string): string {
  counter = (counter + 1) >>> 0;
  return `${dest}.tmp-${process.pid}-${counter.toString(36)}`;
}

export async function atomicWrite(dest: string, data: string | Buffer | Uint8Array): Promise<void> {
  await fsp.mkdir(dirname(dest), { recursive: true });
  const tmp = tempName(dest);
  await fsp.writeFile(tmp, data);
  try {
    await fsp.rename(tmp, dest);
  } catch (error) {
    await fsp.rm(tmp, { force: true }).catch(() => {}); // law-allow: delete-not-trace — temp-sibling cleanup after failed rename; no witnessed evidence destroyed
    throw error;
  }
}

export function atomicWriteSync(dest: string, data: string | Buffer | Uint8Array): void {
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = tempName(dest);
  writeFileSync(tmp, data);
  renameSync(tmp, dest);
}
