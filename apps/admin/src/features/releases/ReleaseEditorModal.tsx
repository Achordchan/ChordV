import { Alert, Button, FileInput, Group, Modal, SegmentedControl, Select, Stack, Text, TextInput, Textarea } from "@mantine/core";
import type { ReleaseEditorFormState } from "./types";
import { releasePlatformOptions } from "./types";

type ReleaseEditorModalProps = {
  opened: boolean;
  editing: boolean;
  saving: boolean;
  savingMessage?: string | null;
  title: string;
  submitLabel: string;
  form: ReleaseEditorFormState;
  artifactEditingDisabled?: boolean;
  onClose: () => void;
  onChange: (value: ReleaseEditorFormState) => void;
  onManageArtifact?: (source: ReleaseEditorFormState["artifactSource"]) => void;
  onSubmit: () => void;
};

export function ReleaseEditorModal(props: ReleaseEditorModalProps) {
  const close = () => {
    if (!props.saving) {
      props.onClose();
    }
  };
  const savingMessage =
    props.savingMessage ??
    (!props.saving
      ? null
      : !props.editing && props.form.artifactSource === "uploaded" && props.form.selectedFile
        ? "正在创建发布记录并上传安装包，大文件上传期间请等待当前请求返回。"
        : props.editing
          ? "正在保存发布记录，请等待当前请求返回。"
          : "正在创建发布记录，请等待当前请求返回。");

  return (
    <Modal
      opened={props.opened}
      onClose={close}
      title={props.title}
      centered
      size="lg"
      closeOnClickOutside={!props.saving}
      closeOnEscape={!props.saving}
    >
      <Stack gap="md">
        {savingMessage ? (
          <Alert color="yellow" variant="light">
            {savingMessage}
          </Alert>
        ) : null}

        <Select
          label="平台"
          data={releasePlatformOptions as unknown as { value: string; label: string }[]}
          value={props.form.platform}
          onChange={(value) =>
            value &&
            props.onChange({
              ...props.form,
              platform: value as ReleaseEditorFormState["platform"],
              selectedFile: null,
              fileName: ""
            })
          }
          disabled={props.editing || props.saving}
        />

        <TextInput
          label="版本号"
          placeholder="例如 1.1.6"
          value={props.form.version}
          onChange={(event) => props.onChange({ ...props.form, version: event.currentTarget.value })}
          disabled={props.editing || props.saving}
        />

        <TextInput
          label="发布标题"
          placeholder="例如 ChordV 1.1.6 · Windows"
          value={props.form.title}
          onChange={(event) => props.onChange({ ...props.form, title: event.currentTarget.value })}
          disabled={props.saving}
        />

        {!props.editing ? (
          <>
            <SegmentedControl
              value={props.form.artifactSource}
              onChange={(value) =>
                props.onChange({
                  ...props.form,
                  artifactSource: value as ReleaseEditorFormState["artifactSource"]
                })
              }
              data={[
                { value: "external", label: "外链地址" },
                { value: "uploaded", label: "上传文件" }
              ]}
              disabled={props.saving}
            />

            {props.form.artifactSource === "external" ? (
              <TextInput
                label="外链下载地址"
                placeholder="https://example.com/ChordV_1.1.6_x64-full.zip"
                value={props.form.downloadUrl}
                onChange={(event) => props.onChange({ ...props.form, downloadUrl: event.currentTarget.value })}
                disabled={props.saving}
              />
            ) : (
              <FileInput
                label="上传安装包文件"
                description="也保留本地上传路径；如果外链下载慢，可以上传到服务器。"
                placeholder="选择安装包文件"
                accept={acceptedArtifactExtensionForPlatform(props.form.platform)}
                value={props.form.selectedFile}
                onChange={(file) =>
                  props.onChange({
                    ...props.form,
                    artifactSource: "uploaded",
                    selectedFile: file,
                    fileName: file?.name ?? props.form.fileName
                  })
                }
                clearable
                disabled={props.saving}
              />
            )}

            <Alert color="blue" variant="light">
              {props.form.artifactSource === "external"
                ? "外链会直接下发给客户端，不经过本地服务器中转下载；也可以先留空创建草稿，稍后再补。"
                : "上传文件会保存到本地服务器；也可以先不选文件创建草稿，稍后再上传。"}
            </Alert>
          </>
        ) : (
          <Alert color={props.artifactEditingDisabled ? "yellow" : "blue"} variant="light">
            <Stack gap="xs">
              <Text size="sm">
                已有发布记录的安装包入口仍然保留：可以继续添加外链，也可以上传文件。
              </Text>
              <Group gap="xs">
                <Button
                  size="xs"
                  variant="default"
                  disabled={props.saving || props.artifactEditingDisabled || !props.onManageArtifact}
                  onClick={() => props.onManageArtifact?.("external")}
                >
                  添加外链
                </Button>
                <Button
                  size="xs"
                  variant="light"
                  disabled={props.saving || props.artifactEditingDisabled || !props.onManageArtifact}
                  onClick={() => props.onManageArtifact?.("uploaded")}
                >
                  上传文件
                </Button>
              </Group>
              {props.artifactEditingDisabled ? (
                <Text size="xs" c="dimmed">
                  已发布版本需要先撤回到草稿，才能新增、替换或删除安装包。
                </Text>
              ) : null}
            </Stack>
          </Alert>
        )}

        <Textarea
          label="更新日志"
          minRows={6}
          placeholder={"每行一条更新说明\n例如：修复 Windows 托盘断开异常"}
          value={props.form.changelog}
          onChange={(event) => props.onChange({ ...props.form, changelog: event.currentTarget.value })}
          disabled={props.saving}
        />

        <Group justify="flex-end">
          <Button variant="default" onClick={close} disabled={props.saving}>
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

function acceptedArtifactExtensionForPlatform(platform: ReleaseEditorFormState["platform"]) {
  if (platform === "windows") {
    return ".zip";
  }
  if (platform === "android") {
    return ".apk";
  }
  if (platform === "ios") {
    return ".ipa";
  }
  return ".dmg";
}
