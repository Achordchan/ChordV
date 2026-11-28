import React from "react";
import ReactDOM from "react-dom/client";
import { createTheme, MantineProvider } from "@mantine/core";
import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import "flag-icons/css/flag-icons.min.css";
import { App } from "./App";
import "./styles.css";
import { AdminNotifications } from "./features/feedback/AdminNotifications";

const theme = createTheme({
  primaryColor: "blue",
  defaultRadius: "lg",
  fontFamily: "IBM Plex Sans, PingFang SC, Helvetica Neue, sans-serif",
  headings: {
    fontFamily: "IBM Plex Sans, PingFang SC, Helvetica Neue, sans-serif"
  }
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <MantineProvider theme={theme} defaultColorScheme="light">
    <AdminNotifications />
    <App />
  </MantineProvider>
);
