import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const output = resolve(process.argv[2] || resolve(root, 'agent-go-dist'));
const version = readFileSync(resolve(root, 'SYSTEM_VERSION'), 'utf8').trim();
if (!/^[0-9A-Za-z.+-]{1,61}$/.test(version)) throw new Error('Invalid agent version');
const sourceRoot = resolve(root, 'apps/agent');
const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal', '--', 'apps/agent'], { cwd: root, encoding: 'utf8' }).trim();
function sourceFiles(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const name = prefix + entry.name;
    return entry.isDirectory() ? sourceFiles(resolve(directory, entry.name), name + '/')
      : (entry.isFile() && (entry.name.endsWith('.go') || ['go.mod', 'go.sum'].includes(entry.name)) ? [name] : []);
  });
}
// An uncommitted local build must not masquerade as the clean HEAD's bytes.
// Match the Docker builder's source fingerprint when Git cannot identify them.
const sourceDigest = () => createHash('sha256').update(sourceFiles(sourceRoot).sort().map(name =>
  `${createHash('sha256').update(readFileSync(resolve(sourceRoot, name))).digest('hex')}  ./${name}\n`).join('')).digest('hex');
const commit = dirty ? `source-sha256:${sourceDigest()}`
  : execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
mkdirSync(output, { recursive: true });
const sha256 = {};
for (const arch of ['amd64', 'arm64']) {
  const binary = resolve(output, `chordv-agent-linux-${arch}`);
  execFileSync('go', ['build', '-trimpath', '-buildvcs=false', '-ldflags',
    `-s -w -X github.com/Achordchan/ChordV/apps/agent/internal/version.Version=${version} -X github.com/Achordchan/ChordV/apps/agent/internal/version.Commit=${commit}`,
    '-o', binary, './cmd/chordv-agent'], {
    cwd: resolve(root, 'apps/agent'), stdio: 'inherit',
    env: { ...process.env, CGO_ENABLED: '0', GOOS: 'linux', GOARCH: arch }
  });
  sha256[arch] = createHash('sha256').update(readFileSync(binary)).digest('hex');
  writeFileSync(`${binary}.sha256`, `${sha256[arch]}  chordv-agent-linux-${arch}\n`);
}
writeFileSync(resolve(output, 'manifest.json'), JSON.stringify({ version, commit, sha256 }, null, 2) + '\n');
