import React from "react";
import ReactDOM from "react-dom/client";
import { createTheme, MantineProvider } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import "flag-icons/css/flag-icons.min.css";
import { App } from "./App";
import { toastContainerClassNames } from "./components/Toast";
import { TOAST_AUTO_CLOSE_MS, TOAST_LIMIT, TOAST_WIDTH } from "./lib/toast";
import "./styles.css";

const fontFamily =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif';

// Radii are capped at 14px so no control renders as a full pill; thin borders on
// large arcs are what look jagged under fractional Windows display scaling.
const theme = createTheme({
  primaryColor: "cyan",
  fontFamily,
  fontFamilyMonospace: 'ui-monospace, "SF Mono", "Cascadia Mono", Consolas, monospace',
  headings: { fontFamily, fontWeight: "650" },
  radius: { xs: "4px", sm: "6px", md: "8px", lg: "12px", xl: "14px" },
  defaultRadius: "md",
  components: {
    Checkbox: { defaultProps: { radius: "xs" } },
    Badge: { defaultProps: { radius: "sm" }, styles: { root: { textTransform: "none", letterSpacing: 0, fontWeight: 600 } } },
    Paper: { defaultProps: { radius: "lg" } },
    Modal: { defaultProps: { radius: "xl" } },
    Tooltip: { defaultProps: { radius: "md" } },
    Menu: { defaultProps: { radius: "md", shadow: "md" } }
  }
});

const Root = (import.meta.env.DEV || import.meta.env.VITE_CHORDV_LOCAL_PREVIEW === "1") && new URLSearchParams(window.location.search).has("download-preview")
  ? React.lazy(() => import("./dev/DownloadProgressDebug")) : App;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <MantineProvider theme={theme} defaultColorScheme="light">
    <Notifications
      position="top-right"
      autoClose={TOAST_AUTO_CLOSE_MS}
      limit={TOAST_LIMIT}
      containerWidth={TOAST_WIDTH}
      classNames={toastContainerClassNames}
    />
    <React.Suspense fallback={null}><Root /></React.Suspense>
  </MantineProvider>
);
