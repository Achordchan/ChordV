import limits from "./update-limits.data.json";

export const MAX_DESKTOP_UPDATE_DOWNLOAD_BYTES = limits.maxDesktopUpdateDownloadBytes;

const updateLimits = { MAX_DESKTOP_UPDATE_DOWNLOAD_BYTES } as const;
export default updateLimits;
