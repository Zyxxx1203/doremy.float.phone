/**
 * Gemini Files API video understanding.
 *
 * This intentionally uses the user's existing direct Google/Gemini API binding.
 * The video is uploaded as a file (not reduced to screenshots), then attached to
 * generateContent. The temporary Gemini file is deleted best-effort after analysis.
 */
export type GeminiVideoProgress = (message: string) => void;

type GeminiUploadedFile = {
  name?: string;
  uri?: string;
  mimeType?: string;
  state?: string;
  error?: { message?: string };
};

function readErrorMessage(payload: unknown, fallback: string): string {
  if (payload && typeof payload === "object") {
    const error = (payload as { error?: { message?: unknown } }).error;
    if (typeof error?.message === "string" && error.message.trim()) return error.message;
  }
  return fallback;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return await response.json() as Record<string, unknown>;
  } catch {
    throw new Error("视频 API 返回了无法识别的响应。");
  }
}

export async function analyzeWholeVideoWithGemini(options: {
  file: File;
  apiKey: string;
  model: string;
  prompt: string;
  signal?: AbortSignal;
  onProgress?: GeminiVideoProgress;
}): Promise<string> {
  const { file, apiKey, model, prompt, signal, onProgress } = options;
  if (!apiKey.trim()) throw new Error("当前角色绑定的 Gemini API 没有填写密钥。");
  if (!model.trim()) throw new Error("当前角色绑定的 Gemini API 没有设置模型。");
  if (!file.type.startsWith("video/")) throw new Error("所选文件不是可识别的视频文件。");
  if (file.size <= 0) throw new Error("视频文件为空。");
  // Files API can handle large files, but impose a conservative client guard to avoid
  // accidental huge mobile uploads and excessive data charges.
  if (file.size > 1024 * 1024 * 1024) throw new Error("视频超过 1 GB。请先压缩视频再发送，避免手机上传失败或产生过高费用。");

  const apiRoot = "https://generativelanguage.googleapis.com";
  const keyQuery = "?key=" + encodeURIComponent(apiKey.trim());
  let uploadedName = "";
  const mimeType = file.type || "video/mp4";

  try {
    onProgress?.("正在向 Gemini 上传完整视频…");
    const startResponse = await fetch(apiRoot + "/upload/v1beta/files" + keyQuery, {
      method: "POST",
      headers: {
        "X-Goog-Upload-Protocol": "resumable",
        "X-Goog-Upload-Command": "start",
        "X-Goog-Upload-Header-Content-Length": String(file.size),
        "X-Goog-Upload-Header-Content-Type": mimeType,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ file: { display_name: file.name.slice(0, 200) } }),
      signal,
    });
    if (!startResponse.ok) {
      const payload = await startResponse.json().catch(() => null);
      throw new Error(readErrorMessage(payload, "无法初始化 Gemini 视频上传（HTTP " + startResponse.status + "）。"));
    }
    const uploadUrl = startResponse.headers.get("x-goog-upload-url");
    if (!uploadUrl) {
      throw new Error("Gemini 没有返回上传地址。当前浏览器或 API 中转站可能不支持 Files API；请使用直连 Google Gemini API。");
    }

    const uploadResponse = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        "X-Goog-Upload-Offset": "0",
        "X-Goog-Upload-Command": "upload, finalize",
        "Content-Type": mimeType,
      },
      body: file,
      signal,
    });
    const uploadPayload = await uploadResponse.json().catch(() => null) as { file?: GeminiUploadedFile; error?: { message?: string } } | null;
    if (!uploadResponse.ok) {
      throw new Error(readErrorMessage(uploadPayload, "视频上传失败（HTTP " + uploadResponse.status + "）。"));
    }
    const uploaded = uploadPayload?.file;
    uploadedName = uploaded?.name || "";
    if (!uploadedName || !uploaded?.uri) {
      throw new Error("Gemini 上传完成，但没有返回可供模型读取的视频文件 URI。");
    }

    let activeFile = uploaded;
    // Gemini may need time to process video/audio tracks before it can be analyzed.
    for (let attempt = 0; activeFile.state && activeFile.state !== "ACTIVE"; attempt += 1) {
      if (activeFile.state === "FAILED") throw new Error(activeFile.error?.message || "Gemini 视频预处理失败。");
      if (attempt >= 60) throw new Error("Gemini 视频预处理超时，请稍后重试。");
      onProgress?.("Gemini 正在识别视频与音轨…");
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, Math.min(2000 + attempt * 250, 5000));
        if (signal) {
          const abort = () => { clearTimeout(timer); reject(new DOMException("已取消视频分析。", "AbortError")); };
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        }
      });
      const statusResponse = await fetch(apiRoot + "/v1beta/" + encodeURIComponent(uploadedName).replace(/%2F/g, "/") + keyQuery, { signal });
      const statusPayload = await statusResponse.json().catch(() => null) as { file?: GeminiUploadedFile; error?: { message?: string } } | null;
      if (!statusResponse.ok || !statusPayload?.file) {
        throw new Error(readErrorMessage(statusPayload, "读取 Gemini 视频处理状态失败。"));
      }
      activeFile = statusPayload.file;
    }

    onProgress?.("视频已就绪，角色正在完整观看并组织回应…");
    const normalizedModel = model.trim().replace(/^models\//, "");
    const generateResponse = await fetch(apiRoot + "/v1beta/models/" + encodeURIComponent(normalizedModel) + ":generateContent" + keyQuery, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts: [
            { fileData: { mimeType: activeFile.mimeType || mimeType, fileUri: activeFile.uri || uploaded.uri } },
            { text: prompt },
          ],
        }],
        generationConfig: { temperature: 0.8, maxOutputTokens: 2048 },
      }),
      signal,
    });
    const generatedPayload = await generateResponse.json().catch(() => null) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
      error?: { message?: string };
    } | null;
    if (!generateResponse.ok) {
      throw new Error(readErrorMessage(generatedPayload, "Gemini 视频理解失败（HTTP " + generateResponse.status + "）。"));
    }
    const text = (generatedPayload?.candidates?.[0]?.content?.parts || [])
      .map(part => typeof part.text === "string" ? part.text : "")
      .filter(Boolean)
      .join("\n")
      .trim();
    if (!text) throw new Error("Gemini 没有返回文字回应。模型可能不支持视频输入，或本次输出被安全策略拦截。");
    return text;
  } finally {
    if (uploadedName) {
      // Files API files are temporary, but delete promptly rather than leaving the
      // user's personal video around until the provider's automatic expiry.
      void fetch(apiRoot + "/v1beta/" + encodeURIComponent(uploadedName).replace(/%2F/g, "/") + keyQuery, {
        method: "DELETE",
        keepalive: true,
      }).catch(() => {});
    }
  }
}
