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
const windowMock = {dispatchEvent:()=>true};
const CustomEventMock = class CustomEvent { constructor(type,init={}){this.type=type;this.detail=init.detail;} };
new Function("require","module","exports","window","document","CustomEvent",js)(require,module,module.exports,windowMock,{},CustomEventMock);
const qa=module.exports;
let pass=0,fail=0;
function T(name,ok){if(ok){pass++;console.log("  ✅ "+name);}else{fail++;console.log("  ❌ "+name);}}

const userLetter=qa.askAnonymousQuestion({askerType:"user",askerId:"user",targetType:"character",targetId:"c1",question:"你最近是不是在躲我？",audience:"target"});
let c1=qa.buildAnonymousQaContext("c1"), c2=qa.buildAnonymousQaContext("c2");
T("即使旧调用传 target，新问题仍对所有角色公开",userLetter.audience==="public" && c1.includes(userLetter.question) && c2.includes(userLetter.question) && qa.loadPublicAnonymousQa().some(q=>q.id===userLetter.id));
T("所有角色共享问题上下文但不泄露发送者 ID",c2.includes(userLetter.question) && !c2.includes("askerId") && !c2.includes('"user"'));
T("每次投递随机生成独立匿名标识",userLetter.askerAlias && userLetter.askerAlias!==qa.askAnonymousQuestion({askerType:"user",askerId:"user",targetType:"character",targetId:"c1",question:"另一个问题"}).askerAlias);
T("非指定对象不能代答",qa.answerAnonymousQuestion(userLetter.id,"越权回答",{targetType:"character",targetId:"c2"})===null);
const answer=qa.answerAnonymousQuestion(userLetter.id,"没有躲你，只是在忙",{targetType:"character",targetId:"c1"});
T("唯一收件人可以回答",answer?.status==="answered");
c1=qa.buildAnonymousQaContext("c1");
T("回答对所有角色共享可见",c1.includes("没有躲你") && qa.buildAnonymousQaContext("c2").includes("没有躲你"));

const roleLetter=qa.askAnonymousQuestion({askerType:"character",askerId:"c1",targetType:"character",targetId:"c2",question:"你是不是也在意她？"});
T("角色名称可兜底解析为唯一角色 ID",qa.askAnonymousQuestion({askerType:"character",askerId:"c1",targetType:"character",targetId:"顾总",question:"名称解析测试"}).targetId==="c2");
T("不存在的角色不会创建无收件人 ID 的问题",(()=>{try{qa.askAnonymousQuestion({askerType:"character",askerId:"c1",targetType:"character",targetId:"missing-role",question:"无效收件人"});return false;}catch{return true;}})());
T("角色不能向自己提问",(()=>{try{qa.askAnonymousQuestion({askerType:"character",askerId:"c1",targetType:"character",targetId:"c1",question:"问自己"});return false;}catch{return true;}})());
T("角色 A 向角色 B 提问后所有角色可见",qa.buildAnonymousQaContext("c2").includes(roleLetter.question) && qa.buildAnonymousQaContext("c1").includes(roleLetter.question));
qa.answerAnonymousQuestion(roleLetter.id,"我当然在意",{targetType:"character",targetId:"c2"});
T("回答公开同步给所有角色",qa.buildAnonymousQaContext("c1").includes("我当然在意") && qa.buildAnonymousQaContext("c2").includes("我当然在意"));
const userTarget=qa.askAnonymousQuestion({askerType:"character",askerId:"c2",targetType:"user",targetId:"user",question:"今晚想吃什么？"});
T("角色可以向用户匿名提问",userTarget.targetType==="user" && userTarget.askerAlias);

console.log(`\\n${fail===0?"✅":"❌"} Anonymous Q&A privacy contract: ${pass} passed / ${fail} failed`);
process.exit(fail===0?0:1);
