import { ToolInputError } from "./errors";

export const PERIODS = ["today", "yesterday", "last_7_days", "last_28_days"] as const;
export type Period = (typeof PERIODS)[number];

export function parsePeriod(value: unknown, fallback: Period = "today"): Period {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "string" && (PERIODS as readonly string[]).includes(value)) return value as Period;
  throw new ToolInputError(`period must be one of: ${PERIODS.join(", ")}`);
}

export interface Comparison {
  current: number;
  previous: number;
  /** Whole-number percent change, or null when the previous value is zero. */
  changePercent: number | null;
}

export function compare(current: number, previous: number): Comparison {
  return {
    current: round2(current),
    previous: round2(previous),
    changePercent: previous === 0 ? null : Math.round(((current - previous) / previous) * 100),
  };
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
