import type { ReactNode } from "react";
import { Card, Group, Stack, Text, TextInput } from "@mantine/core";
import { IconSearch } from "@tabler/icons-react";

export function SectionCard(props: {
  searchValue: string;
  onSearchChange: (value: string) => void;
  onSearchSubmit?: () => void;
  title?: string;
  description?: string;
  actions?: ReactNode;
  searchPlaceholder?: string;
  children: ReactNode;
}) {
  return (
    <Card withBorder radius="xl" p="lg">
      <Group className="admin-section-card-head" justify="space-between" align="flex-start" mb="md" gap="md" wrap="wrap">
        {props.title || props.description ? (
          <Stack gap={2} style={{ flex: 1, minWidth: 220 }}>
            {props.title ? <Text fw={700}>{props.title}</Text> : null}
            {props.description ? (
              <Text size="sm" c="dimmed">
                {props.description}
              </Text>
            ) : null}
          </Stack>
        ) : (
          <div />
        )}
        <Group className="admin-section-card-tools" gap="xs" justify="flex-end" wrap="wrap" style={{ flex: "0 1 auto" }}>
          {props.actions}
          <TextInput
            leftSection={<IconSearch size={16} />}
            placeholder={props.searchPlaceholder ?? "搜索"}
            value={props.searchValue}
            onChange={(event) => props.onSearchChange(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                props.onSearchSubmit?.();
              }
            }}
            className="admin-section-card-search"
          />
        </Group>
      </Group>
      {props.children}
    </Card>
  );
}
