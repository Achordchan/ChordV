import type { AdminDomesticProbeStateDto, AdminDomesticProbeTokenDto } from "@chordv/shared";
import { request } from "./base";

export function fetchDomesticProbeState() {
  return request<AdminDomesticProbeStateDto>("/admin/domestic-probe");
}

export function rotateDomesticProbeToken() {
  return request<AdminDomesticProbeTokenDto>("/admin/domestic-probe/token", { method: "POST" });
}

export function revokeDomesticProbeToken() {
  return request<AdminDomesticProbeStateDto>("/admin/domestic-probe/token", { method: "DELETE" });
}
