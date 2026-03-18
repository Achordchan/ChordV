import React from "react";
import ReactDOM from "react-dom/client";
import { createTheme, MantineProvider } from "@mantine/core";
import "@mantine/core/styles.css";
import { App } from "./App";

const theme = createTheme({
  primaryColor: "cyan",
  defaultRadius: "xl",
  fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <MantineProvider theme={theme} defaultColorScheme="light">
    <App />
  </MantineProvider>
);
