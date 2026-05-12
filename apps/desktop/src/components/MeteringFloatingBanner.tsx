import { Badge, Paper, Text } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { createPortal } from "react-dom";

type MeteringFloatingBannerProps = {
  status: "ok" | "degraded";
  message: string | null;
};

export function MeteringFloatingBanner(props: MeteringFloatingBannerProps) {
  const isMobile = useMediaQuery("(max-width: 760px)");
  if (props.status !== "degraded" || !props.message || typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <div className="metering-floating-banner" aria-live="polite">
      <Paper
        withBorder
        radius="xl"
        p="sm"
        className="metering-floating-banner__panel"
        style={{
          background: "rgba(255, 251, 235, 0.96)",
          borderColor: "rgba(245, 158, 11, 0.32)",
          boxShadow: "0 16px 36px rgba(15, 23, 42, 0.14)"
        }}
      >
        <Badge variant="light" color="yellow" radius="xl" className="metering-floating-banner__badge">
          计量同步延迟
        </Badge>
        <Text
          c="orange.8"
          size={isMobile ? "xs" : "sm"}
          className="metering-floating-banner__text"
          lineClamp={2}
        >
          {props.message}
        </Text>
      </Paper>
    </div>,
    document.body
  );
}
