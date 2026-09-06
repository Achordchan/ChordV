import { TextInput } from "@mantine/core";
import { DESKTOP_UPDATE_DOWNLOAD_LIMIT_LABEL } from "./artifactPayloads";

type ExternalArtifactMetadataValue = {
  fileSizeBytes: string;
  fileHash: string;
};

type ExternalArtifactMetadataFieldsProps = {
  value: ExternalArtifactMetadataValue;
  disabled: boolean;
  onChange: (patch: Partial<ExternalArtifactMetadataValue>) => void;
};

export function ExternalArtifactMetadataFields(props: ExternalArtifactMetadataFieldsProps) {
  return (
    <>
      <TextInput
        label="文件大小（字节）"
        description={`填写远程文件的实际字节数，必须为正整数且不能超过 ${DESKTOP_UPDATE_DOWNLOAD_LIMIT_LABEL}。`}
        placeholder="例如 104857600"
        inputMode="numeric"
        value={props.value.fileSizeBytes}
        onChange={(event) => props.onChange({ fileSizeBytes: event.currentTarget.value })}
        disabled={props.disabled}
      />
      <TextInput
        label="SHA-256 校验值（选填）"
        description="填写有效值时执行附加校验；留空或格式无效不会阻断更新。"
        placeholder="选填，64 位十六进制字符串"
        value={props.value.fileHash}
        onChange={(event) => props.onChange({ fileHash: event.currentTarget.value })}
        disabled={props.disabled}
      />
    </>
  );
}