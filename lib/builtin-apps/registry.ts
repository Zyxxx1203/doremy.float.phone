import { loadInstalledCustomApps } from "../custom-app-storage";
import type { InstalledCustomApp } from "../custom-app-types";
import { buildHeartcraftApp, HEARTCRAFT_APP_ID, HEARTCRAFT_MANIFEST } from "./heartcraft-meta";

/**
 * 内置应用也要参与「聊天工具箱 / 富媒体指令 / 后台事件」这三张注册表，
 * 否则装成内置版之后，角色就看不到手作工具、也不会从聊天里自动开工。
 *
 * 规则：如果用户自己从应用市场装了同一个 manifest id 的版本，就让市场版接管，
 * 避免同一个 APP 出现两套工具/两条指令。两版共用同一个 app id，数据也是同一份。
 */
export function isHeartcraftInstalled(): boolean {
  return loadInstalledCustomApps().some(
    (app) => (app.manifest?.id || app.id) === HEARTCRAFT_MANIFEST.id || app.id === HEARTCRAFT_APP_ID,
  );
}

/** 按 app id 取内置应用（不含 HTML，够做存在性判断/权限判断）。 */
export function getBuiltinCustomApp(appId: string): InstalledCustomApp | null {
  return appId === HEARTCRAFT_APP_ID ? buildHeartcraftApp("") : null;
}

/** 已安装应用 + 内置应用（内置的排在前面；市场版存在时不加内置）。 */
export function loadAllCustomApps(): InstalledCustomApp[] {
  const installed = loadInstalledCustomApps();
  if (isHeartcraftInstalled()) return installed;
  return [buildHeartcraftApp(""), ...installed];
}
