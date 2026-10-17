"use client";

/**
 * 小组件的自动生成：让角色隔段时间自己换一句留在桌面上。
 *
 * 与「角色用工具写」的关系：
 *   工具写入 = 角色在聊天中主动想到「我想在 TA 桌面留句话」；
 *   自动生成 = 角色没跟用户说话时，也偶尔在桌面换个状态。
 * 两者写的是同一份数据，后者只是多一个触发源。
 *
 * 默认关闭：这是角色**主动往用户桌面上放东西**，与「等它说话」不同，
 * 该由用户明确开启。
 */

import { simpleLLMCall } from "../api-helpers";
import { loadCharacters } from "../character-storage";
import { loadChatContacts, loadChatSessions, loadChatMessages } from "../chat-storage";
import { loadMemoryConfig } from "../memory-storage";
import { retrieveCoreMemoriesForPrompt, retrieveMemoriesForPrompt } from "../memory-service";
import { loadApiConfigs, resolveAuxiliaryApiConfig, resolveUserIdentity } from "../settings-storage";
import { appendCustomAppTimelineEntry, loadCustomAppTimelineEntries } from "../custom-app-storage";
import { loadWidgetAutoLastRun, loadWidgetConfig, loadWidgetData, markWidgetAutoRun, saveWidgetData } from "./storage";

/**
 * 小组件自己的时间线来源标识。
 *
 * 用来把「我在桌面留了句话」写进角色的短期记忆。
 */
const WIDGET_SOURCE = { id: "phone_widget", name: "桌面小组件" };
import { canGenerateAvatar, generateWidgetAvatar } from "./avatar";
import type { WidgetData } from "./types";

/** 自动生成的一句话最大长度：桌面上放不下长文。 */
const AUTO_TEXT_LIMIT = 60;

/**
 * 让角色生成一句适合放在桌面上的话。
 *
 * 提示词刻意约束得很短：这是桌面小组件，不是聊天——
 * 长了显示不下，也太「表演」。要的是一句像随手写下的状态。
 */
async function generateLine(
  character: ReturnType<typeof loadCharacters>[number],
  userName: string,
  previous: WidgetData | null,
): Promise<{ text: string; status: string } | null> {
  const config = resolveAuxiliaryApiConfig("memorySummaryApiConfigId") ?? loadApiConfigs()[0];
  if (!config) return null;

  // 角色卡是人格依据；最近聊天与角色记忆是当前状态依据。
  // 不再只把角色名字交给模型，否则模型只能用通用语气猜人设。
  const characterId = character.id;
  const contact = loadChatContacts().find(item => item.characterId === characterId);
  const sessions = loadChatSessions().filter(session =>
    !session.isGroup && session.contactId === contact?.id
  );
  const recentMessages = sessions
    .flatMap(session => loadChatMessages(session.id, 30).map(message => ({ session, message })))
    .filter(({ message }) =>
      (message.role === "user" || message.role === "assistant") &&
      !message.isRetracted &&
      typeof message.content === "string" &&
      message.content.trim()
    )
    .sort((a, b) => a.message.createdAt.localeCompare(b.message.createdAt))
    .slice(-20)
    .map(({ message }) => `${message.role === "user" ? userName : character.name}：${message.content.trim().slice(0, 700)}`)
    .join("\n");

  // 自定义应用时间线是小手机里记录近期事件/短期经历的一条数据源。
  const recentTimeline = loadCustomAppTimelineEntries(characterId)
    .slice(-15)
    .map(entry => `[${entry.createdAt.slice(0, 16)}] ${entry.appName}：${entry.summary}${entry.detail ? `（${entry.detail}` + "）" : ""}`)
    .join("\n")
    .slice(0, 4000);

  let memoryContext = "";
  try {
    const memoryConfig = loadMemoryConfig();
    const [coreMemories, longTermMemories] = await Promise.all([
      retrieveCoreMemoriesForPrompt(characterId, memoryConfig),
      retrieveMemoriesForPrompt(
        characterId,
        [character.name, character.persona, recentMessages].filter(Boolean).join("\n").slice(0, 5000),
        memoryConfig,
      ),
    ]);
    const entries = [
      ...coreMemories.map(entry => `[核心记忆] ${entry.content}`),
      ...longTermMemories.map(entry => `[长期记忆] ${entry.content}`),
    ];
    memoryContext = entries.join("\n").slice(0, 7000);
  } catch (error) {
    console.warn("[Widget] 读取角色记忆失败，继续使用角色卡和近期聊天", error);
  }

  const persona = [
    character.persona?.trim() ? `【角色人设】\n${character.persona.trim()}` : "",
    character.personality?.trim() ? `【性格补充】\n${character.personality.trim()}` : "",
    character.briefPersona?.trim() ? `【简量人设】\n${character.briefPersona.trim()}` : "",
    character.tags?.length ? `【角色标签】${character.tags.join("、")}` : "",
  ].filter(Boolean).join("\n\n");
  const avoid = previous?.text ? `\n【避免重复】你上次留在桌面上的话是：「${previous.text}」，这次请换一个自然的角度，不要换几个词后重复。` : "";

  const result = await simpleLLMCall(config, [
    {
      role: "system",
      content: [
        `你正在以角色「${character.name}」本人的身份，为${userName}手机桌面留下一句短短的日常状态。`,
        "【最高优先级：严格遵守角色卡】",
        persona || "角色卡暂时没有填写详细人设；不要擅自补充具体背景或关系设定。",
        "你必须保持角色原本的性格、价值观、身份、关系边界、说话习惯和情感表达方式。不要把所有角色都写成温柔、黏人、主动表达爱意的通用陪伴型 AI；角色没有表现出的情绪和经历，不要凭空编造。",
        "【近期聊天】以下内容只用于理解最近发生的事、双方正在聊什么以及角色当下的语气。请勿复述整段聊天，也不要把用户的话冒充成角色说过的话。",
        recentMessages || "没有读取到近期私聊记录。不要假装记得不存在的对话。",
        "【短期记忆/近期事件】这是小手机记录的近期事件时间线，用于补足聊天窗口之外发生的事；只在相关时参考，不要机械复述。",
        recentTimeline || "没有读取到近期事件时间线。",
        "【角色记忆】以下是已经保存的记忆，只在与当前状态有关时参考；如果与角色卡冲突，以角色卡为准。不要编造记忆中没有的共同经历。",
        memoryContext || "没有读取到可用的核心/长期记忆。",
        "【输出要求】",
        `1. 正文只写一句，不超过 ${AUTO_TEXT_LIMIT} 字，像这个角色自然留下的一瞬间状态；具体但不刻意煽情。`,
        "2. 不要强迫所有角色都向用户表达思念；可以写正在做的事、观察、心情或符合人设的简短念头。",
        "3. 不要像正式聊天消息，不强制称呼用户、不强制问句；保持角色自己的口吻。",
        "4. 不要添加人设中没有的重大事件、关系进展、地点或经历。",
        "5. 只输出严格 JSON，不要任何额外文字：{\\"text\\":\\"...\\",\\"status\\":\\"...\\"}",
        "status 是 2-5 字的简短状态标签，也必须符合角色当前情绪；不要默认使用「在想你」之类的亲密状态。",
      ].join("\n\n"),
    },
    { role: "user", content: `请结合你的人设、近期互动和已有记忆，留下一句自然、不重复的桌面状态。${avoid}` },
  ], { temperature: 0.8, max_tokens: 220, label: "widget-auto-generate" });

  const raw = (result.content ?? "").trim();
  if (!raw) return null;
  const cleaned = raw.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    const parsed = JSON.parse(cleaned) as { text?: unknown; status?: unknown };
    const text = String(parsed.text ?? "").trim().replace(/^["「]|["」]$/g, "").slice(0, AUTO_TEXT_LIMIT);
    if (!text) return null;
    return { text, status: String(parsed.status ?? "").trim().slice(0, 12) };
  } catch {
    const text = cleaned.replace(/\s+/g, " ").slice(0, AUTO_TEXT_LIMIT);
    return text ? { text, status: "" } : null;
  }
}

/**
 * 跑一次自动生成（如果到了间隔）。
 *
 * @returns 是否真的换了内容
 */
export async function runWidgetAutoGenerate(): Promise<boolean> {
  const config = loadWidgetConfig();
  if (!config.enabled || !config.autoEnabled) return false;
  if (!config.characterId) return false;

  const intervalMs = Math.max(1, config.autoIntervalHours) * 3600_000;
  const last = loadWidgetAutoLastRun();
  if (last > 0 && Date.now() - last < intervalMs) return false;

  const character = loadCharacters().find(item => item.id === config.characterId);
  if (!character) return false;

  const userName = resolveUserIdentity(config.characterId)?.name || "用户";
  try {
    const line = await generateLine(character, userName, loadWidgetData());
    if (!line) return false;
    // 先记号，再写数据：生成可能要十几秒，期间不能被重复触发
    markWidgetAutoRun();

    // 配了生图且用户开了开关时，顺手换一张配当前状态的头像。
    // 失败/没配都静默沿用旧头像——头像只是锦上添花，
    // 绝不能因为它让「换一句话」这件事整体失败。
    // 头像优先级：已生成/上次留下的 > 角色卡头像。
    // 以前只带上一轮的 avatar，没开「状态头像」时永远是空 → 桌面只剩首字，
    // 与角色卡里设的头像完全脱节（用户实报）。
    let avatar = loadWidgetData()?.avatar || (character.avatar ?? "");
    if (config.useGeneratedAvatar && canGenerateAvatar()) {
      const generated = await generateWidgetAvatar(character, line.status, line.text);
      if (generated) avatar = generated;
    }

    saveWidgetData({
      characterId: character.id,
      text: line.text,
      status: line.status,
      avatar,
      updatedAt: new Date().toISOString(),
      source: "auto",
    });

    // 同步进角色的短期记忆（时间线）：这件事花的是**同一次**生成，只是多记一笔。
    //
    // 为什么必须记：这句话是角色自己写的，它下次聊天时该记得。不记的话，
    // 用户说「你昨天在桌面写的那句」，角色会一脸茫然——而那句话明明是它写的（实测反馈）。
    // 写完不触发任何回复：时间线只是上下文，什么时候开口由对话本身决定。
    try {
      appendCustomAppTimelineEntry(WIDGET_SOURCE, {
        characterId: character.id,
        summary: `我在 TA 手机桌面留了一句：${line.text}`,
        detail: line.status ? `当时的状态标签：${line.status}` : undefined,
      });
    } catch {
      // 记时间线失败不该影响留话本身——话已经写进桌面了
    }
    return true;
  } catch (err) {
    console.warn("[Widget] 自动生成失败", err);
    return false;
  }
}

