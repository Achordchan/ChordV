import { Stack, Text, TextInput } from "@mantine/core";
import type { AdminReleasePlatform } from "../../api/client";

// Same rule as the server: CI names installers …_build42.dmg / …_build42_x64-setup.exe.
function detectBuildNumber(url: string) {
  const name = url.split(/[?#]/)[0]?.split("/").pop() ?? "";
  const match = /_build(\d{1,9})(?=[_.])/i.exec(name);
  return match && Number(match[1]) > 0 ? Number(match[1]) : null;
}

export function RemoteArtifactSourceFields(props: { value: string; platform: AdminReleasePlatform; disabled: boolean; onChange: (url: string) => void }) {
  const build = detectBuildNumber(props.value);
  return <Stack gap={8}>
    <TextInput label="安装包来源地址" placeholder="https://github.com/…/releases/download/…" value={props.value} disabled={props.disabled} onChange={event => props.onChange(event.currentTarget.value)} />
    <Text size="xs" c="dimmed">后台获取后保存到本站，自动计算文件大小与 SHA-256。大小上限沿用本站上传配置。</Text>
    {props.platform === "windows" && <Text size="xs" c="dimmed">Windows 使用 Setup EXE，后台会同时获取同地址加 .sig 的更新签名。</Text>}
    {build ? <Text size="xs" c="teal.9">识别到构建号 {build}：同一版本号的更高构建会推送给已安装旧构建的客户端。</Text> : null}
  </Stack>;
}
