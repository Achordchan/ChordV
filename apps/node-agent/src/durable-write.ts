import fs from 'node:fs';
import { dirname, resolve } from 'node:path';

export function syncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, 'r');
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

/**
 * The agent's only durable write path: a file whose absence and whose presence
 * must both be meaningful after a power loss. Temp file with an exclusive
 * create, explicit mode, fsync of the contents, atomic rename, then fsync of
 * the whole parent chain — a parent created by an earlier failed attempt may
 * be visible without its directory entry being durable.
 */
export function writeFileDurable(file: string, contents: string, mode = 0o600): void {
  file = resolve(file);
  const directory = dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
  try {
    const descriptor = fs.openSync(temporary, 'wx', mode);
    try {
      fs.writeFileSync(descriptor, contents);
      fs.fchmodSync(descriptor, mode);
      fs.fsyncSync(descriptor);
    } finally { fs.closeSync(descriptor); }
    fs.renameSync(temporary, file);
    let current = directory;
    while (true) {
      syncDirectory(current);
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* may already have been renamed */ }
    throw error;
  }
}

export function writeSecretDurable(file: string, value: unknown): void {
  writeFileDurable(file, JSON.stringify(value) + '\n', 0o600);
}
