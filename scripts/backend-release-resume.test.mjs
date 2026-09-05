import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { compareSemver, guardStableBytes, inspectStable, downloadVerifiedRelease, githubClient, inspectRelease, planRelease, releaseOptions, verifyReleaseBytes } from './backend-release-resume.mjs';

const options = {
  repository: 'example/chordv', version: '1.2.3', tag: 'backend-v1.2.3',
  sha: 'a'.repeat(40), prerelease: false, resume: true, signingKey: '', signingExpected: false,
};
const base = '/repos/example/chordv';
const releasePath = `${base}/releases/tags/backend-v1.2.3`;
const refPath = `${base}/git/ref/tags/backend-v1.2.3`;
const { privateKey } = generateKeyPairSync('ed25519');
const signingKey = privateKey.export({ type: 'pkcs8', format: 'pem' });

function fixture(signed = false) {
  const artifact = Buffer.from('immutable tarball fixture\n');
  const name = `chordv-backend-${options.version}.tar.gz`;
  const digest = createHash('sha256').update(artifact).digest('hex');
  const manifest = {
    version: options.version, tag: options.tag, channel: 'stable',
    publishedAt: '2026-09-05T10:00:00Z', changelog: ['Original changelog'],
    htmlUrl: `https://github.com/${options.repository}/releases/tag/${options.tag}`,
    artifact: {
      url: `https://github.com/${options.repository}/releases/download/${options.tag}/${name}`,
      sha256: digest, sizeBytes: artifact.length,
    },
  };
  const files = new Map([
    [name, artifact],
    ['checksums.txt', Buffer.from(`${digest}  ${name}\n`)],
    ['manifest.json', Buffer.from(JSON.stringify(manifest, null, 2))],
  ]);
  if (signed) files.set('manifest.json.sig', Buffer.from(sign(null, files.get('manifest.json'), privateKey).toString('base64')));
  const release = { id: 42, tag_name: options.tag, draft: false, prerelease: false };
  const ref = { ref: `refs/tags/${options.tag}`, object: { type: 'commit', sha: options.sha } };
  const assets = [...files].map(([name, bytes], index) => ({ id: index + 1, name, state: 'uploaded', size: bytes.length }));
  const routes = new Map([
    [releasePath, release], [refPath, ref], [`${base}/releases/42/assets?per_page=100`, assets],
    [`${base}/git/ref/heads/backend-manifest`, null],
    ...assets.map((asset) => [`${base}/releases/assets/${asset.id}`, files.get(asset.name)]),
  ]);
  const calls = [];
  const api = async (path) => {
    calls.push(path);
    assert.ok(routes.has(path), `Unmocked endpoint ${path}`);
    return routes.get(path);
  };
  return { files, manifest, release, ref, assets, routes, calls, api };
}

function mutateManifest(f, mutate) {
  mutate(f.manifest);
  f.files.set('manifest.json', Buffer.from(JSON.stringify(f.manifest)));
}

test('only fresh mode may build; existing release requires explicit resume', async () => {
  const f = fixture();
  assert.equal(await planRelease(options, f.api), 'resume');
  await assert.rejects(planRelease({ ...options, resume: false }, f.api), /explicitly enable/);
  f.routes.set(releasePath, null);
  f.routes.set(refPath, null);
  assert.equal(await planRelease({ ...options, resume: false }, f.api), 'build');
  await assert.rejects(planRelease(options, f.api), /No release exists/);
});

test('reject partial releases, wrong commit, ref, draft and prerelease mismatches', async (t) => {
  const cases = [
    ['tag without release', (f) => f.routes.set(releasePath, null)],
    ['release without tag', (f) => f.routes.set(refPath, null)],
    ['different commit', (f) => { f.ref.object.sha = 'b'.repeat(40); }],
    ['wrong ref', (f) => { f.ref.ref = 'refs/heads/main'; }],
    ['wrong tag', (f) => { f.release.tag_name = 'backend-v9.9.9'; }],
    ['draft', (f) => { f.release.draft = true; }],
    ['prerelease', (f) => { f.release.prerelease = true; }],
    ['tree tag', (f) => { f.ref.object.type = 'tree'; }],
  ];
  for (const [name, mutate] of cases) await t.test(name, async () => {
    const f = fixture(); mutate(f);
    await assert.rejects(planRelease(options, f.api));
  });
});

test('resolve annotated tags and reject loops or mismatched objects', async () => {
  const f = fixture();
  const tagSha = 'b'.repeat(40);
  f.ref.object = { type: 'tag', sha: tagSha };
  const annotated = { sha: tagSha, object: { type: 'commit', sha: options.sha } };
  f.routes.set(`${base}/git/tags/${tagSha}`, annotated);
  assert.equal(await planRelease(options, f.api), 'resume');
  annotated.object = f.ref.object;
  await assert.rejects(inspectRelease(options, f.api), /tag chain/);
  annotated.sha = 'c'.repeat(40);
  await assert.rejects(inspectRelease(options, f.api), /SHA mismatch/);
});

test('only 404 is absence; all HTTP and transport errors fail closed', async (t) => {
  for (const status of [401, 403, 429, 500, 502, 204]) await t.test(`HTTP ${status}`, async () => {
    const api = githubClient('test-token', async () => new Response(null, { status }));
    await assert.rejects(planRelease({ ...options, resume: false }, api), /HTTP/);
  });
  const absent = githubClient('test-token', async () => new Response(null, { status: 404 }));
  assert.equal(await planRelease({ ...options, resume: false }, absent), 'build');
  await assert.rejects(absent('/assets/1'), /HTTP 404/);
  for (const payload of ['not json', 'null']) {
    const malformed = githubClient('test-token', async () => new Response(payload));
    await assert.rejects(planRelease(options, malformed));
  }
  const offline = githubClient('test-token', async () => { throw new Error('network failure'); });
  await assert.rejects(planRelease(options, offline), /network failure/);
});

test('valid unsigned and signed releases retain exact original bytes on repeated resumes', async () => {
  for (const signed of [false, true]) {
    const f = fixture(signed);
    const opts = { ...options, signingKey: signed ? signingKey : '' };
    assert.equal(verifyReleaseBytes(opts, f.files), f.files);
    const first = await downloadVerifiedRelease(opts, f.api);
    const second = await downloadVerifiedRelease(opts, f.api);
    for (const [name, bytes] of f.files) {
      assert.deepEqual(first.get(name), bytes);
      assert.deepEqual(second.get(name), bytes);
    }
    assert.ok(f.calls.every((path) => path.startsWith(base)));
  }
});

test('reject corrupt artifact, checksums and every manifest identity field', async (t) => {
  const cases = [
    ['artifact', (f) => f.files.set('chordv-backend-1.2.3.tar.gz', Buffer.from('changed'))],
    ['checksum', (f) => f.files.set('checksums.txt', Buffer.from('wrong'))],
    ['checksum traversal', (f) => f.files.set('checksums.txt', Buffer.from('a'.repeat(64) + '  ../evil\n'))],
    ['version', (f) => mutateManifest(f, (m) => { m.version = '9.0.0'; })],
    ['tag', (f) => mutateManifest(f, (m) => { m.tag = 'backend-v9.0.0'; })],
    ['release URL', (f) => mutateManifest(f, (m) => { m.htmlUrl = 'https://evil.invalid'; })],
    ['artifact URL', (f) => mutateManifest(f, (m) => { m.artifact.url = 'https://evil.invalid'; })],
    ['manifest checksum', (f) => mutateManifest(f, (m) => { m.artifact.sha256 = '0'.repeat(64); })],
    ['size', (f) => mutateManifest(f, (m) => { m.artifact.sizeBytes++; })],
    ['timestamp', (f) => mutateManifest(f, (m) => { m.publishedAt = 'invalid'; })],
    ['changelog', (f) => mutateManifest(f, (m) => { m.changelog = [false]; })],
    ['malformed JSON', (f) => f.files.set('manifest.json', Buffer.from('{'))],
    ['missing asset', (f) => f.files.delete('checksums.txt')],
    ['extra asset', (f) => f.files.set('../evil', Buffer.from('unexpected'))],
  ];
  for (const [name, mutate] of cases) await t.test(name, () => {
    const f = fixture(); mutate(f);
    assert.throws(() => verifyReleaseBytes(options, f.files));
  });
});

test('signed resume requires correct key, signature and exact signed manifest', () => {
  const opts = { ...options, signingKey };
  assert.throws(() => verifyReleaseBytes(opts, fixture().files), /assets/);
  assert.throws(() => verifyReleaseBytes(options, fixture(true).files), /assets/);
  const differentKey = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
  assert.throws(() => verifyReleaseBytes({ ...options, signingKey: differentKey }, fixture(true).files), /signature mismatch/);
  const f = fixture(true);
  f.files.set('manifest.json', Buffer.concat([f.files.get('manifest.json'), Buffer.from('\n')]));
  assert.throws(() => verifyReleaseBytes(opts, f.files), /signature mismatch/);
  f.files.set('manifest.json.sig', Buffer.from('garbage'));
  assert.throws(() => verifyReleaseBytes(opts, f.files), /signature encoding/);
});

test('reject missing, duplicate, unexpected, pending and truncated downloads', async (t) => {
  const cases = [
    ['missing', (f) => f.assets.pop()],
    ['duplicate', (f) => { f.assets[1].name = f.assets[0].name; }],
    ['unexpected', (f) => f.assets.push({ name: '../evil' })],
    ['pending', (f) => { f.assets[0].state = 'new'; }],
    ['truncated', (f) => f.routes.set(`${base}/releases/assets/1`, Buffer.from('short'))],
  ];
  for (const [name, mutate] of cases) await t.test(name, async () => {
    const f = fixture(); mutate(f);
    await assert.rejects(downloadVerifiedRelease(options, f.api));
  });
});

test('validate dispatch input and encode semver tag API paths', async () => {
  const env = { VERSION: '1.2.3', GITHUB_SHA: options.sha, GITHUB_REPOSITORY: options.repository, PRERELEASE: 'false', RESUME_EXISTING: 'true' };
  assert.deepEqual(releaseOptions(env), options);
  for (const change of [{ VERSION: '../evil' }, { VERSION: '1.2.3-01' }, { GITHUB_SHA: 'main' }, { RESUME_EXISTING: '' }, { PRERELEASE: 'yes' }]) {
    assert.throws(() => releaseOptions({ ...env, ...change }));
  }
  const calls = [];
  await planRelease({ ...options, tag: 'backend-v1.2.3+build.1', resume: false }, async (path) => { calls.push(path); return null; });
  assert.ok(calls.slice(0, 2).every((path) => path.endsWith('backend-v1.2.3%2Bbuild.1')));
});

test('full SemVer precedence includes prereleases, metadata and arbitrary-length integers', () => {
  const ordered = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.1', '1.1.0', '2.0.0'];
  for (let i = 1; i < ordered.length; i++) {
    assert.equal(compareSemver(ordered[i - 1], ordered[i]), -1);
    assert.equal(compareSemver(ordered[i], ordered[i - 1]), 1);
  }
  assert.equal(compareSemver('1.2.3+old', '1.2.3+new'), 0);
  assert.equal(compareSemver('1.2.3-rc.1+old', '1.2.3-rc.1+new'), 0);
  assert.equal(compareSemver('999999999999999999999.0.0', '999999999999999999998.0.0'), 1);
  assert.equal(compareSemver('1.0.0-999999999999999999999', '1.0.0-999999999999999999998'), 1);
  for (const invalid of ['01.2.3', '1.2.3-01', '1.2.3-a..b', '1.2.3+', 'garbage']) {
    assert.throws(() => compareSemver(invalid, '1.0.0'));
  }
});

function atVersion(version, signed = false) {
  const f = fixture(signed);
  mutateManifest(f, (m) => {
    m.version = version;
    m.tag = `backend-v${version}`;
    m.htmlUrl = `https://github.com/${options.repository}/releases/tag/${m.tag}`;
    m.artifact.url = `https://github.com/${options.repository}/releases/download/${m.tag}/chordv-backend-${version}.tar.gz`;
  });
  return f.files;
}

test('stable guard permits upgrades and exact retry only; never lowers or changes equal-precedence bytes', () => {
  const incoming = atVersion('1.2.3');
  assert.equal(guardStableBytes(options, incoming, null), 'publish');
  assert.equal(guardStableBytes(options, incoming, atVersion('1.2.2')), 'publish');
  assert.equal(guardStableBytes(options, incoming, atVersion('1.2.3-rc.1')), 'publish');
  assert.equal(guardStableBytes(options, incoming, atVersion('1.2.3')), 'unchanged');
  assert.throws(() => guardStableBytes(options, incoming, atVersion('1.2.4')), /refusing downgrade/);
  assert.throws(() => guardStableBytes(options, incoming, atVersion('1.2.3+other')), /identical/);
  const changed = atVersion('1.2.3');
  changed.set('manifest.json', Buffer.concat([changed.get('manifest.json'), Buffer.from('\n')]));
  assert.throws(() => guardStableBytes(options, incoming, changed), /identical/);
  const signed = atVersion('1.2.3', true);
  assert.equal(guardStableBytes(options, signed, new Map(signed)), 'unchanged');
  assert.throws(() => guardStableBytes(options, incoming, signed), /refusing unsigned/);
  assert.throws(() => guardStableBytes(options, signed, incoming), /identical/);
  const malformed = new Map([['manifest.json', Buffer.from('{"version":"0.0.1"}')]]);
  assert.throws(() => guardStableBytes(options, incoming, malformed));
  assert.throws(() => guardStableBytes(options, incoming, atVersion('1.2.3-01')));
});

function withStable(f, files) {
  const sha = 'd'.repeat(40);
  f.routes.set(`${base}/git/ref/heads/backend-manifest`, { ref: 'refs/heads/backend-manifest', object: { type: 'commit', sha } });
  for (const [name, path] of [['manifest.json', 'latest.json'], ['manifest.json.sig', 'latest.json.sig']]) {
    const bytes = files.get(name);
    f.routes.set(`${base}/contents/${path}?ref=${sha}`, bytes ? { type: 'file', encoding: 'base64', size: bytes.length, content: bytes.toString('base64') } : null);
  }
  return f;
}

test('prepare rejects removed signing secret before build or creation, including resume/prerelease', async () => {
  const f = withStable(fixture(), atVersion('1.2.2', true));
  f.routes.set(releasePath, null);
  f.routes.set(refPath, null);
  const fresh = { ...options, resume: false };
  await assert.rejects(planRelease(fresh, f.api), /refusing unsigned/);
  await assert.rejects(planRelease({ ...fresh, prerelease: true }, f.api), /refusing unsigned/);
  assert.equal(await planRelease({ ...fresh, signingExpected: true }, f.api), 'build');
  // The second prepare call just before gh release create must reject removal too.
  await assert.rejects(planRelease(fresh, f.api), /refusing unsigned/);
  f.routes.set(releasePath, f.release);
  f.routes.set(refPath, f.ref);
  await assert.rejects(planRelease(options, f.api), /refusing unsigned/);
  assert.equal(await planRelease({ ...options, signingExpected: true }, f.api), 'resume');
});

test('unsigned first release and unsigned-to-signed progression remain allowed', async () => {
  const f = fixture();
  f.routes.set(releasePath, null);
  f.routes.set(refPath, null);
  assert.equal(await planRelease({ ...options, resume: false }, f.api), 'build');
  assert.deepEqual(await inspectStable(options, atVersion('1.2.3'), f.api), { mode: 'publish', sha: '' });
  withStable(f, atVersion('1.2.2'));
  assert.equal(await planRelease({ ...options, resume: false }, f.api), 'build');
  assert.equal((await inspectStable(options, atVersion('1.2.3', true), f.api)).mode, 'publish');
});

test('stable recheck rejects a signed-to-unsigned upgrade even after prepare passed', async () => {
  const f = withStable(fixture(), atVersion('1.2.2'));
  f.routes.set(releasePath, null);
  f.routes.set(refPath, null);
  assert.equal(await planRelease({ ...options, resume: false }, f.api), 'build');
  withStable(f, atVersion('1.2.2', true));
  await assert.rejects(inspectStable(options, atVersion('1.2.3'), f.api), /refusing unsigned/);
  assert.equal((await inspectStable(options, atVersion('1.2.3', true), f.api)).mode, 'publish');
});

test('prepare signing-policy lookup fails closed on signature HTTP errors and corrupt feed', async () => {
  const f = withStable(fixture(), atVersion('1.2.2', true));
  f.routes.set(releasePath, null);
  f.routes.set(refPath, null);
  for (const status of [401, 403, 429, 500]) {
    const api = githubClient('fixture', async (url) => {
      const path = new URL(url).pathname + new URL(url).search;
      if (path.includes('/contents/latest.json.sig')) return new Response(null, { status });
      const result = await f.api(path);
      return result === null ? new Response(null, { status: 404 }) : new Response(JSON.stringify(result));
    });
    await assert.rejects(planRelease({ ...options, resume: false }, api), /HTTP/);
  }
  withStable(f, new Map([['manifest.json', Buffer.from('{"version":"1.2.2"}')]]));
  await assert.rejects(planRelease({ ...options, resume: false }, f.api));
});

test('workflow passes only signing presence and checks it before immutable creation', async () => {
  const workflow = await readFile(new URL('../.github/workflows/release-backend.yml', import.meta.url), 'utf8');
  assert.match(workflow, /SIGNING_EXPECTED: \$\{\{ secrets.CHORDV_MANIFEST_SIGNING_KEY != '' \}\}/);
  const creation = workflow.split('      - name: Create GitHub Release')[1].split('      - name: Download')[0];
  assert.ok(creation.indexOf('backend-release-resume.mjs prepare') < creation.indexOf('gh release create "$TAG"'));
  assert.doesNotMatch(creation, /SIGNING_KEY:/);
  const preparation = workflow.split('      - name: Select fresh build')[1].split('      - name: Test release')[0];
  assert.doesNotMatch(preparation, /SIGNING_KEY:/);
  const parsed = releaseOptions({ VERSION: '1.2.3', GITHUB_SHA: options.sha, GITHUB_REPOSITORY: options.repository, PRERELEASE: 'false', RESUME_EXISTING: 'false', SIGNING_EXPECTED: 'true' });
  assert.equal(parsed.signingExpected, true);
  assert.equal(parsed.signingKey, '');
});

test('stable API reads an immutable commit and rejects absent/corrupt content and all server errors', async () => {
  const sha = 'd'.repeat(40);
  const incoming = atVersion('1.2.3');
  const bytes = atVersion('1.2.2').get('manifest.json');
  const branchPath = `${base}/git/ref/heads/backend-manifest`;
  const contentPath = `${base}/contents/latest.json?ref=${sha}`;
  const signaturePath = `${base}/contents/latest.json.sig?ref=${sha}`;
  const ref = { ref: 'refs/heads/backend-manifest', object: { type: 'commit', sha } };
  const content = { type: 'file', encoding: 'base64', size: bytes.length, content: bytes.toString('base64') };
  const routes = new Map([[branchPath, ref], [contentPath, content], [signaturePath, null]]);
  const api = async (path) => { assert.ok(routes.has(path)); return routes.get(path); };
  assert.deepEqual(await inspectStable(options, incoming, api), { mode: 'publish', sha });
  routes.set(branchPath, null);
  assert.deepEqual(await inspectStable(options, incoming, api), { mode: 'publish', sha: '' });
  routes.set(branchPath, ref);
  for (const invalid of [null, {}, { ...content, size: 1 }, { ...content, content: 'invalid!' }]) {
    routes.set(contentPath, invalid);
    await assert.rejects(inspectStable(options, incoming, api));
  }
  for (const status of [401, 403, 429, 500, 502]) {
    const failed = githubClient('fixture', async () => new Response(null, { status }));
    await assert.rejects(inspectStable(options, incoming, failed), /HTTP/);
  }
  const missingFile = githubClient('fixture', async (url) => url.endsWith('/git/ref/heads/backend-manifest') ? new Response(JSON.stringify(ref)) : new Response(null, { status: 404 }));
  await assert.rejects(inspectStable(options, incoming, missingFile), /HTTP 404/);
});

test('stable branch publication retries exact bytes without inherited Git identity', async () => {
  const workflow = await readFile(new URL('../.github/workflows/release-backend.yml', import.meta.url), 'utf8');
  const stable = workflow.split('      - name: Publish manifest to stable raw branch\n')[1];
  const script = stable.split('        run: |\n')[1].split('\n').map((line) => line.startsWith('          ') ? line.slice(10) : line).join('\n');
  const root = await mkdtemp(join(tmpdir(), 'backend-release-test-'));
  try {
    const remote = join(root, 'remote.git');
    const home = join(root, 'home');
    await mkdir(home);
    const env = { ...process.env, HOME: home, TMPDIR: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GH_TOKEN: 'fixture', TAG: options.tag };
    for (const key of Object.keys(env)) if (/^GIT_(AUTHOR|COMMITTER|CONFIG_COUNT|CONFIG_KEY_|CONFIG_VALUE_)/.test(key)) delete env[key];
    const git = (...args) => execFileSync('git', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    git('init', '--bare', '-q', remote);
    const localScript = script.replace('"https://x-access-token:${GH_TOKEN}@github.com/${{ github.repository }}.git"', '"$TEST_REMOTE"');
    // Exercise an unsigned first publication, then signed publications/retries.
    // The signing-continuity guard forbids returning to unsigned after this.
    for (const signed of [false, true, true]) {
      const f = fixture(signed);
      const cwd = await mkdtemp(join(root, 'attempt-'));
      await mkdir(join(cwd, 'published-release'));
      for (const [name, bytes] of f.files) await writeFile(join(cwd, 'published-release', name), bytes);
      const previousSha = git('--git-dir', remote, 'for-each-ref', '--format=%(objectname)', 'refs/heads/backend-manifest').toString().trim();
      const publish = (sha) => execFileSync('/bin/bash', ['-e', '-c', localScript], { cwd, env: { ...env, TEST_REMOTE: remote, STABLE_SHA: sha, GIT_COMMITTER_DATE: sha === '0'.repeat(40) ? '2000-01-01T00:00:00Z' : '2026-09-05T00:00:00Z' }, stdio: ['ignore', 'pipe', 'pipe'] });
      if (previousSha) assert.throws(() => publish('0'.repeat(40)), 'Stale lease must reject concurrent writes');
      publish(previousSha);
      assert.deepEqual(git('--git-dir', remote, 'show', 'backend-manifest:latest.json'), f.files.get('manifest.json'));
      if (signed) assert.deepEqual(git('--git-dir', remote, 'show', 'backend-manifest:latest.json.sig'), f.files.get('manifest.json.sig'));
      else assert.throws(() => git('--git-dir', remote, 'show', 'backend-manifest:latest.json.sig'));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('workflow gates all mutable build steps, verifies before stable and never upserts assets', async () => {
  const workflow = await readFile(new URL('../.github/workflows/release-backend.yml', import.meta.url), 'utf8');
  assert.match(workflow, /resume_existing:/);
  assert.match(workflow, /group: chordv-backend-release\n\s+cancel-in-progress: false/);
  for (const name of ['Setup pnpm', 'Setup Node', 'Install dependencies', 'Run API regression tests', 'Build backend system (shared + api + admin)', 'Assemble relocatable release tree', 'Generate manifest.json', 'Sign manifest (ed25519, if signing key configured)', 'Create GitHub Release (never update or clobber existing assets)']) {
    assert.ok(workflow.includes(`- name: ${name}\n        if: steps.publication.outputs.mode == 'build'`), `${name} must skip resume`);
  }
  assert.doesNotMatch(workflow, /action-gh-release|--clobber|gh release (upload|edit|delete)/);
  assert.match(workflow, /gh release create/);
  assert.match(workflow, /cp published-release\/manifest.json "\$tmp\/latest.json"/);
  assert.match(workflow, /cp published-release\/manifest.json.sig "\$tmp\/latest.json.sig"/);
  assert.ok(workflow.indexOf('backend-release-resume.mjs verify') < workflow.indexOf('- name: Publish manifest to stable raw branch'));
  assert.match(workflow, /if: \$\{\{ github.event.inputs.prerelease != 'true' \}\}/);
  assert.match(workflow, /cd "\$tmp"\n\s+git init -q\n\s+git config user.name/);
  assert.match(workflow, /--force-with-lease="refs\/heads\/backend-manifest:\$\{STABLE_SHA\}"/);
  assert.doesNotMatch(workflow, /git push -q -f /);
  assert.match(workflow, /steps.stable.outputs.mode == 'publish'/);
  assert.ok(workflow.indexOf('backend-release-resume.mjs stable') < workflow.indexOf('- name: Publish manifest to stable raw branch'));
  assert.match(workflow, /permissions:\n  contents: read/);
  assert.match(workflow, /permissions:\n      contents: write/);
});


test('signed assets bind channel to release kind and cannot enter stable as prerelease', () => {
  const f = fixture(true);
  mutateManifest(f, manifest => { manifest.channel = 'prerelease'; });
  f.files.set('manifest.json.sig', Buffer.from(sign(null, f.files.get('manifest.json'), privateKey).toString('base64')));
  assert.equal(verifyReleaseBytes({ ...options, prerelease: true, signingKey }, f.files), f.files);
  assert.throws(() => verifyReleaseBytes({ ...options, signingKey }, f.files), /channel mismatch/);
  assert.throws(() => guardStableBytes(options, f.files, null), /stable channel/);
  mutateManifest(f, manifest => { manifest.channel = 'stable'; });
  assert.throws(() => verifyReleaseBytes({ ...options, signingKey }, f.files), /signature mismatch/);
  const legacy = fixture(); mutateManifest(legacy, manifest => { delete manifest.channel; });
  assert.throws(() => verifyReleaseBytes(options, legacy.files), /channel mismatch/);
});

test('workflow generates the channel claim inside the exact signed manifest bytes', async () => {
  const workflow = await readFile(new URL('../.github/workflows/release-backend.yml', import.meta.url), 'utf8');
  const step = workflow.split('- name: Generate manifest.json')[1].split('- name: Sign manifest')[0];
  const code = step.match(/node -e '([\s\S]*?)'\n/)?.[1];
  assert.ok(code);
  const root = await mkdtemp(join(tmpdir(), 'backend-channel-test-'));
  try {
    for (const prerelease of ['true', 'false']) {
      execFileSync(process.execPath, ['-e', code], { cwd: root, env: { ...process.env, PRERELEASE: prerelease,
        VERSION: '1.2.3', TAG: 'backend-v1.2.3', REPO: options.repository, CHANGELOG: '', SHA: 'a'.repeat(64), SIZE: '10',
        URL: 'https://example.com/package', PUBLISHED_AT: '2026-09-05T00:00:00Z' } });
      assert.equal(JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')).channel, prerelease === 'true' ? 'prerelease' : 'stable');
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
