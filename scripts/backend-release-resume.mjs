import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { mkdir, writeFile, appendFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const shaPattern = /^[a-f0-9]{40}$/;
const semverPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-([0-9A-Za-z-]+)(\.([0-9A-Za-z-]+))*)?(\+([0-9A-Za-z-]+)(\.([0-9A-Za-z-]+))*)?$/;

export function releaseOptions(env = process.env) {
  assert.match(env.VERSION ?? '', semverPattern, 'Invalid VERSION');
  compareSemver(env.VERSION, env.VERSION); // Enforce numeric prerelease rules before creating any release.
  assert.match(env.GITHUB_SHA ?? '', shaPattern, 'Invalid GITHUB_SHA');
  assert.match(env.GITHUB_REPOSITORY ?? '', /^[\w.-]+\/[\w.-]+$/, 'Invalid repository');
  assert.ok(['true', 'false'].includes(env.PRERELEASE), 'Invalid PRERELEASE');
  assert.ok(['true', 'false'].includes(env.RESUME_EXISTING), 'Invalid RESUME_EXISTING');
  assert.ok(env.SIGNING_EXPECTED === undefined || ['true', 'false'].includes(env.SIGNING_EXPECTED), 'Invalid SIGNING_EXPECTED');
  return {
    version: env.VERSION,
    tag: `backend-v${env.VERSION}`,
    repository: env.GITHUB_REPOSITORY,
    sha: env.GITHUB_SHA,
    prerelease: env.PRERELEASE === 'true',
    resume: env.RESUME_EXISTING === 'true',
    signingKey: env.SIGNING_KEY || '',
    signingExpected: env.SIGNING_EXPECTED === 'true',
  };
}

// Only a confirmed 404 means absent. Authentication, rate limits, transport
// errors, malformed JSON and all unexpected status codes must stop the release.
export function githubClient(token, fetchImpl = fetch) {
  assert.ok(token, 'GH_TOKEN is required');
  return async (path, { optional = false, binary = false } = {}) => {
    const response = await fetchImpl(`https://api.github.com${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: binary ? 'application/octet-stream' : 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(10 * 60 * 1000),
    });
    if (optional && response.status === 404) return null;
    assert.equal(response.status, 200, `GitHub GET ${path}: HTTP ${response.status}`);
    const result = binary ? Buffer.from(await response.arrayBuffer()) : await response.json();
    assert.ok(result !== null && typeof result === 'object', `Invalid GitHub response: ${path}`);
    return result;
  };
}

export async function inspectRelease(options, api) {
  const { repository, tag, sha, prerelease } = options;
  const base = `/repos/${repository}`;
  const release = await api(`${base}/releases/tags/${encodeURIComponent(tag)}`, { optional: true });
  const ref = await api(`${base}/git/ref/tags/${encodeURIComponent(tag)}`, { optional: true });
  if (release === null && ref === null) return null;
  assert.ok(release && ref, 'Tag/release is incomplete; cannot build or resume this version');
  assert.equal(release.tag_name, tag, 'Release tag mismatch');
  assert.equal(release.draft, false, 'Only a fully published release can be resumed');
  assert.equal(release.prerelease, prerelease, 'Prerelease input does not match existing release');
  assert.ok(Number.isSafeInteger(release.id) && release.id > 0, 'Invalid release ID');
  assert.equal(ref.ref, `refs/tags/${tag}`, 'Tag ref mismatch');
  let object = ref.object;
  const visited = new Set();
  while (object?.type === 'tag') {
    assert.match(object.sha ?? '', shaPattern, 'Invalid annotated tag SHA');
    assert.ok(!visited.has(object.sha) && visited.size < 10, 'Invalid annotated tag chain');
    visited.add(object.sha);
    const annotated = await api(`${base}/git/tags/${object.sha}`);
    assert.equal(annotated.sha, object.sha, 'Annotated tag SHA mismatch');
    object = annotated.object;
  }
  assert.equal(object?.type, 'commit', 'Tag must resolve to a commit');
  assert.equal(object.sha, sha, 'Existing tag does not point to intended GITHUB_SHA');
  return release;
}

export async function planRelease(options, api) {
  const release = await inspectRelease(options, api);
  const { current } = await readStable(options, api);
  // Runs both before the build and immediately before immutable release creation.
  // Only key presence enters prepare; never hand the private key to build steps.
  guardSigningContinuity(Boolean(options.signingExpected), current);
  if (!release) {
    assert.ok(!options.resume, 'No release exists to resume; disable resume_existing for a fresh build');
    return 'build';
  }
  assert.ok(options.resume, 'Release exists: explicitly enable resume_existing to reuse immutable assets');
  return 'resume';
}

// Pure integrity guard: never regenerate a manifest, checksum or signature for
// an existing version. These exact buffers are the only publishable output.
export function verifyReleaseBytes(options, files) {
  const { version, tag, repository, signingKey } = options;
  const artifactName = `chordv-backend-${version}.tar.gz`;
  const required = [artifactName, 'checksums.txt', 'manifest.json'];
  if (signingKey) required.push('manifest.json.sig');
  assert.deepEqual([...files.keys()].sort(), required.sort(), 'Unexpected/missing release assets (signed releases require a verification key)');
  for (const bytes of files.values()) assert.ok(Buffer.isBuffer(bytes), 'Asset must contain bytes');
  const artifact = files.get(artifactName);
  assert.ok(artifact.length > 0, 'Empty artifact');
  const digest = createHash('sha256').update(artifact).digest('hex');
  assert.equal(files.get('checksums.txt').toString('utf8'), `${digest}  ${artifactName}\n`, 'Checksum file mismatch');
  const manifestBytes = files.get('manifest.json');
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  assert.equal(manifest.version, version, 'Manifest version mismatch');
  assert.equal(manifest.channel, options.prerelease ? 'prerelease' : 'stable', 'Manifest channel mismatch');
  assert.equal(manifest.tag, tag, 'Manifest tag mismatch');
  assert.equal(manifest.htmlUrl, `https://github.com/${repository}/releases/tag/${tag}`, 'Manifest release URL mismatch');
  assert.equal(typeof manifest.publishedAt, 'string', 'Missing manifest timestamp');
  assert.ok(Number.isFinite(Date.parse(manifest.publishedAt)), 'Invalid manifest timestamp');
  assert.ok(Array.isArray(manifest.changelog) && manifest.changelog.every((line) => typeof line === 'string'), 'Invalid changelog');
  assert.equal(manifest.artifact?.url, `https://github.com/${repository}/releases/download/${tag}/${artifactName}`, 'Manifest artifact URL mismatch');
  assert.equal(manifest.artifact.sha256, digest, 'Manifest checksum mismatch');
  assert.equal(manifest.artifact.sizeBytes, artifact.length, 'Manifest size mismatch');
  if (signingKey) {
    const publicKey = createPublicKey(signingKey);
    assert.equal(publicKey.asymmetricKeyType, 'ed25519', 'Signing key must be ed25519');
    const encoded = files.get('manifest.json.sig').toString('utf8');
    const signature = Buffer.from(encoded, 'base64');
    assert.ok(signature.length === 64 && signature.toString('base64') === encoded, 'Invalid signature encoding');
    assert.ok(verify(null, manifestBytes, publicKey, signature), 'Manifest signature mismatch');
  }
  return files;
}

export async function downloadVerifiedRelease(options, api) {
  const release = await inspectRelease(options, api);
  assert.ok(release, 'Published release is missing');
  const base = `/repos/${options.repository}`;
  // A valid release has only 3 or 4 assets. A full page (or extras) is rejected,
  // never mistaken for a complete inventory that could hide another asset.
  const assets = await api(`${base}/releases/${release.id}/assets?per_page=100`);
  const expected = [`chordv-backend-${options.version}.tar.gz`, 'checksums.txt', 'manifest.json'];
  if (options.signingKey) expected.push('manifest.json.sig');
  assert.ok(Array.isArray(assets), 'Invalid asset list');
  assert.deepEqual(assets.map((asset) => asset.name).sort(), expected.sort(), 'Unexpected/missing/duplicate release assets');
  const files = new Map();
  for (const asset of assets) {
    assert.equal(asset.state, 'uploaded', 'Asset upload is incomplete');
    assert.ok(Number.isSafeInteger(asset.id) && asset.id > 0, 'Invalid asset ID');
    assert.ok(Number.isSafeInteger(asset.size) && asset.size > 0, 'Invalid asset size');
    const bytes = await api(`${base}/releases/assets/${asset.id}`, { binary: true });
    assert.equal(bytes.length, asset.size, `Downloaded asset size mismatch: ${asset.name}`);
    files.set(asset.name, bytes);
  }
  return verifyReleaseBytes(options, files);
}

export function compareSemver(left, right) {
  function parse(version) {
    assert.match(version ?? '', semverPattern, 'Invalid stable SemVer');
    const withoutBuild = version.split('+')[0];
    const separator = withoutBuild.indexOf('-');
    const core = separator < 0 ? withoutBuild : withoutBuild.slice(0, separator);
    const prerelease = separator < 0 ? undefined : withoutBuild.slice(separator + 1);
    const identifiers = prerelease === undefined ? null : prerelease.split('.');
    for (const part of identifiers ?? []) {
      assert.ok(!/^\d+$/.test(part) || part === '0' || !part.startsWith('0'), 'Numeric prerelease identifiers cannot have leading zeros');
    }
    return { core: core.split('.').map(BigInt), identifiers };
  }
  const a = parse(left), b = parse(right);
  const compare = (x, y) => x === y ? 0 : x > y ? 1 : -1;
  for (let i = 0; i < 3; i++) {
    const order = compare(a.core[i], b.core[i]);
    if (order) return order;
  }
  if (a.identifiers === null || b.identifiers === null) {
    return a.identifiers === b.identifiers ? 0 : a.identifiers === null ? 1 : -1;
  }
  for (let i = 0; i < Math.max(a.identifiers.length, b.identifiers.length); i++) {
    const x = a.identifiers[i], y = b.identifiers[i];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    const order = xn && yn ? compare(BigInt(x), BigInt(y)) : xn !== yn ? (xn ? -1 : 1) : compare(x, y);
    if (order) return order;
  }
  return 0; // Build metadata has no SemVer precedence.
}

export function guardSigningContinuity(willSign, current) {
  assert.ok(!current?.has('manifest.json.sig') || willSign, 'Stable feed is signed; refusing unsigned release/publication. Restore the signing secret.');
}

function validateStableManifest(options, manifest) {
  // Existing GitHub-hosted feeds may predate the channel claim. They can be read
  // for monotonic upgrade checks, but newly published incoming bytes require it.
  assert.ok(manifest.channel === undefined || manifest.channel === 'stable', 'Invalid stable channel');
  // Fail closed on malformed existing feed, not just an unreadable version.
  assert.equal(manifest.tag, `backend-v${manifest.version}`, 'Invalid stable tag');
  assert.equal(manifest.htmlUrl, `https://github.com/${options.repository}/releases/tag/${manifest.tag}`, 'Invalid stable release URL');
  assert.equal(manifest.artifact?.url, `https://github.com/${options.repository}/releases/download/${manifest.tag}/chordv-backend-${manifest.version}.tar.gz`, 'Invalid stable artifact URL');
  assert.match(manifest.artifact.sha256 ?? '', /^[a-f0-9]{64}$/, 'Invalid stable checksum');
  assert.ok(Number.isSafeInteger(manifest.artifact.sizeBytes) && manifest.artifact.sizeBytes > 0, 'Invalid stable size');
  assert.ok(typeof manifest.publishedAt === 'string' && Number.isFinite(Date.parse(manifest.publishedAt)), 'Invalid stable timestamp');
  assert.ok(Array.isArray(manifest.changelog) && manifest.changelog.every((line) => typeof line === 'string'), 'Invalid stable changelog');
  compareSemver(manifest.version, manifest.version);
}

export function guardStableBytes(options, incoming, current) {
  guardSigningContinuity(incoming.has('manifest.json.sig'), current);
  const next = JSON.parse(incoming.get('manifest.json').toString('utf8'));
  assert.equal(next.version, options.version, 'Incoming stable version mismatch');
  assert.equal(next.channel, 'stable', 'Incoming manifest must authorize the stable channel');
  compareSemver(next.version, next.version);
  if (!current) return 'publish';
  const previous = JSON.parse(current.get('manifest.json').toString('utf8'));
  validateStableManifest(options, previous);
  const order = compareSemver(next.version, previous.version);
  assert.ok(order >= 0, `Stable feed ${previous.version} is newer than ${next.version}; refusing downgrade`);
  if (order === 0) {
    for (const name of ['manifest.json', 'manifest.json.sig']) {
      assert.deepEqual(incoming.get(name), current.get(name), 'Equal-precedence stable versions must have identical manifest/signature bytes');
    }
    return 'unchanged';
  }
  return 'publish';
}

export async function readStable(options, api) {
  const base = `/repos/${options.repository}`;
  const ref = await api(`${base}/git/ref/heads/backend-manifest`, { optional: true });
  if (ref === null) return { current: null, sha: '' };
  assert.equal(ref.ref, 'refs/heads/backend-manifest', 'Invalid stable ref');
  assert.equal(ref.object?.type, 'commit', 'Invalid stable ref type');
  assert.match(ref.object.sha ?? '', shaPattern, 'Invalid stable commit SHA');
  const sha = ref.object.sha;
  const current = new Map();
  for (const [name, path] of [['manifest.json', 'latest.json'], ['manifest.json.sig', 'latest.json.sig']]) {
    // Read one immutable commit, never a moving raw branch or cached mirror.
    const file = await api(`${base}/contents/${path}?ref=${sha}`, { optional: name.endsWith('.sig') });
    if (file === null) continue;
    assert.equal(file.type, 'file', 'Stable content must be a file');
    assert.equal(file.encoding, 'base64', 'Invalid stable content encoding');
    assert.equal(typeof file.content, 'string', 'Missing stable content');
    const encoded = file.content.replace(/\n/g, '');
    const bytes = Buffer.from(encoded, 'base64');
    assert.equal(bytes.toString('base64'), encoded, 'Malformed stable content');
    assert.ok(bytes.length > 0 && bytes.length === file.size, 'Stable content size mismatch');
    current.set(name, bytes);
  }
  // Reuse structural/SemVer validation even when called before any build exists.
  validateStableManifest(options, JSON.parse(current.get('manifest.json').toString('utf8')));
  return { current, sha };
}

export async function inspectStable(options, incoming, api) {
  const { current, sha } = await readStable(options, api);
  return { mode: guardStableBytes(options, incoming, current), sha };
}

async function main() {
  const options = releaseOptions();
  const api = githubClient(process.env.GH_TOKEN);
  if (process.argv[2] === 'prepare') {
    const mode = await planRelease(options, api);
    await appendFile(process.env.GITHUB_OUTPUT, `mode=${mode}\n`);
    console.log(`Backend release mode: ${mode}`);
  } else if (process.argv[2] === 'verify') {
    const files = await downloadVerifiedRelease(options, api);
    const output = resolve('published-release');
    // A fresh directory prevents stale signature/manifest files entering stable.
    await mkdir(output);
    for (const [name, bytes] of files) await writeFile(resolve(output, name), bytes, { flag: 'wx' });
    console.log('Published assets verified; exact immutable bytes ready for stable publication.');
  } else if (process.argv[2] === 'stable') {
    const incoming = new Map();
    for (const name of ['manifest.json', 'manifest.json.sig']) {
      try {
        incoming.set(name, await readFile(resolve('published-release', name)));
      } catch (error) {
        if (name.endsWith('.sig') && error.code === 'ENOENT') continue;
        throw error;
      }
    }
    const result = await inspectStable(options, incoming, api);
    await appendFile(process.env.GITHUB_OUTPUT, `mode=${result.mode}\nsha=${result.sha}\n`);
    console.log(`Stable publication: ${result.mode}`);
  } else {
    throw new Error('Usage: node scripts/backend-release-resume.mjs prepare|verify|stable');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
