import { NumberInput } from "@mantine/core";
import { TRAFFIC_RESET_DAY_MAX, TRAFFIC_RESET_DAY_MIN } from "@chordv/shared";

/** 每月流量重置日输入框；空值表示不自动重置。 */
export function TrafficResetDayInput(props: { value: number | ""; onChange: (value: number | "") => void }) {
  return (
    <NumberInput
      label="每月重置日"
      description="每月这一天北京时间 0 点清零已用流量，当月没有这一天就在月末。留空表示不自动重置。"
      placeholder="不自动重置"
      min={TRAFFIC_RESET_DAY_MIN}
      max={TRAFFIC_RESET_DAY_MAX}
      allowDecimal={false}
      allowNegative={false}
      clampBehavior="strict"
      suffix=" 号"
      value={props.value}
      onChange={(value) => props.onChange(normalizeTrafficResetDayInput(value))}
    />
  );
}

export function normalizeTrafficResetDayInput(value: string | number): number | "" {
  if (value === "" || value === null || value === undefined) return "";
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < TRAFFIC_RESET_DAY_MIN || parsed > TRAFFIC_RESET_DAY_MAX) return "";
  return parsed;
}
