import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildExternalArtifactPayload } from "../src/features/releases/artifactPayloads";
import { buildCreateReleasePayload, buildUpdateReleasePayload, emptyReleaseEditorForm } from "../src/features/releases/types";

const releaseRecordCardSource = readFileSync(resolve(import.meta.dirname, "../src/features/releases/ReleaseRecordCard.tsx"), "utf8");
const adminClientSource = readFileSync(resolve(import.meta.dirname, "../src/api/client.ts"), "utf8");
const releasesPageSource = readFileSync(resolve(import.meta.dirname, "../src/pages/ReleasesPage.tsx"), "utf8");

function extractAsyncFunctionBody(source: string, functionName: string) {
  const signature = `async function ${functionName}`;
  const signatureIndex = source.indexOf(signature);
  assert.notEqual(signatureIndex, -1, `${functionName} should exist`);

  const bodyStart = source.indexOf("{", signatureIndex);
  assert.notEqual(bodyStart, -1, `${functionName} should have a body`);

  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(bodyStart + 1, index);
      }
    }
  }

  assert.fail(`${functionName} body should be closed`);
}

function testCreateReleasePayloadKeepsReleaseFieldsSimple() {
  const form = {
    ...emptyReleaseEditorForm("windows"),
    version: " 1.2.0 ",
    title: "  Windows 1.2.0  ",
    changelog: "Support release publishing\n\nFix admin release flow"
  };

  const payload = buildCreateReleasePayload(form);

  assert.deepEqual(payload, {
    platform: "windows",
    status: "draft",
    version: "1.2.0",
    title: "Windows 1.2.0",
    changelog: ["Support release publishing", "Fix admin release flow"]
  });
  assert.equal("minimumVersion" in payload, false, "backend should default minimumVersion to the release version");
  assert.equal("forceUpgrade" in payload, false, "forceUpgrade must not be required for ordinary releases");
}

function testCreateReleasePayloadOmitsOptionalPublishingFlags() {
  const form = {
    ...emptyReleaseEditorForm("macos"),
    version: " 2.0.1 ",
    title: "",
    changelog: ""
  };

  const payload = buildCreateReleasePayload(form);

  assert.equal(payload.title, undefined);
  assert.equal("minimumVersion" in payload, false);
  assert.equal("forceUpgrade" in payload, false);
}

function testCreateAdminReleaseRequestDoesNotForceDisplayTitle() {
  assert.doesNotMatch(
    adminClientSource,
    /const title = input\.title\?\.trim\(\) \|\| version/,
    "admin API client must not force displayTitle to the version before sending create release"
  );
  assert.match(
    adminClientSource,
    /\.\.\.\(input\.title !== undefined \? \{ displayTitle: title \} : \{\}\)/,
    "admin API client should only send displayTitle when the release form provided a title field"
  );
}

function testUpdateReleasePayloadDoesNotSendVersionOrPublishingFlags() {
  const form = {
    ...emptyReleaseEditorForm("windows"),
    version: "1.1.7",
    title: "  Windows 1.1.7  ",
    changelog: "Fix admin release\n\nImprove download"
  };

  const payload = buildUpdateReleasePayload(form);

  assert.deepEqual(payload, {
    title: "Windows 1.1.7",
    changelog: ["Fix admin release", "Improve download"]
  });
  assert.equal("version" in payload, false, "release edits must not send the immutable version field");
  assert.equal("minimumVersion" in payload, false, "simple release edits must not change minimumVersion");
  assert.equal("forceUpgrade" in payload, false, "simple release edits must not change forceUpgrade");
}

function testBlankUpdateReleaseTitleDoesNotFallbackToVersion() {
  const form = {
    ...emptyReleaseEditorForm("windows"),
    version: "1.1.7",
    title: "  ",
    changelog: ""
  };

  const payload = buildUpdateReleasePayload(form);

  assert.deepEqual(payload, {
    title: "",
    changelog: []
  });
  assert.equal("version" in payload, false, "blank title edits must not silently reuse version as display title");
}

function testWindowsZipExternalArtifactCanStayExternalDownload() {
  const payload = buildExternalArtifactPayload(
    "windows",
    " https://cdn.example.com/ChordV_1.1.6_x64-full.zip ",
    true,
    "external_download"
  );

  assert.equal(payload.source, "external");
  assert.equal(payload.type, "external");
  assert.equal(payload.deliveryMode, "external_download");
  assert.equal(payload.downloadUrl, "https://cdn.example.com/ChordV_1.1.6_x64-full.zip");
  assert.equal(payload.fileName, "ChordV_1.1.6_x64-full.zip");
  assert.equal(payload.isPrimary, true);
}

function testWindowsZipExternalArtifactCanBeFullReplaceWhenExplicit() {
  const payload = buildExternalArtifactPayload(
    "windows",
    "https://cdn.example.com/ChordV_1.1.6_x64-full.zip",
    true,
    "windows_full_replace_zip"
  );

  assert.equal(payload.source, "external");
  assert.equal(payload.type, "zip");
  assert.equal(payload.deliveryMode, "desktop_full_replace");
}

function testWindowsNonZipExternalArtifactCanBeFullReplaceWhenExplicit() {
  const payload = buildExternalArtifactPayload(
    "windows",
    " https://cdn.example.com/download?id=ChordV_1.1.6_x64-full ",
    true,
    "windows_full_replace_zip"
  );

  assert.equal(payload.source, "external");
  assert.equal(payload.type, "zip");
  assert.equal(payload.deliveryMode, "desktop_full_replace");
  assert.equal(payload.downloadUrl, "https://cdn.example.com/download?id=ChordV_1.1.6_x64-full");
  assert.equal(payload.isPrimary, true);
}

function testReleaseArtifactLongDownloadUrlDoesNotForceWideCards() {
  assert.match(releaseRecordCardSource, /lineClamp=\{2\}/);
  assert.match(releaseRecordCardSource, /overflowWrap: "anywhere"/);
}

function testReleaseMutationsAlwaysReleaseSavingState() {
  for (const functionName of ["saveRelease", "updateReleaseStatus", "deleteRelease", "saveArtifact", "removeArtifact"]) {
    const body = extractAsyncFunctionBody(releasesPageSource, functionName);
    assert.match(
      body,
      /finally\s*{[\s\S]*?endSaving\(actionKey\);[\s\S]*?}/,
      `${functionName} must release page saving state after success, failure, or uncertain request state`
    );
  }
}

function testReleaseUncertainMutationsRefreshInsteadOfHardFailing() {
  for (const functionName of ["updateReleaseStatus", "deleteRelease", "saveArtifact", "removeArtifact"]) {
    const body = extractAsyncFunctionBody(releasesPageSource, functionName);
    assert.match(
      body,
      /showReleaseRequestFailure\([\s\S]*?if \(result\.uncertain\) {[\s\S]*?void loadReleases\(\);[\s\S]*?}/,
      `${functionName} should refresh release data when the backend result is uncertain`
    );
  }
}

function testSaveArtifactCommitsMutationSeqBeforeLocalState() {
  const body = extractAsyncFunctionBody(releasesPageSource, "saveArtifact");
  const firstMutationIndex = body.indexOf("releaseMutationSeqRef.current += 1;");
  const recordGuardIndex = body.indexOf("if (!record)");
  const localStateIndex = body.indexOf("setReleases((current) => upsertRelease(current, record));");
  const commitIndex = body.lastIndexOf("releaseMutationSeqRef.current += 1;", localStateIndex);

  assert.ok(firstMutationIndex >= 0, "saveArtifact should mark mutation start before artifact API calls");
  assert.ok(recordGuardIndex > firstMutationIndex, "saveArtifact should validate API result after mutation start");
  assert.ok(commitIndex > recordGuardIndex, "saveArtifact should mark mutation commit after artifact API success");
  assert.ok(localStateIndex > commitIndex, "saveArtifact should commit mutation seq before updating local release state");
}

function testCreateReleaseIsBlockedWhileAnotherMutationIsSaving() {
  assert.match(
    releasesPageSource,
    /function openCreateRelease\(\) {[\s\S]*?if \(savingRef\.current\) {[\s\S]*?return;[\s\S]*?}/,
    "release create modal must not open while another release mutation is saving"
  );
  assert.match(
    releasesPageSource,
    /<Button leftSection=\{<IconPlus size=\{16\} \/>\} onClick=\{openCreateRelease\} disabled=\{saving !== null\}>/,
    "new release button should be disabled during publish, delete, upload, and artifact mutations"
  );
}

testCreateReleasePayloadKeepsReleaseFieldsSimple();
testCreateReleasePayloadOmitsOptionalPublishingFlags();
testCreateAdminReleaseRequestDoesNotForceDisplayTitle();
testUpdateReleasePayloadDoesNotSendVersionOrPublishingFlags();
testBlankUpdateReleaseTitleDoesNotFallbackToVersion();
testWindowsZipExternalArtifactCanStayExternalDownload();
testWindowsZipExternalArtifactCanBeFullReplaceWhenExplicit();
testWindowsNonZipExternalArtifactCanBeFullReplaceWhenExplicit();
testReleaseArtifactLongDownloadUrlDoesNotForceWideCards();
testReleaseMutationsAlwaysReleaseSavingState();
testReleaseUncertainMutationsRefreshInsteadOfHardFailing();
testSaveArtifactCommitsMutationSeqBeforeLocalState();
testCreateReleaseIsBlockedWhileAnotherMutationIsSaving();

console.log("release admin regression checks passed");
