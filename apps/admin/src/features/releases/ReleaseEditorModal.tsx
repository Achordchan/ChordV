import { useEffect, useRef, useState } from "react";
import styles from "./ReleaseWorkspace.module.css";
import { Button, FileInput, Group, SegmentedControl, Select, Stack, Text, TextInput, Textarea } from "@mantine/core";
import { RemoteArtifactSourceFields } from "./RemoteArtifactSourceFields";
import { ArtifactImportProgress } from "./ArtifactImportProgress";
import type { ArtifactImportProgress as ImportProgress } from "../../api/client";
import type { ReleaseEditorFormState } from "./types";
import { releasePlatformOptions } from "./types";

type ReleaseEditorModalProps = {
  opened: boolean;
  editing: boolean;
  saving: boolean;
  savingMessage?: string | null;
  importProgress: ImportProgress | null;
  title: string;
  submitLabel: string;
  form: ReleaseEditorFormState;
  artifactEditingDisabled?: boolean;
  onClose: () => void;
  onChange: (value: ReleaseEditorFormState) => void;
  onManageArtifact?: (source: ReleaseEditorFormState["artifactSource"]) => void;
  onSubmit: () => void;
};

export function ReleaseEditorModal(p: ReleaseEditorModalProps) {
  const [step,setStep]=useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (p.opened) heading.current?.focus(); }, [step, p.opened]);
  if (!p.opened) return null;
  const platform=releasePlatformOptions.find(x=>x.value===p.form.platform)?.label;
  const steps=p.editing?["版本信息","确认保存"]:["版本信息","安装包","确认保存"];
  const final=step===steps.length-1;
  return <section className={styles.editor}>
    <button className={styles.back} disabled={p.saving} onClick={p.onClose}>返回发布中心</button>
    <h2>{p.editing?"编辑":"准备"} {platform} {p.form.version||"新版本"}</h2>
    <div className={styles.steps} aria-label="发布准备步骤">{steps.map((title,index)=><span key={title} aria-current={step===index ? "step" : undefined} data-active={step===index} data-done={step>index}>{String(index+1).padStart(2,"0")} {title}</span>)}</div>
    <div className={styles.editorGrid}><div className={styles.form}>
      {p.savingMessage&&!p.importProgress?<Text role="status" size="sm" c="teal.9" mb="lg">{p.savingMessage}</Text>:null}
      <h3 ref={heading} tabIndex={-1} className={styles.stepHeading}>{step===0 ? "版本信息" : final ? "确认版本信息" : "设置下载来源"}</h3>
      <Stack gap="lg">
      {step===0?<>
        <Select label="平台" data={releasePlatformOptions.map(x=>({...x}))} value={p.form.platform} disabled={p.editing||p.saving} onChange={value=>value&&p.onChange({...p.form,platform:value as ReleaseEditorFormState["platform"],selectedFile:null,fileName:"",externalDeliveryMode:value==="windows"?"windows_full_replace_zip":"external_download"})}/>
        <Group grow><TextInput label="版本号" placeholder="例如 1.2.0" value={p.form.version} disabled={p.editing||p.saving} onChange={e=>p.onChange({...p.form,version:e.currentTarget.value})}/><TextInput label="发布标题" value={p.form.title} disabled={p.saving} onChange={e=>p.onChange({...p.form,title:e.currentTarget.value})}/></Group>
        <Textarea label="更新说明" description="每行一条，展示给客户端用户" autosize minRows={5} value={p.form.changelog} disabled={p.saving} onChange={e=>p.onChange({...p.form,changelog:e.currentTarget.value})}/>
        {p.editing?<Text size="sm" c="dimmed">安装包在版本详情中单独管理；已发布版本需先撤回再调整安装包。</Text>:null}
      </>:!final?<><NewReleaseArtifactFields form={p.form} saving={p.saving} onChange={p.onChange}/></>:<>
        <dl className={styles.facts}><div><dt>平台与版本</dt><dd>{platform} {p.form.version}</dd></div><div><dt>标题</dt><dd>{p.form.title||"使用默认标题"}</dd></div>{!p.editing?<div><dt>安装包来源</dt><dd>{p.form.artifactSource==="external"?(p.form.downloadUrl||"暂不添加安装包"):(p.form.selectedFile?.name||"暂不添加安装包")}</dd></div>:null}</dl>
        <Text size="sm" c="dimmed">{p.editing?"保存本次修改。":"保存后生成草稿；从发布列表确认发布，服务端会检查安装包可用性。"}</Text>
      </>}
      </Stack>
      <ArtifactImportProgress value={p.saving ? p.importProgress : null} />
      <footer className={styles.editorFooter}><Button variant="default" disabled={p.saving} onClick={()=>step?setStep(step-1):p.onClose()}>{step?"上一步":"取消"}</Button>{final?<Button color="teal.9" loading={p.saving} onClick={p.onSubmit}>{p.editing?"保存修改":"保存草稿"}</Button>:<Button color="teal.9" disabled={p.saving||!p.form.version.trim()} onClick={()=>setStep(step+1)}>继续</Button>}</footer>
    </div><aside className={styles.summary}><h3>发布摘要</h3><dl className={styles.facts}><div><dt>平台</dt><dd>{platform}</dd></div><div><dt>版本</dt><dd>{p.form.version||"待填写"}</dd></div><div><dt>状态</dt><dd>{p.editing?(p.form.status==="published"?"已发布":"草稿"):"尚未保存"}</dd></div><div><dt>分发方式</dt><dd>{p.form.artifactSource==="external"?"远程获取并托管":"上传文件"}</dd></div></dl><details><summary>更新说明</summary><p>{p.form.changelog||"尚未填写"}</p></details></aside></div>
  </section>;
}
type NewReleaseArtifactFieldsProps = {
  form: ReleaseEditorFormState;
  saving: boolean;
  onChange: (value: ReleaseEditorFormState) => void;
};

export function NewReleaseArtifactFields(props: NewReleaseArtifactFieldsProps) {
  return (
    <>
      <SegmentedControl
        classNames={{root: styles.sourcePicker, label: styles.sourceLabel, indicator: styles.sourceIndicator}}
        aria-label="安装包来源"
        value={props.form.artifactSource}
        onChange={(value) =>
          props.onChange({
            ...props.form,
            artifactSource: value as ReleaseEditorFormState["artifactSource"]
          })
        }
        data={[
          { value: "external", label: "远程获取" },
          { value: "uploaded", label: "上传文件" }
        ]}
        disabled={props.saving}
      />

      {props.form.artifactSource === "external" ? (
        <RemoteArtifactSourceFields value={props.form.downloadUrl} platform={props.form.platform} disabled={props.saving}
          onChange={downloadUrl => props.onChange({ ...props.form, downloadUrl, fileSizeBytes: "", fileHash: "" })} />
      ) : (
        <FileInput
          label="上传安装包文件"
          description="文件保存到本站，由本站分发。"
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

      <Text size="sm" c="dimmed">
        {props.form.artifactSource === "external"
          ? "暂时没有安装包？可留空保存草稿，稍后补充。"
          : "上传文件会保存到本地服务器；也可以先不选文件创建草稿，稍后再上传。"}
      </Text>
    </>
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
