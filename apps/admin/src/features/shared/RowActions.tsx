import type { ReactNode } from "react";
import { Group } from "@mantine/core";

export function RowActions({ children }: { children: ReactNode }) {
  return <Group gap={4} wrap="nowrap">{children}</Group>;
}
