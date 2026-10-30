const KEY = "life-diagnostics-v1";
const LIMIT = 300;

export type LifeDiagnosticStatus = "ok" | "warning" | "error" | "info";

export type LifeDiagnosticEntry = {
  id: string;
  at: string;
  source: string;
  event: string;
  status: LifeDiagnosticStatus;
  detail: string;
  meta?: Record<string, unknown>;
};

export function readLifeDiagnostics(): LifeDiagnosticEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const value = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(value)
      ? value
          .filter(item =>
            item
            && typeof item.id === "string"
            && typeof item.at === "string"
            && typeof item.source === "string",
          )
          .slice(0, LIMIT)
      : [];
  } catch {
    return [];
  }
}

export function recordLifeDiagnostic(
  input: Omit<LifeDiagnosticEntry, "id" | "at"> & { at?: string },
): void {
  if (typeof window === "undefined") return;
  const entry: LifeDiagnosticEntry = {
    ...input,
    id: `life-diag-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    at: input.at || new Date().toISOString(),
    detail: String(input.detail || "").slice(0, 1200),
  };
  try {
    localStorage.setItem(KEY, JSON.stringify([entry, ...readLifeDiagnostics()].slice(0, LIMIT)));
  } catch {
    // Diagnostics must never interrupt the feature being diagnosed.
  }
  window.dispatchEvent(new CustomEvent("life-diagnostics-updated", { detail: entry }));
}

export function clearLifeDiagnostics(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Best effort.
  }
  window.dispatchEvent(new Event("life-diagnostics-updated"));
}
