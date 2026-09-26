import { createPortal } from "react-dom";
import { NoticeRow } from "./NoticeRow";

type MeteringFloatingBannerProps = {
  status: "ok" | "degraded";
  message: string | null;
};

export function MeteringFloatingBanner(props: MeteringFloatingBannerProps) {
  if (props.status !== "degraded" || !props.message || typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <div className="metering-floating-banner" aria-live="polite">
      <NoticeRow tone="warning" className="metering-floating-banner__panel">
        <span className="metering-floating-banner__text">
          <strong className="metering-floating-banner__label">计量同步延迟</strong>
          {props.message}
        </span>
      </NoticeRow>
    </div>,
    document.body
  );
}
