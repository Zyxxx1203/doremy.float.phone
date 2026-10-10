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
import { loadApiConfigs, resolveAuxiliaryApiConfig, resolveUserIdentity } from "../settings-storage";
import { loadWidgetAutoLastRun, loadWidgetConfig, loadWidgetData, markWidgetAutoRun, saveWidgetData } from "./storage";
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
  characterName: string,
  userName: string,
  previous: WidgetData | null,
): Promise<{ text: string; status: string } | null> {
  const config = resolveAuxiliaryApiConfig("memorySummaryApiConfigId") ?? loadApiConfigs()[0];
  if (!config) return null;

  const avoid = previous?.text ? `\n（不要重复你上次写的那句：「${previous.text}」）` : "";
  const result = await simpleLLMCall(config, [
    {
      role: "system",
      content: [
        `你是「${characterName}」，正在${userName}手机桌面的一块小地方留一句话。`,
        "这句话会被 TA 在桌面上直接看到，是你不经意留下的状态。",
        "要求：",
        `1. 正文一句话，不超过 ${AUTO_TEXT_LIMIT} 字，口语、具体、有生活感；`,
        "2. 不要像在发消息，不要称呼对方，不要问句——就是要像随手记下的一句；",
        "3. 不要用引号包住整句，不要写「我说：」这类前缀。",
        "只输出严格 JSON，不要任何额外文字：{\"text\":\"...\",\"status\":\"...\"}",
        "status 是一个 2-5 字的当前状态，如「在想你」「刚睡醒」「有点困」。",
      ].join("\n"),
    },
    { role: "user", content: `现在给 TA 留一句。${avoid}` },
  ], { temperature: 0.9 });

  const raw = (result.content ?? "").trim();
  if (!raw) return null;
  // 模型可能包了 ```json 围栏，剥掉再解析
  const cleaned = raw.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    const parsed = JSON.parse(cleaned) as { text?: unknown; status?: unknown };
    const text = String(parsed.text ?? "").trim().replace(/^["「]|["」]$/g, "").slice(0, AUTO_TEXT_LIMIT);
    if (!text) return null;
    return { text, status: String(parsed.status ?? "").trim().slice(0, 12) };
  } catch {
    // 解析失败：把整段当成正文兜底（总比什么都不留好），但限长
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
    const line = await generateLine(character.name, userName, loadWidgetData());
    if (!line) return false;
    // 先记号，再写数据：生成可能要十几秒，期间不能被重复触发
    markWidgetAutoRun();

    // 配了生图且用户开了开关时，顺手换一张配当前状态的头像。
    // 失败/没配都静默沿用旧头像——头像只是锦上添花，
    // 绝不能因为它让「换一句话」这件事整体失败。
    let avatar = loadWidgetData()?.avatar ?? "";
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
    return true;
  } catch (err) {
    console.warn("[Widget] 自动生成失败", err);
    return false;
  }
}

