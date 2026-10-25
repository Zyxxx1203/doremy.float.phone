/**
 * New, additive model for isolated Android home-screen widget instances.
 *
 * This deliberately uses a separate key and type from legacy WidgetProfile/default
 * storage. It is safe to introduce before switching the native provider over:
 * old widgets and old settings are not migrated or rewritten by these helpers.
 */
import { kvGet, kvSet } from "@/lib/kv-db";

export type IsolatedWidgetInstanceStatus = "draft" | "pin-pending" | "bound" | "rendering" | "ready" | "error";

export type IsolatedWidgetInstance = {
    /** App-owned stable identity; never use a characterId/templateId as the instance key. */
    instanceId: string;
    /** Android-assigned identity, set only after the pin callback confirms creation. */
    appWidgetId: number | null;
    name: string;
    characterId: string;
    /** Snapshot copied from the template at creation time; edits do not mutate the template. */
    templateSnapshot: string;
    cssSnapshot: string;
    widthDp: number;
    heightDp: number;
    scale: number;
    /** Per-instance content, intentionally not keyed by characterId. */
    content: { text: string; status?: string; avatar?: string; updatedAt: string };
    status: IsolatedWidgetInstanceStatus;
    lastError?: string;
    createdAt: string;
    updatedAt: string;
};

const KEY = "ai_phone_isolated_widget_instances_v1";

function readAll(): IsolatedWidgetInstance[] {
    try {
        const parsed = JSON.parse(kvGet(KEY) || "[]");
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((item): item is IsolatedWidgetInstance =>
            !!item && typeof item.instanceId === "string" && item.instanceId.length > 0
        );
    } catch {
        return [];
    }
}

function writeAll(items: IsolatedWidgetInstance[]): void {
    kvSet(KEY, JSON.stringify(items));
    if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("isolated-widget-instances-updated"));
    }
}

export function listIsolatedWidgetInstances(): IsolatedWidgetInstance[] {
    return readAll().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function getIsolatedWidgetInstance(instanceId: string): IsolatedWidgetInstance | null {
    return readAll().find(item => item.instanceId === instanceId) ?? null;
}

export function createIsolatedWidgetInstance(input: Omit<IsolatedWidgetInstance, "instanceId" | "appWidgetId" | "status" | "createdAt" | "updatedAt">): IsolatedWidgetInstance {
    const now = new Date().toISOString();
    const instance: IsolatedWidgetInstance = {
        ...input,
        instanceId: `widget-instance-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
        appWidgetId: null,
        status: "draft",
        createdAt: now,
        updatedAt: now,
    };
    writeAll([...readAll(), instance]);
    return instance;
}

export function updateIsolatedWidgetInstance(instanceId: string, patch: Partial<Omit<IsolatedWidgetInstance, "instanceId" | "createdAt">>): IsolatedWidgetInstance | null {
    let updated: IsolatedWidgetInstance | null = null;
    const next = readAll().map(item => {
        if (item.instanceId !== instanceId) return item;
        updated = { ...item, ...patch, instanceId, createdAt: item.createdAt, updatedAt: new Date().toISOString() };
        return updated;
    });
    if (updated) writeAll(next);
    return updated;
}

/** Bind only when Android returns a real ID; duplicate IDs are rejected rather than cross-bound. */
export function bindIsolatedWidgetInstance(instanceId: string, appWidgetId: number): IsolatedWidgetInstance | null {
    if (!Number.isInteger(appWidgetId) || appWidgetId < 0) return null;
    const collision = readAll().find(item => item.appWidgetId === appWidgetId && item.instanceId !== instanceId);
    if (collision) return null;
    return updateIsolatedWidgetInstance(instanceId, { appWidgetId, status: "bound", lastError: undefined });
}

export function removeIsolatedWidgetInstance(instanceId: string): boolean {
    const all = readAll();
    const next = all.filter(item => item.instanceId !== instanceId);
    if (next.length === all.length) return false;
    writeAll(next);
    return true;
}

/** Deliberately does not delete legacy default/profile caches. */
export function setIsolatedWidgetInstanceError(instanceId: string, error: string): IsolatedWidgetInstance | null {
    return updateIsolatedWidgetInstance(instanceId, { status: "error", lastError: error.slice(0, 500) });
}
