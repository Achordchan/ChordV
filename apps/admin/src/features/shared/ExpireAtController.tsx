import { useEffect, useState } from "react";
import { Button, Collapse, Group, NumberInput, Select, Stack, Text, TextInput } from "@mantine/core";
import { IconChevronDown } from "@tabler/icons-react";
import { applyExpireOffset, formatDateTimeWithYear } from "../../utils/admin-format";
import { expireUnitOptions } from "../../utils/admin-forms";

export function ExpireAtController(props: {
  label: string;
  value: string;
  baseValue: string;
  onChange: (value: string) => void;
}) {
  const [offsetValue, setOffsetValue] = useState<number | "">(30);
  const [offsetUnit, setOffsetUnit] = useState<"day" | "month" | "year">("day");
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    setOffsetValue(30);
    setOffsetUnit("day");
    setExpanded(false);
  }, [props.baseValue]);

  return (
    <Stack gap="xs">
      <TextInput
        label={props.label}
        type="datetime-local"
        value={props.value}
        onChange={(event) => props.onChange(event.currentTarget.value)}
      />
      <Button type="button" variant="subtle" color="#596e5c" size="compact-sm" px={0} style={{ alignSelf: "flex-start" }} rightSection={<IconChevronDown size={14}/>} aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>按时长设置</Button>
      <Collapse in={expanded}>
      <Group align="end" gap="sm">
        <NumberInput
          style={{ flex: 1 }}
          label="时长"
          min={1}
          value={offsetValue}
          onChange={(value) => setOffsetValue(value === "" || value === null ? "" : Number(value))}
        />
        <Select
          style={{ width: 120 }}
          label="单位"
          data={expireUnitOptions}
          value={offsetUnit}
          onChange={(value) => setOffsetUnit((value || "day") as "day" | "month" | "year")}
          allowDeselect={false}
        />
        <Button
          type="button"
          variant="default"
          onClick={() => props.onChange(applyExpireOffset(props.baseValue, Number(offsetValue), offsetUnit))}
          disabled={!offsetValue || Number(offsetValue) <= 0}
        >
          应用
        </Button>
      </Group>
      <Text size="xs" c="dimmed">
        起算时间：{props.baseValue ? formatDateTimeWithYear(props.baseValue) : "当前时间"}
      </Text>
      </Collapse>
    </Stack>
  );
}
