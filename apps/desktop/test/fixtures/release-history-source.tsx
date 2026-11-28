import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { MantineProvider } from "@mantine/core";
import "@mantine/core/styles.css";
import { ReleaseHistory } from "../../src/components/ReleaseHistory";

// 仅供独立回归服务器加载，生产入口不加载此页面。
function HistoryFixture() {
  const [channel, setChannel] = useState<"stable" | "beta">("stable");
  return <MantineProvider>
    <button onClick={() => setChannel("beta")}>切换测试版</button>
    <ReleaseHistory channel={channel} appVersion="1.1.12" />
  </MantineProvider>;
}
createRoot(document.getElementById("root")!).render(<HistoryFixture />);
