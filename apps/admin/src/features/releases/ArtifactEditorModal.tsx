import { Alert, Badge, Button, FileInput, Group, Modal, Select, SegmentedControl, Stack, Switch, Text, TextInput } from "@mantine/core";
import type { ArtifactEditorFormState } from "./types";
import { isDesktopReleasePlatform, releaseArtifactTypeOptionsForPlatform } from "./types";
import type { AdminReleasePlatform } from "../../api/client";

type ArtifactEditorModalProps = {
  opened: boolean;
  saving: boolean;
  creatingRelease: boolean;
  title: string;
  submitLabel: string;
  platform: AdminReleasePlatform;
  form: ArtifactEditorFormState;
  onClose: () => void;
  onChange: (value: ArtifactEditorFormState) => void;
  onSubmit: () => void;
};

export function ArtifactEditorModal(props: ArtifactEditorModalProps) {
  const usesExternalLink = props.form.source === "external" || props.form.type === "external";
  const typeOptions = releaseArtifactTypeOptionsForPlatform(props.platform, props.form.type);
  const defaultType = defaultArtifactTypeForPlatform(props.platform);
  const showFullPackageToggle = !isDesktopReleasePlatform(props.platform);

  return (
    <Modal opened={props.opened} onClose={props.onClose} title={props.title} centered size="lg">
      <Stack gap="md">
        <SegmentedControl
          value={usesExternalLink ? "external" : "uploaded"}
          onChange={(value) =>
            props.onChange({
              ...props.form,
              source: value as ArtifactEditorFormState["source"],
              type: props.form.type === "external" ? defaultType : props.form.type
            })
          }
          data={[
            { label: "上传安装器", value: "uploaded" },
            { label: "外部安装器链接", value: "external" }
          ]}
        />

        <Select
          label="产物类型"
          data={typeOptions as unknown as { value: string; label: string }[]}
          value={props.form.type}
          onChange={(value) =>
            value &&
            props.onChange({
              ...props.form,
              type: value as ArtifactEditorFormState["type"],
              source: value === "external" ? "external" : props.form.source
            })
          }
        />

        {props.platform === "macos" || props.platform === "windows" ? (
          <Alert color="blue" variant="light">
            桌面端发布中心现在只保留安装器：macOS 使用 DMG，Windows 使用 Setup 安装器。
          </Alert>
        ) : null}

        {usesExternalLink ? (
          <>
            <Alert color="blue" variant="light">
              {props.creatingRelease
                ? "保存后会一次性创建发布记录和首个外部安装产物，不会留下空白草稿。文件大小、Hash 这类元信息由后端探测后再回填。"
                : "这里先只保留外链本身和加速前缀。文件大小、Hash 这类元信息由后端探测后再回填，前端不再摆空字段。"}
            </Alert>
            {(props.form.fileSizeBytes !== "" || props.form.fileHash.trim() || props.form.fileName.trim()) ? (
              <Stack gap={6}>
                <Text size="sm" fw={500}>
                  已回填的元信息
                </Text>
                <Group gap="xs" wrap="wrap">
                  {props.form.fileName.trim() ? <Badge variant="light">文件名：{props.form.fileName.trim()}</Badge> : null}
                  {props.form.fileSizeBytes !== "" ? <Badge variant="light">大小：{props.form.fileSizeBytes} 字节</Badge> : null}
                  {props.form.fileHash.trim() ? <Badge variant="light">Hash：{props.form.fileHash.trim()}</Badge> : null}
                </Group>
              </Stack>
            ) : null}
            <TextInput
              label="下载地址"
              placeholder={
                props.platform === "windows"
                  ? "https://github.com/你的仓库/releases/download/v1.0.2/ChordV_1.0.2_x64-setup.exe"
                  : "https://github.com/你的仓库/releases/download/v1.0.2/ChordV_1.0.2.dmg"
              }
              value={props.form.downloadUrl}
              onChange={(event) => props.onChange({ ...props.form, downloadUrl: event.currentTarget.value })}
            />
            <TextInput
              label="默认加速前缀"
              description="可选。直接填写加速域名前缀即可，比如 https://ghfast.top/ 。留空时就直接使用原始下载地址。"
              placeholder="例如 https://ghfast.top/"
              value={props.form.defaultMirrorPrefix}
              onChange={(event) => props.onChange({ ...props.form, defaultMirrorPrefix: event.currentTarget.value })}
            />
            <Switch
              checked={props.form.allowClientMirror}
              onChange={(event) => props.onChange({ ...props.form, allowClientMirror: event.currentTarget.checked })}
              label="允许客户端自定义加速前缀覆盖默认值"
            />
            <TextInput
              label="文件名"
              placeholder="可选，用于展示安装器名称"
              value={props.form.fileName}
              onChange={(event) => props.onChange({ ...props.form, fileName: event.currentTarget.value })}
            />
          </>
        ) : (
          <>
            <FileInput
              label="安装包文件"
              placeholder="选择安装包文件"
              value={props.form.selectedFile}
              onChange={(file) => props.onChange({ ...props.form, selectedFile: file, fileName: file?.name ?? props.form.fileName })}
              clearable
            />
            <Alert color="blue" variant="light">
              {props.creatingRelease
                ? "上传模式下会先创建发布记录，再上传首个安装包；如果上传失败，系统会自动清理，不会留下空白草稿。"
                : "上传后会自动生成下载地址、文件大小和 Hash。这里只需要确认更新入口。"}
            </Alert>
            {props.form.downloadUrl ? (
              <Stack gap={4}>
                <Text size="sm" fw={500}>
                  系统生成的下载地址
                </Text>
                <Text size="sm" c="dimmed">
                  {props.form.downloadUrl}
                </Text>
              </Stack>
            ) : null}
            {(props.form.fileSizeBytes !== "" || props.form.fileHash.trim()) ? (
              <Group grow align="flex-start">
                {props.form.fileSizeBytes !== "" ? (
                  <Stack gap={4}>
                    <Text size="sm" fw={500}>
                      文件大小
                    </Text>
                    <Badge variant="light">{props.form.fileSizeBytes} 字节</Badge>
                  </Stack>
                ) : null}
                {props.form.fileHash.trim() ? (
                  <Stack gap={4}>
                    <Text size="sm" fw={500}>
                      文件 Hash
                    </Text>
                    <Text size="sm" c="dimmed">
                      {props.form.fileHash}
                    </Text>
                  </Stack>
                ) : null}
              </Group>
            ) : null}
          </>
        )}

        <Group grow>
          <Switch
            checked={props.form.isPrimary}
            onChange={(event) => props.onChange({ ...props.form, isPrimary: event.currentTarget.checked })}
            label="客户端更新入口"
          />
          {showFullPackageToggle ? (
            <Switch
              checked={props.form.isFullPackage}
              onChange={(event) => props.onChange({ ...props.form, isFullPackage: event.currentTarget.checked })}
              label="完整安装包"
            />
          ) : null}
        </Group>

        <Group justify="flex-end">
          <Button variant="default" onClick={props.onClose}>
            取消
          </Button>
          <Button onClick={props.onSubmit} loading={props.saving}>
            {props.submitLabel}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function defaultArtifactTypeForPlatform(platform: AdminReleasePlatform): ArtifactEditorFormState["type"] {
  if (platform === "windows") {
    return "setup.exe";
  }
  if (platform === "android") {
    return "apk";
  }
  if (platform === "ios") {
    return "ipa";
  }
  return "dmg";
}
