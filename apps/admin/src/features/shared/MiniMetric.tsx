import { Stack, Text } from "@mantine/core";

export function MiniMetric(props: { label: string; value: string }) {
  return (
    <Stack gap={0}>
      <Text size="sm" c="dimmed">
        {props.label}
      </Text>
      <Text fw={600}>{props.value}</Text>
    </Stack>
  );
}
