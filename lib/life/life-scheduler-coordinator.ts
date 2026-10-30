/**
 * Shared lease for foreground life-scene autonomy and server-side offline scheduling.
 * The foreground owns the scene only while the life page is visible; offline jobs defer
 * against this lease and remain queued for abrupt WebView termination.
 */
export const LIFE_SCENE_FOREGROUND_LEASE_KEY = "life-scene-foreground-lease-v1";

export type LifeSceneForegroundLease = {
  sceneId: string;
  expiresAt: number;
};

export function setLifeSceneForegroundLease(sceneId: string, active: boolean): void {
  if (typeof window === "undefined") return;
  try {
    const current = JSON.parse(localStorage.getItem(LIFE_SCENE_FOREGROUND_LEASE_KEY) || "null") as { sceneId?: string } | null;
    if (active && sceneId) {
      localStorage.setItem(LIFE_SCENE_FOREGROUND_LEASE_KEY, JSON.stringify({ sceneId, expiresAt: Date.now() + 120_000 }));
    } else if (!sceneId || current?.sceneId === sceneId) {
      localStorage.removeItem(LIFE_SCENE_FOREGROUND_LEASE_KEY);
    }
  } catch {
    // Storage can be unavailable in restricted WebViews; server validation still fails closed on scene/location.
  }
}

export function readLifeSceneForegroundLease(now = Date.now()): LifeSceneForegroundLease | null {
  if (typeof window === "undefined") return null;
  try {
    const lease = JSON.parse(localStorage.getItem(LIFE_SCENE_FOREGROUND_LEASE_KEY) || "null") as { sceneId?: string; expiresAt?: number } | null;
    if (!lease?.sceneId || !Number.isFinite(lease.expiresAt) || Number(lease.expiresAt) <= now) return null;
    return { sceneId: lease.sceneId, expiresAt: Number(lease.expiresAt) };
  } catch {
    return null;
  }
}
