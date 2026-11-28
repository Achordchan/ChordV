import { NoticeRow } from "./NoticeRow";

type MeteringFloatingBannerProps = {
  status: "ok" | "degraded";
  message: string | null;
};

export function MeteringFloatingBanner(props: MeteringFloatingBannerProps) {
  if (props.status !== "degraded" || !props.message || typeof document === "undefined") {
    return null;
  }

  // 保留在应用 DOM 中，使移动端定位规则能匹配平台祖先。
  return (
    <div className="metering-floating-banner" aria-live="polite">
      <NoticeRow tone="warning" className="metering-floating-banner__panel">
        <span className="metering-floating-banner__text">
          <strong className="metering-floating-banner__label">计量同步延迟</strong>
          {props.message}
        </span>
      </NoticeRow>
    </div>
  );
}
