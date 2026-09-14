import { useEffect, useState } from "react";
import { Tabs, Text } from "@mantine/core";
import { fetchComponentDeliveries } from "../../api/runtime-versions";
import { subscribeAdminRuntimeEvents } from "../../api/client";
import { needsLegacyComponentManagement } from "../runtime-components/legacy-component-policy";
import { ReleasesPage } from "../../pages/ReleasesPage";
import { ComponentDeliveryPage } from "../runtime-components/ComponentDeliveryPage";
import { RuntimeComponentsPage } from "../../pages/RuntimeComponentsPage";
import styles from "./ReleaseWorkspace.module.css";
export function UnifiedReleaseCenter({refreshSignal, initialTab = "releases", sessionActive = true}:{refreshSignal?:number;initialTab?:string;sessionActive?:boolean}) {
  const [tab,setTab]=useState<string|null>(initialTab);
  const [legacyNeeded,setLegacyNeeded]=useState<boolean|null>(null);
  useEffect(()=>{
    let active=true, request=0;
    const load=async()=>{const id=++request;try{const rows=await fetchComponentDeliveries();if(active&&id===request)setLegacyNeeded(needsLegacyComponentManagement(rows));}catch{if(active&&id===request)setLegacyNeeded(true);}};
    void load();
    const stop=subscribeAdminRuntimeEvents(event=>{if(event.type==="runtime_component_updated")void load();});
    return()=>{active=false;stop();};
  },[refreshSignal]);
  return <Tabs value={tab} onChange={setTab} keepMounted={false} color="teal.9" className={styles.unified}>
    <Tabs.List><Tabs.Tab value="releases">客户端版本</Tabs.Tab><Tabs.Tab value="components">运行组件</Tabs.Tab>{(legacyNeeded || tab==="sources") && <Tabs.Tab value="sources">旧组件迁移</Tabs.Tab>}</Tabs.List>
    <Tabs.Panel value="releases" pt="lg"><ReleasesPage refreshSignal={refreshSignal}/></Tabs.Panel>
    <Tabs.Panel value="components" pt="lg"><ComponentDeliveryPage refreshSignal={refreshSignal} sessionActive={sessionActive}/></Tabs.Panel>
    <Tabs.Panel value="sources" pt="lg">{legacyNeeded ? <><Text size="sm" mb="md">仍有启用中的旧来源组件。完成迁移后此入口自动退役，下载文件继续保留兼容。</Text><RuntimeComponentsPage refreshSignal={refreshSignal}/></> : <Text>组件迁移已完成，旧管理入口已退役。全局镜像可在系统设置中管理。</Text>}</Tabs.Panel>
  </Tabs>;
}
