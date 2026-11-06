import { prepareShortTermContext } from "@/lib/short-term-assembler";

export function buildLifeShortTermMemoryPrompt(characterId: string): string {
  const context = prepareShortTermContext(characterId, "life", {
    includeDirectChatEntries: true,
  });
  const events = context.unifiedRecentItems
    .filter(item => item.kind === "event" && item.sourceApp !== "life" && item.sourceApp !== "chat")
    .map(item => {
      if (item.kind !== "event") return "";
      const date = new Date(item.timestamp);
      const stamp = Number.isFinite(date.getTime())
        ? date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
        : "时间未记录";
      return "- [" + stamp + "｜来源：" + item.sourceApp + "] " + item.text;
    })
    .filter(Boolean);
  if (events.length === 0) return "【全局短期记忆】暂无其他应用的近期事件。";
  return "【全局短期记忆｜跨应用近期事件】\\n" + events.join("\\n");
}
