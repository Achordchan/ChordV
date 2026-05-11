import { getCountryFlagClassName } from "@chordv/shared";

type CountryFlagProps = {
  code?: string | null;
  size?: "sm" | "md";
};

export function CountryFlag(props: CountryFlagProps) {
  const className = getCountryFlagClassName(props.code);
  if (!className) {
    return <span className={`country-flag country-flag--placeholder country-flag--${props.size ?? "md"}`} aria-hidden="true" />;
  }

  return <span className={`country-flag ${className} country-flag--${props.size ?? "md"}`} aria-hidden="true" />;
}
