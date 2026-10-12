import { loadVirtualLifeState } from "./life-storage";

/**
 * Shared fact bridge: only confirmed life-scene facts involving this character
 * are surfaced in their normal chat context. Guesses and interpretations are
 * deliberately excluded so the character cannot acquire fabricated memories.
 */
export function buildLifeMemoryContext(characterId: string, limit = 10): string {
  const state = loadVirtualLifeState();
  const facts = state.memories
    .filter(memory => memory.participants.includes(characterId) && memory.fact.trim())
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
    .slice(0, Math.max(0, Math.min(limit, 30)))
    .reverse();
  if (!facts.length) return "";
  return [
    "【虚拟生活共同记忆｜已发生事实】",
    "以下是角色本人参与过的生活场景事件摘要。它们是已记录事实，不是猜测；不要擅自扩写成未发生的细节。",
    ...facts.map(fact => `- ${new Date(fact.occurredAt).toLocaleString("zh-CN")}：${fact.fact}`),
  ].join("\n");
}
