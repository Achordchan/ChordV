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
      <Paper withBorder p="sm" className="metering-floating-banner__panel">
        <Badge variant="light" color="yellow" className="metering-floating-banner__badge">
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
