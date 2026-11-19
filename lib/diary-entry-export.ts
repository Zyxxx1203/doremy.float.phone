import JSZip from "jszip";
import type { DiaryEntry } from "./diary-entry-types";
import { downloadFile } from "./download-utils";

export type DiaryExportFormat = "txt" | "md";

function safeFileName(value: string): string {
  return String(value || "日记")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 64) || "日记";
}

function entryBody(entry: DiaryEntry): string {
  return entry.blocks.map(block => {
    if (block.type === "paragraph") return block.text;
    if (block.type === "quote") return "> " + block.text.replace(/\n/g, "\n> ");
    if (block.type === "correction") return block.replacement ? "~~" + block.text + "~~ → **" + block.replacement + "**" : "~~" + block.text + "~~";
    if (block.type === "image") return "**图片记录：" + (block.caption || "未命名图片") + "**\n\n> " + block.description;
    if (block.type === "todo") return [block.title ? "### " + block.title : "", ...block.items.map(item => (item.done ? "- [x] " : "- [ ] ") + item.text)].filter(Boolean).join("\n");
    return "";
  }).filter(Boolean).join("\n\n");
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


export async function downloadDiaryEntry(entry: DiaryEntry, format: DiaryExportFormat): Promise<void> {
  const filename = safeFileName(entry.dateLabel || entry.createdAt.slice(0, 10)) + "_" + safeFileName(entry.title);
  const markdown = diaryEntryToMarkdown(entry);
  const blob = new Blob(
    [format === "md" ? markdown : diaryEntryToText(entry)],
    { type: format === "md" ? "text/markdown;charset=utf-8" : "text/plain;charset=utf-8" },
  );
  await downloadFile(blob, filename + "." + format);
}

export async function downloadDiaryEntriesZip(entries: DiaryEntry[]): Promise<void> {
  if (!entries.length) throw new Error("当前没有可导出的日记。");
  const zip = new JSZip();
  for (const entry of entries) {
    const folder = safeFileName(entry.characterName);
    const date = safeFileName(entry.dateLabel || entry.createdAt.slice(0, 10));
    const title = safeFileName(entry.title);
    zip.file(folder + "/" + date + "_" + title + "_" + safeFileName(entry.id.slice(-8)) + ".md", diaryEntryToMarkdown(entry));
  }
  const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
  await downloadFile(blob, "日记导出_" + new Date().toISOString().slice(0, 10) + ".zip");
}


function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char] || char));
}

/** Opens a print-ready, article-only page; the browser print dialog can save it as PDF. */
export function printDiaryEntryAsPdf(entry: DiaryEntry, fontFamily = "serif", fontScale = 1, fontDataUrl?: string | null): void {
  const printWindow = window.open("", "_blank");
  if (!printWindow) throw new Error("浏览器拦截了打印页面，请允许此站点打开新窗口后重试。");
  const body = entry.blocks.map(block => { if (block.type === "todo") return "<section><h3>" + escapeHtml(block.title || "待办") + "</h3><ul>" + block.items.map(item => "<li>" + (item.done ? "☑" : "□") + " " + escapeHtml(item.text) + "</li>").join("") + "</ul></section>"; if (block.type === "quote") return "<blockquote>" + escapeHtml(block.text) + "</blockquote>"; if (block.type === "correction") return "<p><del>" + escapeHtml(block.text) + "</del> <ins>" + escapeHtml(block.replacement || "") + "</ins></p>"; if (block.type === "image") return "<figure><figcaption>" + escapeHtml(block.caption || "") + "</figcaption><p>" + escapeHtml(block.description) + "</p></figure>"; return "<p>" + escapeHtml(block.text) + "</p>"; }).join("");
  const title = escapeHtml(entry.title || "未命名日记");
  const meta = escapeHtml([entry.dateLabel, entry.weather].filter(Boolean).join(" · "));
  const author = escapeHtml(entry.characterName);
  const safeFontFamily = fontFamily.replaceAll('"', "").replaceAll("'", "");
  printWindow.document.open();
  printWindow.document.write(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${fontDataUrl ? "@font-face{font-family:DiaryExportFont;src:url('" + fontDataUrl + "')}" : ""}
    @page{size:auto;margin:22mm 18mm}*{box-sizing:border-box}body{max-width:720px;margin:0 auto;color:#302d28;font-family:${fontDataUrl ? "'DiaryExportFont'," : ""}${safeFontFamily},"Noto Serif SC","Songti SC",serif;line-height:1.9;font-size:${15*fontScale}px}
    h1{font-size:25px;font-weight:500;line-height:1.4;margin:0 0 12px}.meta{color:#81786d;font-size:12px;margin-bottom:34px}
    p{white-space:pre-wrap;margin:0 0 1.2em;text-indent:2em;overflow-wrap:anywhere}.author{text-align:right;color:#81786d;margin-top:36px;font-size:13px}
  </style></head><body><h1>${title}</h1><div class="meta">${meta}</div>${body}<div class="author">${author}</div><script>window.onload=()=>setTimeout(()=>window.print(),350);</script></body></html>`);
  printWindow.document.close();
  printWindow.focus();
}


/** Render a complete, vertically paginated-feeling paper card as one long PNG. */
export async function downloadDiaryEntryImage(entry: DiaryEntry, renderedPaper: HTMLElement, fontDataUrl?: string | null): Promise<void> {
  if (!renderedPaper?.isConnected) throw new Error("日记页面已关闭，请重新打开后导出。");
  await document.fonts.ready;

  const copyComputedTree = (source: Element, target: Element): void => {
    const computed = window.getComputedStyle(source);
    for (let index = 0; index < computed.length; index += 1) {
      const property = computed.item(index);
      (target as HTMLElement).style.setProperty(property, computed.getPropertyValue(property), computed.getPropertyPriority(property));
    }

    const sourceChildren = Array.from(source.children);
    const targetChildren = Array.from(target.children);
    sourceChildren.forEach((child, index) => {
      const targetChild = targetChildren[index];
      if (targetChild) copyComputedTree(child, targetChild);
    });

    for (const pseudoName of ["::before", "::after"] as const) {
      const pseudo = window.getComputedStyle(source, pseudoName);
      if (!pseudo.content || pseudo.content === "none" || pseudo.content === "normal") continue;
      const pseudoNode = document.createElement("span");
      pseudoNode.setAttribute("aria-hidden", "true");
      const content = pseudo.content;
      pseudoNode.textContent = content.length >= 2 && ((content.startsWith('"') && content.endsWith('"')) || (content.startsWith("'") && content.endsWith("'")))
        ? content.slice(1, -1)
        : "";
      for (let index = 0; index < pseudo.length; index += 1) {
        const property = pseudo.item(index);
        if (property !== "content") pseudoNode.style.setProperty(property, pseudo.getPropertyValue(property), pseudo.getPropertyPriority(property));
      }
      if (pseudoName === "::before") target.insertBefore(pseudoNode, target.firstChild);
      else target.appendChild(pseudoNode);
    }
  };

  const bounds = renderedPaper.getBoundingClientRect();
  const width = Math.max(280, Math.ceil(bounds.width));
  const wrapper = document.createElement("div");
  wrapper.style.cssText = "position:fixed;left:-100000px;top:0;z-index:-1;display:block;width:" + width + "px;padding:72px 0 28px;box-sizing:border-box;overflow:visible;background:transparent;";
  const clone = renderedPaper.cloneNode(true) as HTMLElement;
  copyComputedTree(renderedPaper, clone);

  clone.querySelector(".diary-entry-reading-nav")?.remove();
  clone.querySelector(".diary-entry-detail-actions")?.remove();
  clone.querySelector(".diary-entry-detail-top > button")?.remove();
  clone.style.setProperty("width", width + "px", "important");
  clone.style.setProperty("max-width", "none", "important");
  clone.style.setProperty("max-height", "none", "important");
  clone.style.setProperty("height", "auto", "important");
  clone.style.setProperty("overflow", "visible", "important");
  clone.style.setProperty("position", "relative", "important");
  clone.style.setProperty("transform", "none", "important");
  const scroll = clone.querySelector<HTMLElement>(".diary-entry-detail-scroll");
  if (scroll) {
    scroll.style.setProperty("max-height", "none", "important");
    scroll.style.setProperty("height", "auto", "important");
    scroll.style.setProperty("overflow", "visible", "important");
  }
  wrapper.appendChild(clone);
  for (const image of Array.from(clone.querySelectorAll("img"))) {
    const source = image.currentSrc || image.getAttribute("src");
    if (source) image.setAttribute("src", new URL(source, document.baseURI).href);
    image.removeAttribute("srcset");
  }
  document.body.appendChild(wrapper);

  try {
    await Promise.all(Array.from(clone.querySelectorAll("img")).map(image => image.complete
      ? Promise.resolve()
      : new Promise<void>(resolve => { image.onload = () => resolve(); image.onerror = () => resolve(); })));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const contentHeight = Math.ceil(Math.max(clone.getBoundingClientRect().height, clone.scrollHeight));
    const height = contentHeight + 100;
    if (height > 30000) throw new Error("日记过长，超出单张图片的安全尺寸。");
    wrapper.style.height = height + "px";
    const ratio = Math.min(3, 16000 / Math.max(width, height), Math.sqrt(48000000 / (width * height)));
    const pixelWidth = Math.max(1, Math.round(width * ratio));
    const pixelHeight = Math.max(1, Math.round(height * ratio));
    const fontFaceRules: string[] = [];
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        const cssSheet = sheet as CSSStyleSheet;
        for (const rule of Array.from(cssSheet.cssRules)) {
          if (rule.type !== CSSRule.FONT_FACE_RULE) continue;
          const cssText = rule.cssText.replace(/url\((['"]?)(.*?)\1\)/g, (_match, _quote, sourceUrl) => {
            const absoluteUrl = sourceUrl.startsWith("data:") || sourceUrl.startsWith("blob:")
              ? sourceUrl
              : new URL(sourceUrl, cssSheet.href || document.baseURI).href;
            return 'url("' + absoluteUrl + '")';
          });
          fontFaceRules.push(cssText);
        }
      } catch {
        // Ignore cross-origin stylesheets; same-origin app fonts are copied below.
      }
    }
    if (fontDataUrl) fontFaceRules.push('@font-face{font-family:"AIPhoneDiaryEntryUserFont";src:url("' + fontDataUrl + '");font-display:block}');
    const fontFace = fontFaceRules.length ? "<style>" + fontFaceRules.join("\n") + "</style>" : "";
    const serialized = fontFace + wrapper.innerHTML;
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xhtml="http://www.w3.org/1999/xhtml" width="' + pixelWidth + '" height="' + pixelHeight + '" viewBox="0 0 ' + width + ' ' + height + '"><foreignObject x="0" y="0" width="' + width + '" height="' + height + '"><div xmlns="http://www.w3.org/1999/xhtml" style="width:' + width + 'px;height:' + height + 'px;overflow:visible">' + serialized + '</div></foreignObject></svg>';
    const svgBlob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
    const objectUrl = URL.createObjectURL(svgBlob);
    try {
      const image = new Image();
      image.decoding = "async";
      image.src = objectUrl;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("当前浏览器无法生成图片。");
      context.scale(ratio, ratio);
      context.drawImage(image, 0, 0, width, height);
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(value => value ? resolve(value) : reject(new Error("图片生成失败。")), "image/png");
      });
      await downloadFile(blob, safeFileName(entry.dateLabel || entry.createdAt.slice(0, 10)) + "_" + safeFileName(entry.title) + ".png");
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  } finally {
    wrapper.remove();
  }
}
