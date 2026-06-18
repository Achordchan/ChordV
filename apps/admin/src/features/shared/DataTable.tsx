import type { ReactNode } from "react";
import { Table } from "@mantine/core";

export function DataTable({ children, minWidth = 960 }: { children: ReactNode; minWidth?: number }) {
  return (
    <Table.ScrollContainer minWidth={minWidth}>
      <Table verticalSpacing="sm" horizontalSpacing="md" highlightOnHover>
        {children}
      </Table>
    </Table.ScrollContainer>
  );
}
