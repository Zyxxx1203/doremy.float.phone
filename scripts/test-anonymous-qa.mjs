#!/usr/bin/env node
/* Anonymous Q&A contract: public visibility, recipient-only chat notification, timeline memory and moderation. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(ROOT, "lib/anonymous-qa.ts"), "utf8");
const chatEngineSource = fs.readFileSync(path.join(ROOT, "lib/chat-engine.ts"), "utf8");
const shortTermAssemblerSource = fs.readFileSync(path.join(ROOT, "lib/short-term-assembler.ts"), "utf8");
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText;
const store = new Map();
const kv = { kvGet: key => store.has(key) ? store.get(key) : null, kvSet: (key, value) => store.set(key, value), registerKvMigration: () => {} };
const characters = [{ id: "c1", name: "小林" }, { id: "c2", name: "顾总" }];
const chatMessages = [];
const chatStorage = {
  createOrGetSession: characterId => ({ id: "session-" + characterId }),
  pushChatMessage: message => { chatMessages.push(message); return message; },
};
const module = { exports: {} };
const require = id => id === "@/lib/kv-db" ? kv
  : id === "@/lib/character-storage" ? { loadCharacters: () => characters }
  : id === "@/lib/chat-storage" ? chatStorage
  : (() => { throw new Error("unexpected require: " + id); })();
const windowMock = { dispatchEvent: () => true };
const CustomEventMock = class CustomEvent { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } };
new Function("require", "module", "exports", "window", "document", "CustomEvent", js)(require, module, module.exports, windowMock, {}, CustomEventMock);
const qa = module.exports;
let pass = 0, fail = 0;
function T(name, ok) { if (ok) { pass++; console.log("  ✅ " + name); } else { fail++; console.log("  ❌ " + name); } }

const userLetter = qa.askAnonymousQuestion({ askerType: "user", askerId: "user", targetType: "character", targetId: "c1", question: "你最近是不是在躲我？", audience: "target" });
const targetNotice = chatMessages.find(message => message.sessionId === "session-c1" && message.content.includes(userLetter.question));
T("旧 audience 参数不会改变公开可见属性", userLetter.audience === "public" && qa.loadPublicAnonymousQa().some(q => q.id === userLetter.id));
T("指定角色收到系统条目", targetNotice?.sessionId === "session-c1" && targetNotice.role === "system" && targetNotice.mediaType === "system_instruction");
T("系统条目进入自然短期时间线并保留来源标记", targetNotice?.mediaData?.shortTermMemoryEvent === true && targetNotice.mediaData.compactSystemInstruction === true && targetNotice.mediaData.shortTermMemorySource === "anonymous_qa");
T("匿名提问事件以独立来源进入短期时间线且不受普通聊天来源开关影响", shortTermAssemblerSource.includes('sourceDetail: msg.mediaData?.shortTermMemorySource === "anonymous_qa" ? "anonymous_qa"') && shortTermAssemblerSource.includes('tag: "recent_anonymous_qa"') && shortTermAssemblerSource.includes('if (entry.sourceDetail === "anonymous_qa") return true;'));
T("聊天提示词不再聚合注入匿名提问箱上下文", !chatEngineSource.includes("buildAnonymousQaContext") && !chatEngineSource.includes("anonymousQaShortTerm"));
T("通知包含问题编号和内容，角色可以调用回答工具", targetNotice?.content.includes(userLetter.id) && targetNotice.content.includes(userLetter.question) && targetNotice.content.includes("回答匿名提问"));
const bystanderNotice = chatMessages.find(message => message.sessionId === "session-c2" && message.content.includes(userLetter.question));
T("其他角色知道公开问题，但不会误以为是问自己的", bystanderNotice?.content.includes("指定回答对象是小林") && !bystanderNotice.content.includes("这是问你的问题"));
T("通知不泄露提问者真实 ID", !targetNotice?.content.includes(userLetter.askerId));
T("随机匿名代号独立生成", userLetter.askerAlias && userLetter.askerAlias !== qa.askAnonymousQuestion({ askerType: "user", askerId: "user", targetType: "character", targetId: "c1", question: "另一个问题" }).askerAlias);
T("非指定对象不能代答", qa.answerAnonymousQuestion(userLetter.id, "越权回答", { targetType: "character", targetId: "c2" }) === null);
T("指定收件人可以回答", qa.answerAnonymousQuestion(userLetter.id, "没有躲你，只是在忙", { targetType: "character", targetId: "c1" })?.status === "answered");
const answerNotice = chatMessages.find(message => message.sessionId === "session-c1" && message.content.includes("没有躲你，只是在忙"));
T("回答作为另一条独立时间线事件写入", Boolean(answerNotice && answerNotice.id !== targetNotice?.id && answerNotice.content.includes("匿名提问箱有一条新回答") && answerNotice.mediaData?.shortTermMemorySource === "anonymous_qa"));
T("可以编辑问题、回答与回答对象", (() => { const changed = qa.updateAnonymousQuestion(userLetter.id, { question: "修改后的问题", answer: "修改后的回答", targetType: "character", targetId: "c2" }); return changed?.question === "修改后的问题" && changed.answer === "修改后的回答" && changed.targetId === "c2" && changed.status === "answered"; })());
T("变更回答对象会通知新收件角色", chatMessages.some(message => message.sessionId === "session-c2" && message.content.includes("修改后的问题")));
T("变更回答对象会通知旧收件角色忽略旧通知", chatMessages.some(message => message.sessionId === "session-c1" && message.content.includes("已失效")));
T("清空回答会恢复待回答状态", (() => { const changed = qa.updateAnonymousQuestion(userLetter.id, { answer: "" }); return changed?.status === "pending" && !changed.answer; })());
T("可以删除匿名问题", qa.deleteAnonymousQuestion(userLetter.id) && !qa.loadAnonymousQa().some(q => q.id === userLetter.id));

const roleLetter = qa.askAnonymousQuestion({ askerType: "character", askerId: "c1", targetType: "character", targetId: "c2", question: "你是不是也在意她？" });
T("角色提问时收件角色收到系统条目", chatMessages.some(message => message.sessionId === "session-c2" && message.content.includes(roleLetter.question)));
T("角色名称可以兜底解析为唯一角色 ID", qa.askAnonymousQuestion({ askerType: "character", askerId: "c1", targetType: "character", targetId: "顾总", question: "名称解析测试" }).targetId === "c2");
T("不存在的角色不能作为收件人", (() => { try { qa.askAnonymousQuestion({ askerType: "character", askerId: "c1", targetType: "character", targetId: "missing-role", question: "无效收件人" }); return false; } catch { return true; } })());
T("角色不能向自己提问", (() => { try { qa.askAnonymousQuestion({ askerType: "character", askerId: "c1", targetType: "character", targetId: "c1", question: "问自己" }); return false; } catch { return true; } })());
T("角色可以向用户匿名提问", qa.askAnonymousQuestion({ askerType: "character", askerId: "c2", targetType: "user", targetId: "user", question: "今晚想吃什么？" }).targetType === "user");
T("不再提供常驻匿名提问箱上下文构建器", typeof qa.buildAnonymousQaContext === "undefined");
store.set("ai_phone_anonymous_qa_v1", JSON.stringify(Array.from({ length: 501 }, (_, index) => ({
  id: "legacy-" + index, askerType: "user", askerId: "user", askerAlias: "匿名", targetType: "user", targetId: "user",
  question: "历史问题 " + index, audience: "public", status: "pending", revealIdentity: false, createdAt: index,
}))));
qa.askAnonymousQuestion({ askerType: "user", askerId: "user", targetType: "user", targetId: "user", question: "第 502 条问题" });
T("历史记录不再被固定 500 条上限截断", qa.loadAnonymousQa().length === 502);

console.log("\\n" + (fail === 0 ? "✅" : "❌") + " Anonymous Q&A timeline and management contract: " + pass + " passed / " + fail + " failed");
process.exit(fail === 0 ? 0 : 1);
