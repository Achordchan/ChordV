import * as countries from "i18n-iso-countries";
import zhLocale from "i18n-iso-countries/langs/zh.json";

countries.registerLocale(zhLocale);

const COUNTRY_CODE_ALIASES: Record<string, string> = {
  香港: "HK",
  "中国香港特别行政区": "HK",
  "香港特别行政区": "HK",
  新加坡: "SG",
  日本: "JP",
  美国: "US",
  中国: "CN",
  台湾: "TW",
  "中国台湾": "TW",
  "台湾省": "TW",
  韩国: "KR",
  英国: "GB",
  澳大利亚: "AU",
  加拿大: "CA",
  德国: "DE",
  法国: "FR",
  荷兰: "NL",
  马来西亚: "MY",
  泰国: "TH",
  越南: "VN",
  菲律宾: "PH",
  印度尼西亚: "ID",
  新西兰: "NZ"
};

const COUNTRY_NAME_ALIASES: Record<string, string> = {
  HK: "香港",
  SG: "新加坡",
  JP: "日本",
  US: "美国",
  CN: "中国",
  TW: "台湾",
  KR: "韩国",
  GB: "英国",
  AU: "澳大利亚",
  CA: "加拿大",
  DE: "德国",
  FR: "法国",
  NL: "荷兰",
  MY: "马来西亚",
  TH: "泰国",
  VN: "越南",
  PH: "菲律宾",
  ID: "印度尼西亚",
  NZ: "新西兰"
};

export type CountryOption = {
  code: string;
  label: string;
};

const countryNames = countries.getNames("zh") as Record<string, string>;

export const countryOptions: CountryOption[] = Object.entries(countryNames)
  .map(([code, label]) => ({
    code,
    label: COUNTRY_NAME_ALIASES[code] ?? label
  }))
  .sort((left, right) => left.label.localeCompare(right.label, "zh"));

export function normalizeCountryCode(value?: string | null) {
  const code = value?.trim().toUpperCase();
  if (!code) {
    return null;
  }
  if (countries.isValid(code)) {
    return code;
  }
  return null;
}

export function getCountryNameFromCode(code?: string | null) {
  const normalized = normalizeCountryCode(code);
  if (!normalized) {
    return null;
  }
  return COUNTRY_NAME_ALIASES[normalized] ?? countries.getName(normalized, "zh") ?? normalized;
}

export function getCountryCodeFromName(name?: string | null) {
  const value = name?.trim();
  if (!value) {
    return null;
  }

  const normalizedCode = normalizeCountryCode(value);
  if (normalizedCode) {
    return normalizedCode;
  }

  return COUNTRY_CODE_ALIASES[value] ?? countries.getAlpha2Code(value, "zh") ?? countries.getAlpha2Code(value, "en") ?? null;
}

export function getCountryLabelFromCode(code?: string | null) {
  return getCountryNameFromCode(code) ?? null;
}

export function getCountryFlagClassName(code?: string | null) {
  const normalized = normalizeCountryCode(code);
  return normalized ? `fi fi-${normalized.toLowerCase()}` : null;
}

export function resolveCountryCode(value: { countryCode?: string | null; region?: string | null; name?: string | null; host?: string | null }) {
  return (
    normalizeCountryCode(value.countryCode) ??
    getCountryCodeFromName(value.region) ??
    getCountryCodeFromName(value.name) ??
    getCountryCodeFromName(value.host) ??
    null
  );
}
