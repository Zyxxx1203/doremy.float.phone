"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowUpRight, Check, ChevronRight, Inbox, Send, Shield, Sparkles } from "lucide-react";
import { PageShell } from "@/components/ui/page-shell";
import { loadCharacters } from "@/lib/character-storage";
import {
  answerAnonymousQuestion, askAnonymousQuestion, loadAnonymousQa,
  type AnonymousQaQuestion,
} from "@/lib/anonymous-qa";
import { requestAnonymousQuestionFromCharacter } from "@/lib/anonymous-qa-proactive";

type Tab = "inbox" | "compose" | "sent";
function notify(message: string, kind: "success" | "error" | "info" = "success") {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("app-global-notice", { detail: { kind, message } }));
}
function stamp(value: number) {
  return new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function AnonymousQaApp({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("inbox");
  const [characters, setCharacters] = useState(() => loadCharacters());
  const [questions, setQuestions] = useState<AnonymousQaQuestion[]>(() => loadAnonymousQa());
  const [targetId, setTargetId] = useState(characters[0]?.id || "");
  const [text, setText] = useState("");
  const [expandedId, setExpandedId] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [askerId, setAskerId] = useState(characters[0]?.id || "");
  const [askerTargetType, setAskerTargetType] = useState<"user" | "character">("user");
  const [askerTargetId, setAskerTargetId] = useState(characters.find(c => c.id !== characters[0]?.id)?.id || "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const refresh = () => { setCharacters(loadCharacters()); setQuestions(loadAnonymousQa()); };
  useEffect(() => {
    const handler = () => refresh();
    window.addEventListener("anonymous-qa-updated", handler);
    window.addEventListener("characters-updated", handler);
    return () => { window.removeEventListener("anonymous-qa-updated", handler); window.removeEventListener("characters-updated", handler); };
  }, []);
  useEffect(() => {
    if (askerTargetType === "character" && (!askerTargetId || askerTargetId === askerId || !characters.some(c => c.id === askerTargetId))) {
      setAskerTargetId(characters.find(c => c.id !== askerId)?.id || "");
    }
  }, [askerId, askerTargetType, askerTargetId, characters]);

  // Only questions addressed to the user belong in this inbox. Character-to-character
  // letters remain private to their intended recipient and never become a public feed.
  const inbox = useMemo(() => questions.filter(q => q.targetType === "user" && q.targetId === "user"), [questions]);
  const sent = useMemo(() => questions.filter(q => q.askerType === "user" && q.askerId === "user"), [questions]);
  const pending = inbox.filter(q => q.status === "pending").length;
  const ask = () => {
    if (!targetId || !characters.some(c => c.id === targetId)) { setMessage("请先选择一位明确的收件角色。"); return; }
    if (!text.trim()) { setMessage("信还没有写内容。"); return; }
    askAnonymousQuestion({ askerType: "user", askerId: "user", targetType: "character", targetId, question: text, audience: "target", revealIdentity: false });
    setText(""); setMessage("信件已匿名投递。"); notify("匿名信件已投递"); setTab("sent"); refresh();
  };
  const answer = (id: string) => {
    const value = (answers[id] || "").trim();
    if (!value) return;
    answerAnonymousQuestion(id, value);
    setAnswers(prev => ({ ...prev, [id]: "" })); setExpandedId(""); refresh(); notify("回答已寄回");
  };
  const askByCharacter = async () => {
    if (!askerId) { setMessage("请先选择提问角色。"); return; }
    if (askerTargetType === "character" && (!askerTargetId || askerTargetId === askerId)) { setMessage("提问者和收件者必须是不同角色。"); return; }
    setBusy(true); setMessage("");
    const result = await requestAnonymousQuestionFromCharacter({ askerId, targetType: askerTargetType, targetId: askerTargetType === "character" ? askerTargetId : "user" }).catch(() => ({ ok: false, skipped: "failed" }));
    setBusy(false);
    if (result.ok) { setMessage("已把匿名提问的机会交给 TA。"); notify("已触发匿名提问"); window.setTimeout(refresh, 2500); }
    else setMessage(result.skipped === "already_running" ? "TA 正在处理另一件事，稍后再试。" : "没有触发成功，请检查角色和模型配置。");
  };

  const rows = tab === "inbox" ? inbox : sent;
  return (
    <PageShell title="匿名提问箱" onBack={onClose}>
      <style>{`
        .aq-page{min-height:100%;background:#f4f4f2;color:#171717;padding:18px 16px 104px;font-family:Georgia,"Noto Serif SC",serif}
        .aq-kicker{font:600 9px/1.4 ui-sans-serif,system-ui;letter-spacing:.28em;color:#777;text-transform:uppercase}
        .aq-title{font:500 27px/1.2 Georgia,"Noto Serif SC",serif;letter-spacing:.02em;color:#171717}
        .aq-paper{background:linear-gradient(145deg,#fff 0%,#f7f7f5 100%);border:1px solid #e3e3df;box-shadow:0 12px 32px rgba(0,0,0,.045)}
        .aq-tab{padding:10px 2px;border-bottom:1px solid transparent;color:#888;font:600 11px ui-sans-serif;letter-spacing:.08em}
        .aq-tab[aria-selected=true]{color:#171717;border-color:#171717}
        .aq-input{width:100%;background:#fff;border:1px solid #deded9;border-radius:2px;padding:13px;color:#171717;font:14px/1.65 "Noto Serif SC",Georgia,serif;outline:none}
        .aq-input:focus{border-color:#555;box-shadow:0 0 0 2px rgba(0,0,0,.04)}
        .aq-button{background:#171717;color:#fff;padding:13px 16px;border-radius:2px;font:600 11px ui-sans-serif;letter-spacing:.12em}
        .aq-button:disabled{opacity:.4}
        .aq-letter{border-bottom:1px solid #e8e8e4;padding:17px 2px}
        .aq-letter:last-child{border-bottom:0}
        .aq-dot{width:6px;height:6px;border-radius:50%;background:#171717;display:inline-block}
      `}</style>
      <div className="aq-page">
        <header className="mb-7">
          <div className="flex items-center justify-between mb-5">
            <span className="aq-kicker">PRIVATE CORRESPONDENCE · 01</span>
            <span className="flex items-center gap-1.5 text-[10px] tracking-[.12em] text-[#777]"><Shield size={12}/> ONLY ONE RECIPIENT</span>
          </div>
          <div className="flex items-end justify-between gap-3">
            <div><div className="aq-kicker mb-2">ANONYMOUS / 匿名提问箱</div><h1 className="aq-title">有些话，不必署名。</h1></div>
            <div className="text-right text-[10px] text-[#888] leading-5">{pending} 封待回复<br/>PRIVATE · 1 : 1</div>
          </div>
          <div className="mt-5 h-px bg-[#cfcfca]"/>
          <p className="mt-3 text-[11px] leading-5 text-[#777]">每封信只寄给一个明确的人。每次投递都会生成新的匿名称呼，不建立可追踪的匿名身份。</p>
        </header>

        <nav className="grid grid-cols-3 gap-5 mb-5 border-b border-[#deded9]" role="tablist">
          {([["inbox","收件箱"],["compose","写一封信"],["sent","已寄出的信"]] as Array<[Tab,string]>).map(([id,label]) =>
            <button key={id} type="button" role="tab" aria-selected={tab===id} className="aq-tab" onClick={()=>setTab(id)}>{label}</button>
          )}
        </nav>

        {message && <div className="mb-4 border-l-2 border-[#777] bg-white px-3 py-2 text-[11px] text-[#555]">{message}</div>}

        {tab === "compose" ? (
          <div className="aq-paper p-5">
            <div className="aq-kicker mb-2">A LETTER WITHOUT A NAME</div>
            <h2 className="text-[19px] text-[#222] mb-1">这封信，想寄给谁？</h2>
            <p className="text-[11px] text-[#888] leading-5 mb-5">先选定唯一收件人。对方只会看到本次随机生成的匿名称呼。</p>
            <label className="block aq-kicker mb-2">TO / 收件人</label>
            <select value={targetId} onChange={e=>setTargetId(e.target.value)} className="aq-input mb-4">
              {characters.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <label className="block aq-kicker mb-2">MESSAGE / 想说的话</label>
            <textarea value={text} onChange={e=>setText(e.target.value)} rows={6} maxLength={500} placeholder="把那些不好意思当面问的话，写在这里……" className="aq-input resize-none"/>
            <div className="flex justify-between mt-2 mb-5 text-[10px] text-[#999]"><span>最多 500 字</span><span>{text.length}/500</span></div>
            <button type="button" onClick={ask} disabled={!characters.length || !text.trim()} className="aq-button w-full flex items-center justify-center gap-2"><Send size={14}/> 匿名投递 <ArrowUpRight size={14}/></button>
            <div className="mt-4 flex items-start gap-2 text-[10px] leading-5 text-[#999]"><Shield size={13} className="mt-0.5 shrink-0"/>匿名称呼只用于显示，不会作为固定身份复用；问题只进入所选角色的收件范围。</div>
            {characters.length>0 && <div className="mt-7 border-t border-[#e4e4df] pt-5">
              <div className="aq-kicker mb-2">LET THEM WRITE FIRST</div>
              <div className="text-[15px] mb-3">也可以让角色主动寄出一封信</div>
              <div className="grid grid-cols-2 gap-2">
                <select value={askerId} onChange={e=>setAskerId(e.target.value)} className="aq-input">{characters.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select>
                <select value={askerTargetType} onChange={e=>setAskerTargetType(e.target.value as "user"|"character")} className="aq-input"><option value="user">寄给我</option><option value="character">寄给另一位角色</option></select>
              </div>
              {askerTargetType==="character" && <select value={askerTargetId} onChange={e=>setAskerTargetId(e.target.value)} className="aq-input mt-2">{characters.filter(c=>c.id!==askerId).map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select>}
              <button type="button" onClick={askByCharacter} disabled={busy || (askerTargetType==="character" && !characters.some(c=>c.id===askerTargetId && c.id!==askerId))} className="mt-3 w-full border border-[#bdbdb7] py-3 text-[11px] tracking-[.1em] text-[#333] disabled:opacity-40">{busy?"正在递出邀请…":"邀请 TA 匿名提问"}</button>
            </div>}
          </div>
        ) : (
          <div className="aq-paper px-5">
            <div className="flex items-center justify-between py-4 border-b border-[#e8e8e4]">
              <div><div className="aq-kicker">{tab==="inbox"?"INCOMING LETTERS":"OUTGOING LETTERS"}</div><div className="text-[17px] mt-1">{tab==="inbox"?"寄给你的信":"你寄出的信"}</div></div>
              <span className="text-[10px] text-[#999]">{rows.length.toString().padStart(2,"0")} LETTERS</span>
            </div>
            {rows.length===0 ? <div className="py-16 text-center"><div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-full border border-[#ddd] text-[#888]"><Inbox size={18}/></div><div className="text-[14px] text-[#555]">{tab==="inbox"?"暂时没有寄给你的信":"你还没有寄出过信件"}</div><div className="mt-2 text-[11px] text-[#999]">{tab==="inbox"?"有些问题，可能还在路上。":"想问的话，可以不必署名。"}</div></div> : rows.map(q=>{
              const target=characters.find(c=>c.id===q.targetId);
              const isOpen=expandedId===q.id;
              return <article key={q.id} className="aq-letter">
                <button type="button" onClick={()=>setExpandedId(isOpen?"":q.id)} className="w-full text-left">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2"><span className="aq-kicker">{q.askerAlias}</span>{q.status==="pending"&&tab==="inbox"&&<span className="aq-dot"/>}</div>
                    <span className="text-[10px] text-[#999]">{stamp(q.createdAt)}</span>
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-3"><span className="text-[14px] leading-6 text-[#292929] line-clamp-2">{q.question}</span><ChevronRight size={15} className={`shrink-0 text-[#aaa] transition-transform ${isOpen?"rotate-90":""}`}/></div>
                  <div className="mt-2 flex items-center justify-between text-[10px] text-[#999]"><span>{tab==="inbox"?"寄给你":"寄给 "+(target?.name||"角色")}</span><span>{q.status==="answered"?"已回复":"等待回复"}</span></div>
                </button>
                {isOpen && <div className="mt-4 border-t border-dashed border-[#d8d8d2] pt-4">
                  <p className="whitespace-pre-wrap text-[14px] leading-7 text-[#292929]">{q.question}</p>
                  {q.answer ? <div className="mt-4 bg-[#f0f0ed] p-4"><div className="aq-kicker mb-2">REPLY</div><p className="whitespace-pre-wrap text-[13px] leading-6 text-[#555]">{q.answer}</p></div> : tab==="inbox" ? <div className="mt-4"><textarea value={answers[q.id]||""} onChange={e=>setAnswers(p=>({...p,[q.id]:e.target.value}))} rows={3} placeholder="写下你的回答…" className="aq-input resize-none"/><button type="button" onClick={()=>answer(q.id)} disabled={!(answers[q.id]||"").trim()} className="aq-button mt-2 w-full flex items-center justify-center gap-2"><Check size={14}/> 寄回回答</button></div> : <div className="mt-3 text-[11px] text-[#999]">等待收件人回复。</div>}
                </div>}
              </article>;
            })}
          </div>
        )}
        <footer className="mt-6 flex items-center justify-center gap-2 text-[9px] tracking-[.2em] text-[#aaa]"><Sparkles size={10}/> NO NAME · NO CROWD · JUST TWO PEOPLE</footer>
      </div>
    </PageShell>
  );
}
