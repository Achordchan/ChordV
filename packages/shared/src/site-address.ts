export type SiteAddressConfigDto = {
  primaryOrigin: string;
  legacyOrigins: string[];
  updatedAt: string | null;
};
export type UpdateSiteAddressConfigDto = Pick<SiteAddressConfigDto, "primaryOrigin" | "legacyOrigins">;
