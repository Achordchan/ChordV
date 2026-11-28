import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { require as requireTypeScript } from "tsx/cjs/api";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
export const nodeCountryDataPath = path.join(root, "apps/server/internal/api/node_patch_countries.json");
const sourcePath = path.join(root, "packages/shared/src/countries.ts");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function lockedCountryVersion(lock) {
  const lines = lock.split(/\r?\n/);
  const start = lines.indexOf("  packages/shared:");
  if (start < 0) throw new Error("锁文件缺少 packages/shared importer");
  const section = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() && !line.startsWith("    ")) break;
    section.push(line);
  }
  const dependency = section.indexOf("      i18n-iso-countries:");
  if (dependency < 0) throw new Error("锁文件缺少 shared 的 i18n-iso-countries");
  for (const line of section.slice(dependency + 1)) {
    if (!line.startsWith("        ")) break;
    const match = line.match(/^        version: ['"]?([^\s'"]+)['"]?$/);
    if (match) return match[1];
  }
  throw new Error("无法读取锁定的 ISO 国家库版本");
}

function sourceAliases(source) {
  const tree = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true);
  for (const statement of tree.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (declaration.name.getText(tree) !== "COUNTRY_CODE_ALIASES") continue;
      assert.ok(declaration.initializer && ts.isObjectLiteralExpression(declaration.initializer), "国家别名声明结构已变化，请更新生成器");
      return declaration.initializer.properties.map((entry) => {
        assert.ok(ts.isPropertyAssignment(entry) && (ts.isStringLiteral(entry.name) || ts.isIdentifier(entry.name)), "国家别名键结构已变化");
        return entry.name.text;
      });
    }
  }
  throw new Error("共享国家源码缺少 COUNTRY_CODE_ALIASES，请更新生成器");
}

export function buildNodeCountryData() {
  const sharedRequire = createRequire(path.join(root, "packages/shared/package.json"));
  const iso = sharedRequire("i18n-iso-countries");
  const isoDirectory = path.dirname(sharedRequire.resolve("i18n-iso-countries/package.json"));
  const isoPackage = JSON.parse(readFileSync(path.join(isoDirectory, "package.json"), "utf8"));
  const lockedVersion = lockedCountryVersion(readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8"));
  assert.equal(isoPackage.version, lockedVersion, "已安装 ISO 库与锁文件不一致，请先执行 pnpm install --frozen-lockfile");
  const source = readFileSync(sourcePath, "utf8");
  const helper = requireTypeScript(sourcePath, import.meta.url);
  const codes = {}, names = {}, upperExpansions = {};
  for (const code of [...Object.keys(iso.getAlpha2Codes()), ...Object.keys(iso.getAlpha3Codes()), ...Object.keys(iso.getNumericCodes())]) {
    codes[code] = helper.getCountryNameFromCode(code);
    assert.equal(typeof codes[code], "string", `国家代码 ${code} 没有标签`);
  }
  for (const lang of ["zh", "en"]) {
    for (const labels of Object.values(iso.getNames(lang, { select: "all" }))) {
      for (const label of Array.isArray(labels) ? labels : [labels]) names[label.toLowerCase()] = helper.getCountryCodeFromName(label);
    }
  }
  for (const alias of sourceAliases(source)) names[alias] = helper.getCountryCodeFromName(alias);
  for (const [name, code] of Object.entries(names)) assert.ok(codes[code], `国家名称 ${name} 没有有效代码`);
  for (let code = 0; code <= 0x10ffff; code++) {
    const rune = String.fromCodePoint(code), upper = rune.toUpperCase();
    if ([...upper].length > 1) upperExpansions[rune] = upper;
  }
  const isoInputs = ["package.json", "codes.json", "langs/zh.json", "langs/en.json"].map((file) => [file, sha256(readFileSync(path.join(isoDirectory, file)))]);
  return {
    source: {
      shared: "packages/shared/src/countries.ts", sha256: sha256(source),
      isoVersion: isoPackage.version, isoLockedVersion: lockedVersion,
      isoDataSha256: sha256(JSON.stringify(isoInputs)),
      generator: "scripts/mygo-node-country-data.mjs",
      note: "Generated from the current shared country helper. Run node scripts/mygo-node-country-data.mjs --write, then review the diff; --check is read-only.",
      isoLicense: readFileSync(path.join(isoDirectory, "LICENSE"), "utf8")
    }, codes, names, upperExpansions
  };
}

export function assertNodeCountryDataCurrent(current, saved) {
  assert.equal(saved.source.sha256, current.source.sha256, "共享国家源码已变化，请重生成并复核 Go 国家数据");
  assert.equal(saved.source.isoLockedVersion, current.source.isoLockedVersion, "锁定的 ISO 版本已变化，请重生成并复核 Go 国家数据");
  assert.equal(JSON.stringify(saved), JSON.stringify(current), "Go 国家数据与当前源码/依赖不一致，请运行 node scripts/mygo-node-country-data.mjs --write 并复核差异");
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args[0] && !["--check", "--write"].includes(args[0]))) throw new Error("参数只能为 --check 或 --write；默认只读检查");
  const data = buildNodeCountryData();
  if (args[0] === "--write") writeFileSync(nodeCountryDataPath, JSON.stringify(data, null, 2) + "\n");
  else assertNodeCountryDataCurrent(data, JSON.parse(readFileSync(nodeCountryDataPath, "utf8")));
  process.stdout.write(`国家数据${args[0] === "--write" ? "已重生成" : "检查通过"}：${Object.keys(data.codes).length} 代码，${Object.keys(data.names).length} 名称，ISO ${data.source.isoLockedVersion}\n`);
}
