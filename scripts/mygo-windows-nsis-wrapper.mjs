import { spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { transformMyGoNSIS } from "./mygo-windows-nsis.mjs";

const [configFile, ...args] = process.argv.slice(2);
let temporary;
try {
  const config = JSON.parse(await readFile(configFile, "utf8"));
  if (!path.isAbsolute(config.compiler) || !path.isAbsolute(config.launcher)
    || await realpath(config.compiler) === await realpath(config.launcher)) throw new Error("makensis wrapper 编译器无效或发生递归");
  let forwarded = args;
  if (!(args.length === 1 && ["-VERSION", "/VERSION"].includes(args[0]))) {
    const inputs = args.flatMap((arg, index) => /\.nsi$/i.test(arg) && !/^[/-][A-Za-z]+[=:]/.test(arg) ? [index] : []);
    if (inputs.length !== 1) throw new Error("makensis wrapper 必须收到唯一 NSIS 文件参数");
    const input = path.resolve(args[inputs[0]]);
    if (path.basename(input) !== "installer.nsi" || !(await stat(input)).isFile()) throw new Error("makensis wrapper 仅接受 MyGo 的 installer.nsi");
    const transformed = transformMyGoNSIS(await readFile(input, "utf8"), config);
    temporary = await mkdtemp(path.join(path.dirname(input), ".chordv-passive-"));
    const transformedFile = path.join(temporary, "installer.nsi");
    await writeFile(transformedFile, transformed);
    forwarded = args.map((arg, index) => index === inputs[0] ? transformedFile : arg);
  }
  const code = await new Promise((resolve, reject) => {
    const child = spawn(config.compiler, forwarded, { stdio: "inherit", windowsHide: true, shell: false });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
  process.exitCode = code;
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
} finally {
  if (temporary) await rm(temporary, { recursive: true, force: true });
}
