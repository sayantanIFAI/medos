/** Navigation is derived from permissions and facility feature flags (never from role names); role only influences order. */

export interface NavItem { href: string; label: string; anyOf?: string[]; feature?: "PHARMACY_ENABLED" | "IPD_ENABLED" | "NURSING_ENABLED" }

export const NAV: NavItem[] = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/patients", label: "Patients", anyOf: ["PATIENT_READ"] },
  { href: "/appointments", label: "Appointments", anyOf: ["APPOINTMENT_READ"] },
  { href: "/queue", label: "OPD queue", anyOf: ["QUEUE_READ"] },
  { href: "/billing", label: "Billing", anyOf: ["INVOICE_READ"] },
  { href: "/pharmacy", label: "Pharmacy", anyOf: ["PHARMACY_READ"], feature: "PHARMACY_ENABLED" },
  { href: "/ipd", label: "Admissions", anyOf: ["ADMISSION_READ"], feature: "IPD_ENABLED" },
  { href: "/nursing", label: "Nursing", anyOf: ["NURSING_READ"], feature: "NURSING_ENABLED" },
  { href: "/reports", label: "Reports", anyOf: ["REPORT_READ"] },
  { href: "/admin", label: "Administration", anyOf: ["ADMIN_USERS", "ADMIN_MASTERS", "ADMIN_SETTINGS"] },
  { href: "/audit", label: "Audit", anyOf: ["AUDIT_READ"] },
];

/** CLAUDE.md §24: what each role sees first. */
const ROLE_ORDER: Record<string, string[]> = {
  RECEPTIONIST: ["/dashboard", "/patients", "/appointments", "/queue", "/ipd", "/billing"],
  DOCTOR: ["/queue", "/patients", "/appointments", "/ipd", "/dashboard"],
  NURSE: ["/nursing", "/ipd", "/patients", "/dashboard"],
  PHARMACIST: ["/pharmacy", "/billing", "/patients", "/dashboard"],
  CASHIER: ["/billing", "/dashboard", "/patients"],
  ADMINISTRATOR: ["/dashboard", "/reports", "/admin", "/audit"],
  MANAGER: ["/dashboard", "/reports", "/billing", "/audit"],
};

export function visibleNav(permissions: ReadonlySet<string>, features: Record<string, boolean>, roles: string[]): NavItem[] {
  const items = NAV.filter((n) => (!n.anyOf || n.anyOf.some((p) => permissions.has(p))) && (!n.feature || features[n.feature] !== false));
  const order = roles.flatMap((r) => ROLE_ORDER[r] ?? []);
  const rank = (href: string) => { const i = order.indexOf(href); return i === -1 ? 1000 + NAV.findIndex((n) => n.href === href) : i; };
  return [...items].sort((a, b) => rank(a.href) - rank(b.href));
}

/** Where to land after login. */
export const homeFor = (items: NavItem[]): string => items[0]?.href ?? "/dashboard";
