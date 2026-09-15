import React from "react";
import ReactDOM from "react-dom/client";
import { createTheme, MantineProvider } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import "flag-icons/css/flag-icons.min.css";
import { App } from "./App";
import "./styles.css";

const theme = createTheme({
  primaryColor: "cyan",
  defaultRadius: "xl",
  fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
});

const Root = (import.meta.env.DEV || import.meta.env.VITE_CHORDV_LOCAL_PREVIEW === "1") && new URLSearchParams(window.location.search).has("download-preview")
  ? React.lazy(() => import("./dev/DownloadProgressDebug")) : App;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <MantineProvider theme={theme} defaultColorScheme="light">
    <Notifications position="top-right" autoClose={2600} />
    <React.Suspense fallback={null}><Root /></React.Suspense>
  </MantineProvider>
);
