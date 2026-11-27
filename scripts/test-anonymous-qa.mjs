#!/usr/bin/env node
/* Anonymous Q&A privacy contract: every letter belongs to exactly one recipient. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(ROOT, "lib/anonymous-qa.ts"), "utf8");
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText;
const store = new Map();
const kv = { kvGet: key => store.has(key) ? store.get(key) : null, kvSet: (key,value) => store.set(key,value), registerKvMigration: () => {} };
const characters = [{id:"c1",name:"小林"},{id:"c2",name:"顾总"}];
const module = {exports:{}};
const require = id => id === "@/lib/kv-db" ? kv : id === "@/lib/character-storage" ? {loadCharacters:()=>characters} : (()=>{throw new Error("unexpected require: "+id)})();
const chatMessages=[];
const chatStorage={
  createOrGetSession: characterId=>({id:"session-"+characterId}),
  pushChatMessage: message=>{chatMessages.push(message);return message;},
};
const require = id => id === "@/lib/kv-db" ? kv : id === "@/lib/character-storage" ? {loadCharacters:()=>characters} : id === "@/lib/chat-storage" ? chatStorage : (()=>{throw new Error("unexpected require: "+id)})();
const windowMock = {dispatchEvent:()=>true};
const CustomEventMock = class CustomEvent { constructor(type,init={}){this.type=type;this.detail=init.detail;} };
new Function("require","module","exports","window","document","CustomEvent",js)(require,module,module.exports,windowMock,{},CustomEventMock);
const qa=module.exports;
let pass=0,fail=0;
function T(name,ok){if(ok){pass++;console.log("  ✅ "+name);}else{fail++;console.log("  ❌ "+name);}}

const userLetter=qa.askAnonymousQuestion({askerType:"user",askerId:"user",targetType:"character",targetId:"c1",question:"你最近是不是在躲我？",audience:"target"});
T("旧 audience 参数不会改变所有人可见的公开属性",userLetter.audience==="public" && qa.loadPublicAnonymousQa().some(q=>q.id===userLetter.id));
T("指定角色收到一条带短期记忆标记的系统消息",chatMessages.some(m=>m.id==="anonymous_qa_"+userLetter.id && m.sessionId==="session-c1" && m.role==="system" && m.mediaType==="system_instruction" && m.mediaData?.shortTermMemoryEvent===true && m.content.includes(userLetter.question)));
T("通知只暴露匿名代号，不写入提问者真实 ID",!chatMessages.find(m=>m.id==="anonymous_qa_"+userLetter.id)?.content.includes(userLetter.askerId));
T("每次投递随机生成独立匿名标识",userLetter.askerAlias && userLetter.askerAlias!==qa.askAnonymousQuestion({askerType:"user",askerId:"user",targetType:"character",targetId:"c1",question:"另一个问题"}).askerAlias);
T("非指定对象不能代答",qa.answerAnonymousQuestion(userLetter.id,"越权回答",{targetType:"character",targetId:"c2"})===null);
const answer=qa.answerAnonymousQuestion(userLetter.id,"没有躲你，只是在忙",{targetType:"character",targetId:"c1"});
T("唯一收件人可以回答",answer?.status==="answered");
T("管理者可以编辑问题、回答与回答对象",(()=>{const changed=qa.updateAnonymousQuestion(userLetter.id,{question:"修改后的问题",answer:"修改后的回答",targetType:"character",targetId:"c2"});return changed?.question==="修改后的问题" && changed.answer==="修改后的回答" && changed.targetId==="c2" && changed.status==="answered";})());
T("可以把回答清空并恢复待回答状态",(()=>{const changed=qa.updateAnonymousQuestion(userLetter.id,{answer:""});return changed?.status==="pending" && !changed.answer;})());
T("可以删除匿名问题",qa.deleteAnonymousQuestion(userLetter.id) && !qa.loadAnonymousQa().some(q=>q.id===userLetter.id));
const roleLetter=qa.askAnonymousQuestion({askerType:"character",askerId:"c1",targetType:"character",targetId:"c2",question:"你是不是也在意她？"});
T("角色名称可兜底解析为唯一角色 ID",qa.askAnonymousQuestion({askerType:"character",askerId:"c1",targetType:"character",targetId:"顾总",question:"名称解析测试"}).targetId==="c2");
T("不存在的角色不会创建无收件人 ID 的问题",(()=>{try{qa.askAnonymousQuestion({askerType:"character",askerId:"c1",targetType:"character",targetId:"missing-role",question:"无效收件人"});return false;}catch{return true;}})());
T("角色不能向自己提问",(()=>{try{qa.askAnonymousQuestion({askerType:"character",askerId:"c1",targetType:"character",targetId:"c1",question:"问自己"});return false;}catch{return true;}})());
T("角色 A 向角色 B 提问后通知指定收件角色",chatMessages.some(m=>m.id==="anonymous_qa_"+roleLetter.id && m.sessionId==="session-c2" && m.content.includes(roleLetter.question)));
qa.answerAnonymousQuestion(roleLetter.id,"我当然在意",{targetType:"character",targetId:"c2"});
T("角色可以向用户匿名提问",qa.askAnonymousQuestion({askerType:"character",askerId:"c2",targetType:"user",targetId:"user",question:"今晚想吃什么？"}).targetType==="user");
T("匿名提问箱不再导出常驻上下文构建器",typeof qa.buildAnonymousQaContext==="undefined");

console.log(`\\n${fail===0?"✅":"❌"} Anonymous Q&A timeline and management contract: ${pass} passed / ${fail} failed`);
process.exit(fail===0?0:1);
\\n${fail===0?"✅":"❌"} Anonymous Q&A privacy contract: ${pass} passed / ${fail} failed`);
process.exit(fail===0?0:1);
