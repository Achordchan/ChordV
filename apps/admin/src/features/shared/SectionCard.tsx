import type { ReactNode } from "react";
import { Card, Group, TextInput } from "@mantine/core";
import { IconSearch } from "@tabler/icons-react";

export function SectionCard(props: { searchValue: string; onSearchChange: (value: string) => void; children: ReactNode }) {
  return (
    <Card withBorder radius="xl" p="lg">
      <Group justify="flex-end" mb="md">
        <TextInput
          leftSection={<IconSearch size={16} />}
          placeholder="搜索"
          value={props.searchValue}
          onChange={(event) => props.onSearchChange(event.currentTarget.value)}
          maw={320}
        />
      </Group>
      {props.children}
    </Card>
  );
}
