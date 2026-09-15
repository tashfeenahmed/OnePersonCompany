import { AppWindow, BriefcaseBusiness, Globe, Monitor, Package, Smartphone, Store, type LucideIcon } from "lucide-react";
import type { BusinessType } from "../../../shared/ventureJourney";

/** The same business type keeps its icon in setup and venture forms. */
export const BUSINESS_TYPE_ICONS: Record<BusinessType, LucideIcon> = {
  web: AppWindow,
  mobile: Smartphone,
  desktop: Monitor,
  website: Globe,
  shop: Store,
  goods: Package,
  service: BriefcaseBusiness,
};
