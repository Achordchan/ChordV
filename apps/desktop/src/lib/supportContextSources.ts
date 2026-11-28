import { isRuntimeComponentVerified, readStoredGeoVersionLabel } from "./geoUpdate";
import { getRuntimeComponentLocalInfo } from "./runtime";
import type { SupportComponentsInfo } from "./supportContext";

/**
 * 打开工单时读取本机安装校验结果与版本标签，不上报文件路径。
 * 网页预览、安卓端没有这些组件，返回 null；本地校验不代表发行签名证明。
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
  const complete = [xray, geoip, geosite].every(isRuntimeComponentVerified);
  return {
    xrayVersion: isRuntimeComponentVerified(xray) ? xray.versionLabel : null,
    geoVersion: isRuntimeComponentVerified(geoip) && isRuntimeComponentVerified(geosite) ? geoVersion : null,
    complete: complete ? true : known ? false : null
  };
}
