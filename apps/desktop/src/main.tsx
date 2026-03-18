import React from "react";
import ReactDOM from "react-dom/client";
import { createTheme, MantineProvider } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import { App } from "./App";
import "./styles.css";

const theme = createTheme({
  primaryColor: "cyan",
  defaultRadius: "xl",
  fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <MantineProvider theme={theme} defaultColorScheme="light">
    <Notifications position="top-right" autoClose={2600} />
    <App />
  </MantineProvider>
);
