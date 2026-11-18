import JSZip from "jszip";
import type { DiaryEntry } from "./diary-entry-types";

export type DiaryExportFormat = "txt" | "md";

function safeFileName(value: string): string {
  return String(value || "日记")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 64) || "日记";
}

function entryBody(entry: DiaryEntry): string {
  return String(entry.body || entry.blocks.map(block => {
    if (block.type === "paragraph" || block.type === "quote") return block.text;
    if (block.type === "correction") return block.replacement || block.text;
    if (block.type === "image") return block.caption ? block.caption + "：" + block.description : block.description;
    if (block.type === "todo") return block.items.map(item => (item.done ? "✓ " : "□ ") + item.text).join("\n");
    return "";
  }).filter(Boolean).join("\n\n")).trim();
}

export function diaryEntryToMarkdown(entry: DiaryEntry): string {
  const meta = [entry.dateLabel, entry.weather].filter(Boolean).join(" · ");
  return [
    "# " + (entry.title || "未命名日记"),
    "",
    meta,
    "",
    entryBody(entry),
    "",
    "---",
    entry.characterName,
  ].filter((line, index, lines) => line !== "" || (index > 0 && lines[index - 1] !== "")).join("\n");
}

export function diaryEntryToText(entry: DiaryEntry): string {
  return [
    entry.title || "未命名日记",
    [entry.dateLabel, entry.weather].filter(Boolean).join(" · "),
    "",
    entryBody(entry),
    "",
    entry.characterName,
  ].join("\n");
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export function downloadDiaryEntry(entry: DiaryEntry, format: DiaryExportFormat): void {
  const filename = safeFileName(entry.dateLabel || entry.createdAt.slice(0, 10)) + "_" + safeFileName(entry.title);
  const markdown = diaryEntryToMarkdown(entry);
  const blob = new Blob(
    [format === "md" ? markdown : diaryEntryToText(entry)],
    { type: format === "md" ? "text/markdown;charset=utf-8" : "text/plain;charset=utf-8" },
  );
  downloadBlob(blob, filename + "." + format);
}

export async function downloadDiaryEntriesZip(entries: DiaryEntry[]): Promise<void> {
  if (!entries.length) throw new Error("当前没有可导出的日记。");
  const zip = new JSZip();
  for (const entry of entries) {
    const folder = safeFileName(entry.characterName);
    const date = safeFileName(entry.dateLabel || entry.createdAt.slice(0, 10));
    const title = safeFileName(entry.title);
    zip.file(folder + "/" + date + "_" + title + ".md", diaryEntryToMarkdown(entry));
  }
  const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
  downloadBlob(blob, "日记导出_" + new Date().toISOString().slice(0, 10) + ".zip");
}

export async function shareDiaryEntry(entry: DiaryEntry): Promise<"shared" | "copied"> {
  const text = diaryEntryToText(entry);
  const title = entry.title || entry.characterName + "的日记";
  const nav = navigator as Navigator & { share?: (data: ShareData) => Promise<void> };
  if (typeof nav.share === "function") {
    await nav.share({ title, text });
    return "shared";
  }
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return "copied";
  }
  throw new Error("当前环境不支持系统分享或剪贴板。");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char] || char));
}

/** Opens a print-ready, article-only page; the browser print dialog can save it as PDF. */
export function printDiaryEntryAsPdf(entry: DiaryEntry): void {
  const printWindow = window.open("", "_blank");
  if (!printWindow) throw new Error("浏览器拦截了打印页面，请允许此站点打开新窗口后重试。");
  const body = entryBody(entry).split(/\n{2,}/).map(paragraph => "<p>" + escapeHtml(paragraph).replace(/\n/g, "<br>") + "</p>").join("");
  const title = escapeHtml(entry.title || "未命名日记");
  const meta = escapeHtml([entry.dateLabel, entry.weather].filter(Boolean).join(" · "));
  const author = escapeHtml(entry.characterName);
  printWindow.document.open();
  printWindow.document.write(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>
    @page{size:auto;margin:22mm 18mm}*{box-sizing:border-box}body{max-width:720px;margin:0 auto;color:#302d28;font-family:"Noto Serif SC","Songti SC",serif;line-height:1.9;font-size:15px}
    h1{font-size:25px;font-weight:500;line-height:1.4;margin:0 0 12px}.meta{color:#81786d;font-size:12px;margin-bottom:34px}
    p{white-space:pre-wrap;margin:0 0 1.2em;text-indent:2em;overflow-wrap:anywhere}.author{text-align:right;color:#81786d;margin-top:36px;font-size:13px}
  </style></head><body><h1>${title}</h1><div class="meta">${meta}</div>${body}<div class="author">${author}</div><script>window.onload=()=>setTimeout(()=>window.print(),350);</script></body></html>`);
  printWindow.document.close();
  printWindow.focus();
}
