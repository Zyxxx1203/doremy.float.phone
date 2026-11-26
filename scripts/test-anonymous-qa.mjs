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

const userLetter=qa.askAnonymousQuestion({askerType:"user",askerId:"user",targetType:"character",targetId:"c1",question:"你最近是不是在躲我？"});
let c1=qa.buildAnonymousQaContext("c1"), c2=qa.buildAnonymousQaContext("c2");
T("新问题默认仅目标可见",userLetter.audience==="target" && c1.includes(userLetter.question) && !c2.includes(userLetter.question));
T("目标上下文不泄露发送者 ID",!c1.includes("askerId") && !c1.includes('"user"'));
T("每次投递随机生成独立匿名标识",userLetter.askerAlias && userLetter.askerAlias!==qa.askAnonymousQuestion({askerType:"user",askerId:"user",targetType:"character",targetId:"c1",question:"另一个问题"}).askerAlias);
T("非收件角色不能回答",qa.answerAnonymousQuestion(userLetter.id,"偷看回答",{targetType:"character",targetId:"c2"})===null);
const answer=qa.answerAnonymousQuestion(userLetter.id,"没有躲你，只是在忙",{targetType:"character",targetId:"c1"});
T("唯一收件人可以回答",answer?.status==="answered");
c1=qa.buildAnonymousQaContext("c1");
T("回答只回到原收件人的私密上下文",c1.includes("没有躲你") && !qa.buildAnonymousQaContext("c2").includes("没有躲你"));

const roleLetter=qa.askAnonymousQuestion({askerType:"character",askerId:"c1",targetType:"character",targetId:"c2",question:"你是不是也在意她？"});
T("角色 A 可向角色 B 一对一提问",qa.buildAnonymousQaContext("c2").includes(roleLetter.question) && !qa.buildAnonymousQaContext("c1").includes(roleLetter.question));
qa.answerAnonymousQuestion(roleLetter.id,"我当然在意",{targetType:"character",targetId:"c2"});
T("提问角色只能收到自己那封信的回答",qa.buildAnonymousQaContext("c1").includes("我当然在意"));
const userTarget=qa.askAnonymousQuestion({askerType:"character",askerId:"c2",targetType:"user",targetId:"user",question:"今晚想吃什么？"});
T("角色可以向用户匿名提问",userTarget.targetType==="user" && userTarget.askerAlias);

console.log(`\\n${fail===0?"✅":"❌"} Anonymous Q&A privacy contract: ${pass} passed / ${fail} failed`);
process.exit(fail===0?0:1);
