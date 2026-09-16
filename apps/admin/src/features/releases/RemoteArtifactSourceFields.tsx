import { Stack, Text, TextInput } from "@mantine/core";
import type { AdminReleasePlatform } from "../../api/client";

export function RemoteArtifactSourceFields(props: { value: string; platform: AdminReleasePlatform; disabled: boolean; onChange: (url: string) => void }) {
  return <Stack gap={8}>
    <TextInput label="安装包来源地址" placeholder="https://github.com/…/releases/download/…" value={props.value} disabled={props.disabled} onChange={event => props.onChange(event.currentTarget.value)} />
    <Text size="xs" c="dimmed">后台获取后保存到本站，自动计算文件大小与 SHA-256。大小上限沿用本站上传配置。</Text>
    {props.platform === "windows" && <Text size="xs" c="dimmed">Windows 使用 Setup EXE，后台会同时获取同地址加 .sig 的更新签名。</Text>}
  </Stack>;
}
