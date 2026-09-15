import type { ReactNode } from "react";
import { ActionIcon, Button, Card, Checkbox, Combobox, Input, InputWrapper, MantineProvider, Menu, Modal, Paper, Select, Switch, createTheme } from "@mantine/core";
import styles from "./AdminAppearance.module.css";
import dialog from "../editors/EditorDialog.module.css";

const theme = createTheme({
  primaryColor: "teal", defaultRadius: "sm",
  components: {
    Paper: Paper.extend({ defaultProps: { radius: "sm" } }),
    Card: Card.extend({ defaultProps: { radius: "sm" } }),
    Menu: Menu.extend({ classNames: { dropdown: styles.dropdown, item: styles.option } }),
    Input: Input.extend({ classNames: { input: styles.input } }),
    InputWrapper: InputWrapper.extend({ classNames: { label: styles.label, description: styles.description } }),
    Button: Button.extend({ defaultProps: { color: "teal.9", radius: "sm" }, classNames: { root: styles.button } }),
    ActionIcon: ActionIcon.extend({ defaultProps: { color: "teal.9", radius: "sm" } }),
    Checkbox: Checkbox.extend({ defaultProps: { color: "teal.9", radius: "sm" } }),
    Switch: Switch.extend({ defaultProps: { color: "teal.9" } }),
    Select: Select.extend({ defaultProps: { maxDropdownHeight: 240 } }),
    Combobox: Combobox.extend({ classNames: { dropdown: styles.dropdown, option: styles.option } }),
    Modal: Modal.extend({ classNames: { content: dialog.content, header: dialog.header, title: dialog.title, body: styles.modalBody } })
  }
});

/** React theme context also reaches portal dropdowns; no root CSS variables or ticket styles are changed. */
export function AdminAppearance({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  return <MantineProvider theme={enabled ? theme : {}} withCssVariables={false}>{children}</MantineProvider>;
}
