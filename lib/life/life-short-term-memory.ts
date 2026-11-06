import { prepareShortTermContext } from "@/lib/short-term-assembler";

/**
 * Life uses the same cross-app timeline assembler and source filters as online chat.
 * The only difference is the consumer app id ("life"), whose default count limit is
 * unlimited; the shared token budget remains the final safety boundary.
 */
export function buildLifeShortTermMemoryPrompt(characterId: string): string {
  const context = prepareShortTermContext(characterId, "life", {
    includeDirectChatEntries: true,
  });
  const items = context.unifiedRecentItems
    .filter(item => item.kind === "event")
    .map(item => {
      if (item.kind !== "event") return "";
      const date = new Date(item.timestamp);
      const stamp = Number.isFinite(date.getTime())
        ? date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
        : "时间未记录";
      return "- [" + stamp + "｜来源：" + item.sourceApp + "] " + item.text;
    })
    .filter(Boolean);
  return items.length
    ? "【统一短期记忆｜跨应用近期记录】\\n" + items.join("\\n")
    : "【统一短期记忆】暂无符合来源设置的近期记录。";
}
