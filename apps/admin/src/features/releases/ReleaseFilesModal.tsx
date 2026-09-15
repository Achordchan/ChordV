import { releasePlatformOptions } from "./types";
import { Button, Group, Modal, Stack, Text } from "@mantine/core";
import type { AdminReleaseRecordDto, AdminReleaseArtifactRecordDto } from "../../api/client";
import dialog from "../editors/EditorDialog.module.css";

export function ReleaseFilesModal({release,opened,onClose,onAdd,onEdit,onDelete,onCopy}: {
  release: AdminReleaseRecordDto | null; opened: boolean; onClose:()=>void; onAdd:()=>void;
  onEdit:(file:AdminReleaseArtifactRecordDto)=>void; onDelete:(file:AdminReleaseArtifactRecordDto)=>void; onCopy:(url:string)=>void;
}) {
  const editable=release?.status==="draft";
  return <Modal opened={opened&&Boolean(release)} onClose={onClose} title={`${releasePlatformOptions.find(item=>item.value===release?.platform)?.label||""} ${release?.version||""} · 安装包管理`} centered size={660}>
    <Stack gap="md" className={dialog.form}>
      {!editable?<Text size="sm" c="dimmed">已发布文件保留供客户端下载；需要替换或删除时，请先撤回为草稿。</Text>:null}
      {release?.artifacts.map(file=><section key={file.id} style={{borderBottom:"1px solid #e3e8df",paddingBottom:16}}>
        <Group justify="space-between"><Text fw={600} size="sm" style={{overflowWrap:"anywhere"}}>{file.fileName||"外链安装包"}</Text><Text size="xs" c="dimmed">{file.isPrimary?"当前更新入口":"附加文件"}</Text></Group>
        <Text size="sm" c="dimmed" mt={5}>{file.source==="uploaded"?"本站托管":"旧外链"} · {file.fileSizeBytes?`${(Number(file.fileSizeBytes)/1048576).toFixed(1)} MB`:"大小未知"}</Text>
        <details style={{marginTop:8,fontSize:12,overflowWrap:"anywhere"}}><summary>来源与校验信息</summary><p>下载地址：{file.downloadUrl}</p><p>获取来源：{file.sourceUrl|| (file.source==="external"?file.originDownloadUrl:"本地上传或未记录来源")}</p><p>SHA-256：{file.fileHash||"未记录"}</p></details>
        <Group gap="xs" mt="sm"><Button size="compact-xs" variant="default" onClick={()=>onCopy(file.downloadUrl)}>复制下载地址</Button>{editable?<><Button size="compact-xs" variant="light" onClick={()=>onEdit(file)}>替换此文件</Button><Button size="compact-xs" variant="subtle" color="red" onClick={()=>onDelete(file)}>删除此文件</Button></>:null}</Group>
      </section>)}
      {!release?.artifacts.length?<Text size="sm" c="dimmed">暂无安装包，可获取、上传或复用已有文件。</Text>:null}
      <Group justify="space-between"><Button variant="default" onClick={onClose}>关闭</Button><Button disabled={!editable} onClick={onAdd}>新增 / 复用安装包</Button></Group>
    </Stack>
  </Modal>;
}
