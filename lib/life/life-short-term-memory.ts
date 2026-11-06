import { prepareShortTermContext } from "@/lib/short-term-assembler";

export function buildLifeShortTermMemoryPrompt(characterId: string): string {
  const context = prepareShortTermContext(characterId, "life", {
    includeDirectChatEntries: true,
  });
  const blocks = context.recentBlocks.filter(block =>
    block.content.trim()
    && block.tag !== "recent_life"
    && block.tag !== "recent_chat"
    && block.tag !== "recent_group_chat"
  );
  if (blocks.length === 0) return "【全局短期记忆】暂无其他应用的近期事件。";
  return [
    "【全局短期记忆｜跨应用近期事件】",
    ...blocks.map(block => "【" + block.tag + "】\n" + block.content),
  ].join("\n\n");
}
