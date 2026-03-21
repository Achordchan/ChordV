import { useEffect, useState } from "react";
import { Button, Group, NumberInput, Select, Stack, Text, TextInput } from "@mantine/core";
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

  useEffect(() => {
    setOffsetValue(30);
    setOffsetUnit("day");
  }, [props.baseValue]);

  return (
    <Stack gap="xs">
      <TextInput
        label={props.label}
        type="datetime-local"
        value={props.value}
        onChange={(event) => props.onChange(event.currentTarget.value)}
      />
      <Group align="end">
        <NumberInput
          style={{ flex: 1 }}
          label="按时长推导"
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
          variant="default"
          onClick={() => props.onChange(applyExpireOffset(props.baseValue, Number(offsetValue), offsetUnit))}
          disabled={!offsetValue || Number(offsetValue) <= 0}
        >
          应用
        </Button>
      </Group>
      <Text size="xs" c="dimmed">
        推导基准：{props.baseValue ? formatDateTimeWithYear(props.baseValue) : "当前时间"}
      </Text>
    </Stack>
  );
}
