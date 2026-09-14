import { useState } from "react";
import { Tabs } from "@mantine/core";
import { ReleasesPage } from "../../pages/ReleasesPage";
import { ComponentDeliveryPage } from "../runtime-components/ComponentDeliveryPage";
import { RuntimeComponentsPage } from "../../pages/RuntimeComponentsPage";
import styles from "./ReleaseWorkspace.module.css";
export function UnifiedReleaseCenter({refreshSignal, initialTab = "releases", sessionActive = true}:{refreshSignal?:number;initialTab?:string;sessionActive?:boolean}) {
  const [tab,setTab]=useState<string|null>(initialTab);
  return <Tabs value={tab} onChange={setTab} keepMounted={false} color="teal.9" className={styles.unified}>
    <Tabs.List><Tabs.Tab value="releases">客户端版本</Tabs.Tab><Tabs.Tab value="components">运行组件</Tabs.Tab><Tabs.Tab value="sources">上传与镜像</Tabs.Tab></Tabs.List>
    <Tabs.Panel value="releases" pt="lg"><ReleasesPage refreshSignal={refreshSignal}/></Tabs.Panel>
    <Tabs.Panel value="components" pt="lg"><ComponentDeliveryPage refreshSignal={refreshSignal} sessionActive={sessionActive}/></Tabs.Panel>
    <Tabs.Panel value="sources" pt="lg"><RuntimeComponentsPage refreshSignal={refreshSignal}/></Tabs.Panel>
  </Tabs>;
}
