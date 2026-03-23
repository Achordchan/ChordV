import { Alert, Button, FileInput, Group, Modal, Select, SegmentedControl, Stack, Switch, Text, TextInput, Textarea } from "@mantine/core";
import type { RuntimeComponentEditorFormState } from "./types";
import {
  runtimeComponentArchitectureOptions,
  runtimeComponentKindOptions,
  runtimeComponentPlatformOptions,
  runtimeComponentSourceOptions
} from "./types";

type RuntimeComponentEditorModalProps = {
  opened: boolean;
  editing: boolean;
  saving: boolean;
  value: RuntimeComponentEditorFormState;
  onChange: (next: RuntimeComponentEditorFormState) => void;
  onClose: () => void;
  onSubmit: () => void;
};

export function RuntimeComponentEditorModal(props: RuntimeComponentEditorModalProps) {
  const { opened, editing, saving, value, onChange, onClose, onSubmit } = props;
  const usesUploadedSource = value.source === "uploaded";
  const supportsLegacyRemote = value.source === "github_remote";
  const isRuleset = value.kind === "geoip" || value.kind === "geosite";

  return (
    <Modal opened={opened} onClose={onClose} title={editing ? "编辑内核组件" : "新增内核组件"} centered size="lg">
      <Stack gap="md">
        <SegmentedControl
          value={usesUploadedSource ? "uploaded" : "remote"}
          onChange={(next) =>
            onChange({
              ...value,
              source: next === "uploaded" ? "uploaded" : "custom_remote",
              originUrl: next === "uploaded" ? value.originUrl : value.originUrl,
              defaultMirrorPrefix: next === "uploaded" ? "" : value.defaultMirrorPrefix,
              allowClientMirror: next === "uploaded" ? false : value.allowClientMirror,
              archiveEntryName: next === "uploaded" ? "" : value.archiveEntryName
            })
          }
          data={[
            { label: "上传到服务器", value: "uploaded" },
            { label: "远程直链", value: "remote" }
          ]}
        />

        <Select
          label="平台"
          data={runtimeComponentPlatformOptions}
          value={value.platform}
          disabled={isRuleset}
          onChange={(next) => next && onChange({ ...value, platform: next as RuntimeComponentEditorFormState["platform"] })}
        />
        <Select
          label="架构"
          data={runtimeComponentArchitectureOptions}
          value={value.architecture}
          disabled={isRuleset}
          onChange={(next) => next && onChange({ ...value, architecture: next as RuntimeComponentEditorFormState["architecture"] })}
        />
        <Select
          label="组件"
          data={runtimeComponentKindOptions}
          value={value.kind}
          onChange={(next) =>
            next &&
            onChange({
              ...value,
              kind: next as RuntimeComponentEditorFormState["kind"],
              ...(next === "xray" ? {} : { platform: "macos", architecture: "arm64" })
            })
          }
        />

        {isRuleset ? (
          <Alert color="blue" variant="light">
            `GeoIP / GeoSite` 规则集现在按全平台通用处理。这里显示的平台和架构只是内部兼容占位，你不需要为每个平台重复上传。
          </Alert>
        ) : null}

        {supportsLegacyRemote ? (
          <Select
            label="当前来源"
            description="这条老记录仍在沿用旧的远程配置模型，建议后续改成上传到服务器。"
            data={runtimeComponentSourceOptions(value.source)}
            value={value.source}
            onChange={(next) => next && onChange({ ...value, source: next as RuntimeComponentEditorFormState["source"] })}
          />
        ) : null}

        {usesUploadedSource ? (
          <>
            <FileInput
              label="组件文件"
              placeholder="选择要上传的文件"
              value={value.selectedFile}
              onChange={(file) =>
                onChange({
                  ...value,
                  selectedFile: file,
                  fileName: file?.name ?? value.fileName
                })
              }
              clearable
            />
            <Alert color="blue" variant="light">
              推荐把内核组件直接上传到你自己的服务器。上传后系统会自动生成下载地址、文件大小和 Hash，客户端也会优先从你的服务器下载。
            </Alert>
            {!value.selectedFile && editing ? (
              <Text size="sm" c="dimmed">
                不重新选择文件时，只会更新组件的元信息，不会覆盖服务器上的现有文件。
              </Text>
            ) : null}
          </>
        ) : (
          <>
            <Alert color="yellow" variant="light">
              远程直链只建议在特殊情况下使用。优先使用“上传到服务器”，这样最稳定，也不容易被外部链接失效影响。
            </Alert>
            <Textarea
              label="组件下载地址"
              description="填写可以直接访问的文件地址。只有你明确要走远程直链时才使用这里。"
              autosize
              minRows={2}
              value={value.originUrl}
              onChange={(event) => onChange({ ...value, originUrl: event.currentTarget.value })}
            />
            <TextInput
              label="默认加速前缀"
              description="可选。直接填写加速域名前缀即可，比如 https://ghfast.top/ 。留空时就直接使用原始下载地址。"
              placeholder="例如 https://ghfast.top/"
              value={value.defaultMirrorPrefix}
              onChange={(event) => onChange({ ...value, defaultMirrorPrefix: event.currentTarget.value })}
            />
            <TextInput
              label="压缩包内文件名"
              description="只有下载地址是 zip 压缩包时才需要填写。普通文件直链留空即可。"
              value={value.archiveEntryName}
              onChange={(event) => onChange({ ...value, archiveEntryName: event.currentTarget.value })}
            />
            <Switch
              label="允许客户端自定义加速前缀"
              checked={value.allowClientMirror}
              onChange={(event) => onChange({ ...value, allowClientMirror: event.currentTarget.checked })}
            />
          </>
        )}

        <TextInput
          label="输出文件名"
          description="客户端最终保存成这个文件名，例如 xray、geoip.dat、geosite.dat。"
          value={value.fileName}
          onChange={(event) => onChange({ ...value, fileName: event.currentTarget.value })}
        />

        <TextInput
          label="预期 Hash"
          description="可选。建议填 SHA-256。上传模式下如果留空，会自动使用真实文件的 Hash。"
          value={value.expectedHash}
          onChange={(event) => onChange({ ...value, expectedHash: event.currentTarget.value })}
        />

        <Switch
          label="启用该组件"
          checked={value.enabled}
          onChange={(event) => onChange({ ...value, enabled: event.currentTarget.checked })}
        />

        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            取消
          </Button>
          <Button onClick={onSubmit} loading={saving}>
            {editing ? "保存组件" : "创建组件"}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
