import type { ReactNode } from "react";
import { ScrollArea, Table } from "@mantine/core";

export function DataTable({ children }: { children: ReactNode }) {
  return (
    <ScrollArea>
      <Table verticalSpacing="sm" horizontalSpacing="md" highlightOnHover>
        {children}
      </Table>
    </ScrollArea>
  );
}
