import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Resolve the deployed package, not npm's invoking package or the launch cwd. */
export function readAgentVersion(moduleUrl: string | URL = import.meta.url): string {
  let directory = dirname(fileURLToPath(moduleUrl));
  while (true) {
    try {
      const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown };
      if (manifest.name === '@chordv/node-agent') {
        if (typeof manifest.version !== 'string' || !manifest.version.trim()) throw new Error('Agent package.json 缺少版本号');
        return manifest.version;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error('无法定位 Agent package.json，发布包可能不完整');
    directory = parent;
  }
}

export const AGENT_VERSION = readAgentVersion();
