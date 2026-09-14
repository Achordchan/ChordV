import React from "react";
import ReactDOM from "react-dom/client";
import { createTheme, MantineProvider } from "@mantine/core";
import "@mantine/core/styles.css";
import { Notifications } from "@mantine/notifications";
import "@mantine/notifications/styles.css";
import "flag-icons/css/flag-icons.min.css";
import { App } from "./App";
import "./styles.css";
import feedbackStyles from "./features/feedback/Notifications.module.css";

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
    <Notifications position="bottom-right" autoClose={6500} limit={3} containerWidth={400} classNames={{ notification: feedbackStyles.notification }} />
    <App />
  </MantineProvider>
);
