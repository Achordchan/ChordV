import { useState } from "react";
import {
  Alert,
  Button,
  Collapse,
  FileInput,
  Group,
  Modal,
  Select,
  SegmentedControl,
  Stack,
  Switch,
  Text,
  TextInput,
  Textarea
} from "@mantine/core";
import type { RuntimeComponentEditorFormState } from "./types";
import {
  defaultFileNameForKind,
  runtimeComponentArchitectureOptions,
  runtimeComponentPlatformOptions
} from "./types";

type RuntimeComponentEditorModalProps = {
  opened: boolean;
  editing: boolean;
  saving: boolean;
  value: RuntimeComponentEditorFormState;
  uploadMaxBytes: number;
  onChange: (next: RuntimeComponentEditorFormState) => void;
  onClose: () => void;
  onSubmit: () => void;
};

export function RuntimeComponentEditorModal(props: RuntimeComponentEditorModalProps) {
  const { opened, editing, saving, value, uploadMaxBytes, onChange, onClose, onSubmit } = props;
  const usesUploadedSource = value.source === "uploaded";
  const isRuleset = value.kind === "geoip" || value.kind === "geosite";
  const [showAdvanced, setShowAdvanced] = useState(false);
  const kindLabel = value.kind === "xray" ? "Xray" : value.kind === "geoip" ? "GeoIP" : "GeoSite";

  const handleClose = () => {
    if (saving) {
      return;
    }
    onClose();
  };

  return (
    <Modal
      opened={opened}
      onClose={handleClose}
      title={editing ? `配置 ${kindLabel}` : `添加 ${kindLabel}`}
      centered
      size="lg"
      closeOnClickOutside={!saving}
      closeOnEscape={!saving}
      closeButtonProps={{ disabled: saving }}
    >
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          {isRuleset
            ? "Geo 数据全平台共用一份，填更新地址和加速镜像即可。"
            : "Xray 按平台和架构分别配置；优先填更新地址，需要时再上传到服务器。"}
        </Text>

        <SegmentedControl
          value={usesUploadedSource ? "uploaded" : "remote"}
          onChange={(next) =>
            onChange({
              ...value,
              source: next === "uploaded" ? "uploaded" : "custom_remote",
              defaultMirrorPrefix: next === "uploaded" ? "" : value.defaultMirrorPrefix,
              allowClientMirror: next === "uploaded" ? false : value.allowClientMirror,
              archiveEntryName: next === "uploaded" ? "" : value.archiveEntryName,
              fileName: value.fileName || defaultFileNameForKind(value.kind)
            })
          }
          data={[
            { label: "远程更新", value: "remote" },
            { label: "上传到服务器", value: "uploaded" }
          ]}
        />

        {!isRuleset ? (
          <Group grow align="flex-start">
            <Select
              label="平台"
              data={runtimeComponentPlatformOptions}
              value={value.platform}
              disabled={editing}
              onChange={(next) => next && onChange({ ...value, platform: next as RuntimeComponentEditorFormState["platform"] })}
            />
            <Select
              label="架构"
              data={runtimeComponentArchitectureOptions}
              value={value.architecture}
              disabled={editing}
              onChange={(next) =>
                next && onChange({ ...value, architecture: next as RuntimeComponentEditorFormState["architecture"] })
              }
            />
          </Group>
        ) : null}

        {usesUploadedSource ? (
          <>
            <FileInput
              label="组件文件"
              description={`单文件最大 ${formatUploadBytes(uploadMaxBytes)}。`}
              placeholder="选择要上传的文件"
              value={value.selectedFile}
              onChange={(file) =>
                onChange({
                  ...value,
                  selectedFile: file,
                  fileName: file?.name || value.fileName || defaultFileNameForKind(value.kind)
                })
              }
              clearable
            />
            {!value.selectedFile && editing ? (
              <Text size="sm" c="dimmed">
                不重新选择文件时，只更新启用状态等基础信息。
              </Text>
            ) : null}
          </>
        ) : (
          <>
            <Textarea
              label="更新地址"
              description="客户端拉取该组件的官方或源站地址。"
              autosize
              minRows={2}
              placeholder="https://github.com/.../geoip.dat"
              value={value.originUrl}
              onChange={(event) => onChange({ ...value, originUrl: event.currentTarget.value })}
            />
            <Textarea
              label="加速镜像"
              description="每行一个前缀；客户端优先走镜像，失败后再回退源站。支持完整前缀或 {url} 模板。"
              autosize
              minRows={2}
              placeholder={"https://ghfast.top/\nhttps://mirror.ghproxy.com/"}
              value={value.defaultMirrorPrefix}
              onChange={(event) => onChange({ ...value, defaultMirrorPrefix: event.currentTarget.value })}
            />
            <Switch
              label="允许客户端自定义加速前缀"
              description="开启后，客户端可在本机再叠加自己的加速前缀。"
              checked={value.allowClientMirror}
              onChange={(event) => onChange({ ...value, allowClientMirror: event.currentTarget.checked })}
            />
          </>
        )}

        <Switch
          label="启用"
          checked={value.enabled}
          onChange={(event) => onChange({ ...value, enabled: event.currentTarget.checked })}
        />

        <Button variant="subtle" size="compact-sm" onClick={() => setShowAdvanced((current) => !current)} style={{ alignSelf: "flex-start" }}>
          {showAdvanced ? "收起高级选项" : "高级选项"}
        </Button>

        <Collapse in={showAdvanced}>
          <Stack gap="md">
            <TextInput
              label="输出文件名"
              description="客户端最终保存的文件名。"
              value={value.fileName}
              onChange={(event) => onChange({ ...value, fileName: event.currentTarget.value })}
            />
            {!usesUploadedSource ? (
              <TextInput
                label="压缩包内文件名"
                description="只有更新地址是 zip 时才需要填。"
                value={value.archiveEntryName}
                onChange={(event) => onChange({ ...value, archiveEntryName: event.currentTarget.value })}
              />
            ) : null}
            <TextInput
              label="SHA-256"
              description={
                usesUploadedSource
                  ? "可选。上传后系统会自动计算。"
                  : "可选。远程更新不填也能保存；校验通过前不会下发给客户端。"
              }
              value={value.expectedHash}
              onChange={(event) => onChange({ ...value, expectedHash: event.currentTarget.value })}
            />
            {!usesUploadedSource ? (
              <Alert color="gray" variant="light">
                日常只需维护更新地址和加速镜像。Hash 校验仍由后端保留，需要时再填。
              </Alert>
            ) : null}
          </Stack>
        </Collapse>

        <Group justify="flex-end">
          <Button variant="default" onClick={handleClose} disabled={saving}>
            取消
          </Button>
          <Button onClick={onSubmit} loading={saving}>
            保存
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function formatUploadBytes(value: number) {
  if (value >= 1024 * 1024 * 1024) {
    return `${(value / (1024 * 1024 * 1024)).toFixed(1).replace(/\.0$/, "")} GB`;
  }
  if (value >= 1024 * 1024) {
    return `${(value / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`;
  }
  return `${value} B`;
}
