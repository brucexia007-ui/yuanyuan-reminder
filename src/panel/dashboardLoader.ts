import type {
  AppSettings,
  FocusState,
  PetCareSnapshot,
  TodaySnapshot,
} from "../types";

export type DashboardModule = "today" | "settings" | "focus" | "care";

export interface DashboardValues {
  today: TodaySnapshot;
  settings: AppSettings;
  focus: FocusState;
  care: PetCareSnapshot;
}

export type DashboardResult = {
  [Key in DashboardModule]:
    | { ok: true; value: DashboardValues[Key] }
    | { ok: false; error: string };
};

export async function loadDashboard(loaders: {
  [Key in DashboardModule]: () => Promise<DashboardValues[Key]>;
}): Promise<DashboardResult> {
  const keys: DashboardModule[] = ["today", "settings", "focus", "care"];
  const settled = await Promise.allSettled(keys.map((key) => loaders[key]()));
  return Object.fromEntries(
    keys.map((key, index) => {
      const result = settled[index];
      return [
        key,
        result.status === "fulfilled"
          ? { ok: true, value: result.value }
          : { ok: false, error: String(result.reason) },
      ];
    }),
  ) as DashboardResult;
}
