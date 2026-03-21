import { Badge } from "@mantine/core";

export function StatusBadge(props: { color: string; label: string }) {
  return (
    <Badge color={props.color} variant="light">
      {props.label}
    </Badge>
  );
}
