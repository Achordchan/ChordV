import { readStoredGeoVersionLabel } from "./geoUpdate";
import { getRuntimeComponentLocalInfo } from "./runtime";
import type { SupportComponentsInfo } from "./supportContext";

/**
 * 打开工单时读取本机组件情况：三个组件文件是否都在、Xray 版本、规则库版本。
 * 只用到版本标签和“是否存在”，不读取也不上报文件路径。网页预览、安卓端没有这些组件，返回 null。
 */
export async function loadSupportComponentsInfo(): Promise<SupportComponentsInfo | null> {
  const [xray, geoip, geosite] = await Promise.all([
    getRuntimeComponentLocalInfo("xray").catch(() => null),
    getRuntimeComponentLocalInfo("geoip").catch(() => null),
    getRuntimeComponentLocalInfo("geosite").catch(() => null)
  ]);
  if (!xray && !geoip && !geosite) {
    return null;
  }
  let geoVersion: string | null = null;
  try {
    geoVersion = readStoredGeoVersionLabel();
  } catch {
    geoVersion = null;
  }
  const known = [xray, geoip, geosite].every((item) => item !== null);
  const complete = [xray, geoip, geosite].every((item) => Boolean(item?.exists && (item.sizeBytes ?? 0) > 0));
  return {
    xrayVersion: xray?.exists ? xray.versionLabel : null,
    geoVersion,
    complete: complete ? true : known ? false : null
  };
}
