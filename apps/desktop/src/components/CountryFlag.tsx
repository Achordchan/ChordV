type CountryFlagProps = {
  code?: string | null;
  size?: "sm" | "md";
};

function getCountryFlagClassName(code?: string | null) {
  const normalized = code?.trim().toUpperCase();
  if (!normalized || !/^[A-Z]{2}$/.test(normalized)) {
    return null;
  }
  return `fi fi-${normalized.toLowerCase()}`;
}

export function CountryFlag(props: CountryFlagProps) {
  const className = getCountryFlagClassName(props.code);
  if (!className) {
    return <span className={`country-flag country-flag--placeholder country-flag--${props.size ?? "md"}`} aria-hidden="true" />;
  }

  return <span className={`country-flag ${className} country-flag--${props.size ?? "md"}`} aria-hidden="true" />;
}
