/**
 * 统一的文件保存入口。
 *
 * 之前的写法各页面自己 `anchor.click()`，在 Android WebView（APK 壳）里会静默失败：
 * 用户点了导出，什么都没发生，也没有任何提示。原生壳其实提供了
 * `AndroidShell.saveBase64File(fileName, base64): Boolean`，但网页侧从未调用。
 *
 * 这里按能力分派，并把结果收敛成用户能看懂的四态：
 *   native-saved      原生保存成功
 *   browser-triggered 已触发浏览器下载
 *   failed            下载失败
 *   unconfirmed       无法确认是否保存成功（WebView 吞掉了结果，且没有原生桥）
 */

export type DownloadOutcome = "native-saved" | "browser-triggered" | "failed" | "unconfirmed";

export type DownloadResult = { outcome: DownloadOutcome; message: string };

type NativeShell = {
  saveBase64File?: (fileName: string, base64: string) => boolean;
  downloadUrl?: (url: string, fileName: string) => boolean;
};

function getNativeShell(): NativeShell | null {
  if (typeof window === "undefined") return null;
  const shell = (window as unknown as { AndroidShell?: NativeShell }).AndroidShell;
  return shell && typeof shell === "object" ? shell : null;
}

/** 是否运行在 Android WebView 壳里（壳内 anchor 下载经常被吞掉）。 */
function isWebViewShell(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  return /Android/i.test(ua) && (/\bwv\b/i.test(ua) || /; wv\)/i.test(ua));
}

function splitDataUrl(dataUrl: string): { base64: string } | null {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return null;
  return { base64: dataUrl.slice(comma + 1) };
}

/** 用 <a download> 触发浏览器下载；结果只能确认「已触发」，无法确认最终是否落盘。 */
function saveViaAnchor(dataUrl: string, fileName: string): DownloadResult {
  if (typeof document === "undefined") {
    return { outcome: "failed", message: "当前环境无法发起下载。" };
  }
  const probe = document.createElement("a");
  if (typeof probe.download === "undefined") {
    return { outcome: "failed", message: "当前浏览器不支持直接下载，请长按图片另存为。" };
  }
  try {
    probe.href = dataUrl;
    probe.download = fileName;
    probe.style.display = "none";
    document.body.appendChild(probe);
    probe.click();
    probe.remove();
  } catch (error) {
    probe.remove();
    return { outcome: "failed", message: "触发下载失败：" + (error instanceof Error ? error.message : String(error)) };
  }
  // WebView 里 anchor 往往没有任何反馈：既然没有原生桥，就不能声称保存成功。
  if (isWebViewShell()) {
    return { outcome: "unconfirmed", message: "已尝试触发下载，但当前 App 壳没有回报保存结果，请到系统下载目录确认。" };
  }
  return { outcome: "browser-triggered", message: "已触发浏览器下载，请到下载列表确认最终结果。" };
}

/** 保存一个 dataURL（如 canvas.toDataURL 的结果）。 */
export async function saveDataUrl(dataUrl: string, fileName: string): Promise<DownloadResult> {
  if (!dataUrl) return { outcome: "failed", message: "没有可保存的内容。" };

  const shell = getNativeShell();
  if (shell?.saveBase64File) {
    const payload = splitDataUrl(dataUrl);
    if (payload) {
      try {
        // 原生返回 Boolean：true 代表已写入系统下载目录。
        const ok = shell.saveBase64File(fileName, payload.base64);
        return ok
          ? { outcome: "native-saved", message: `已保存到系统下载目录：${fileName}` }
          : { outcome: "failed", message: "系统没有接受这次保存，文件未写入。" };
      } catch (error) {
        return { outcome: "failed", message: "原生保存出错：" + (error instanceof Error ? error.message : String(error)) };
      }
    }
  }

  return saveViaAnchor(dataUrl, fileName);
}

/** 保存一个远端直链（交给系统下载管理器，可在后台继续）。 */
export async function saveRemoteUrl(url: string, fileName: string): Promise<DownloadResult> {
  const shell = getNativeShell();
  if (shell?.downloadUrl) {
    try {
      const ok = shell.downloadUrl(url, fileName);
      return ok
        ? { outcome: "native-saved", message: `已交给系统下载：${fileName}` }
        : { outcome: "failed", message: "系统没有接受这次下载请求。" };
    } catch (error) {
      return { outcome: "failed", message: "提交下载失败：" + (error instanceof Error ? error.message : String(error)) };
    }
  }
  if (typeof document === "undefined") return { outcome: "failed", message: "当前环境无法发起下载。" };
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.rel = "noopener";
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } catch (error) {
    return { outcome: "failed", message: "触发下载失败：" + (error instanceof Error ? error.message : String(error)) };
  }
  return isWebViewShell()
    ? { outcome: "unconfirmed", message: "已尝试触发下载，但当前 App 壳没有回报保存结果，请到系统下载目录确认。" }
    : { outcome: "browser-triggered", message: "已触发浏览器下载，请到下载列表确认最终结果。" };
}
