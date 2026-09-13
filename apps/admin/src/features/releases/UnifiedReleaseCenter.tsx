import { useState } from "react";
import { Tabs } from "@mantine/core";
import { ReleasesPage } from "../../pages/ReleasesPage";
import { ComponentDeliveryPage } from "../runtime-components/ComponentDeliveryPage";
import styles from "./ReleaseWorkspace.module.css";
export function UnifiedReleaseCenter({refreshSignal, initialTab = "releases"}:{refreshSignal?:number;initialTab?:string}) {
  const [tab,setTab]=useState<string|null>(initialTab);
  return <Tabs value={tab} onChange={setTab} keepMounted={false} color="teal.9" className={styles.unified}>
    <Tabs.List><Tabs.Tab value="releases">客户端版本</Tabs.Tab><Tabs.Tab value="components">运行组件</Tabs.Tab></Tabs.List>
    <Tabs.Panel value="releases" pt="lg"><ReleasesPage refreshSignal={refreshSignal}/></Tabs.Panel>
    <Tabs.Panel value="components" pt="lg"><ComponentDeliveryPage/></Tabs.Panel>
  </Tabs>;
}
