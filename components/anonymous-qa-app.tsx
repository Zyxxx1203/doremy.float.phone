"use client";

import { useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { PageShell } from "@/components/ui/page-shell";
import { loadCharacters } from "@/lib/character-storage";
import {
    answerAnonymousQuestion, askAnonymousQuestion, loadAnonymousQa,
    questionsForTarget, type AnonymousQaQuestion,
} from "@/lib/anonymous-qa";
import { requestAnonymousQuestionFromCharacter } from "@/lib/anonymous-qa-proactive";
import { generateAnonymousQaBatch } from "@/lib/anonymous-qa-generator";

type Tab = "public" | "ask" | "mine";
function notify(message: string, kind: "success" | "error" | "info" = "success") {
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("app-global-notice", { detail: { kind, message } }));
}

export function AnonymousQaApp({ onClose }: { onClose: () => void }) {
    const [tab, setTab] = useState<Tab>("public");
    const [characters, setCharacters] = useState(() => loadCharacters());
    const [questions, setQuestions] = useState<AnonymousQaQuestion[]>(() => loadAnonymousQa());
    const [targetId, setTargetId] = useState(characters[0]?.id || "");
    const [text, setText] = useState("");
    const [publicQuestion, setPublicQuestion] = useState(true);
    const [message, setMessage] = useState("");
    const [answers, setAnswers] = useState<Record<string, string>>({});
    const [askerId, setAskerId] = useState(characters[0]?.id || "");
    const [askerTargetType, setAskerTargetType] = useState<"user" | "character">("user");
    const [askerTargetId, setAskerTargetId] = useState(characters[1]?.id || characters[0]?.id || "");
    const [askerBusy, setAskerBusy] = useState(false);
    const [generating, setGenerating] = useState(false);
    const refresh = () => {
        setCharacters(loadCharacters());
        setQuestions(loadAnonymousQa());
    };
    useEffect(() => {
        const handler = () => refresh();
        window.addEventListener("anonymous-qa-updated", handler);
        return () => window.removeEventListener("anonymous-qa-updated", handler);
    }, []);
    useEffect(() => {
        if (askerTargetType !== "character") return;
        if (askerTargetId === askerId || !characters.some(c => c.id === askerTargetId && c.id !== askerId)) {
            setAskerTargetId(characters.find(c => c.id !== askerId)?.id || "");
        }
    }, [askerId, askerTargetType, askerTargetId, characters]);
    const publicRows = useMemo(() => questions.filter(q => q.audience === "public"), [questions]);
    const myRows = useMemo(() => questions.filter(q => q.targetType === "user" && q.targetId === "user"), [questions]);
    const ask = () => {
        if (!targetId) { setMessage("先创建角色"); return; }
        if (!text.trim()) { setMessage("写一个问题"); return; }
        askAnonymousQuestion({ askerType: "user", askerId: "user", targetType: "character", targetId, question: text, audience: publicQuestion ? "public" : "target" });
        setText(""); setMessage("问题已投进提问箱"); notify("问题已投进提问箱");
        refresh();
    };
    const answer = (id: string) => {
        const value = answers[id] || "";
        if (!value.trim()) return;
        answerAnonymousQuestion(id, value);
        setAnswers(prev => ({ ...prev, [id]: "" }));
        refresh();
    };
    const askByCharacter = async () => {
        if (!askerId) { setMessage("先创建角色"); return; }
        if (askerTargetType === "character" && !askerTargetId) { setMessage("先选目标角色"); return; }
        setAskerBusy(true);
        const result = await requestAnonymousQuestionFromCharacter({
            askerId,
            targetType: askerTargetType,
            targetId: askerTargetType === "character" ? askerTargetId : "user",
        }).catch(() => ({ ok: false, skipped: "failed" }));
        setAskerBusy(false);
        if (result.ok) {
            setMessage("TA 去提问箱了，等这条问题出现。");
            notify("已让 TA 去匿名提问");
            window.setTimeout(refresh, 3000);
        } else {
            setMessage(result.skipped === "already_running" ? "TA 正在回消息，等这一轮结束再试。" : "没触发成功，检查角色和 API 配置。");
        }
    };
    const generateBatch = async () => {
        if (generating) return;
        if (!characters.length) { setMessage("先创建至少一个角色"); return; }
        setGenerating(true);
        setMessage("正在生成 5 条匿名问答…");
        try {
            const result = await generateAnonymousQaBatch(5);
            setMessage(`已生成 ${result.created} 条（${result.answered} 条已回答）`);
            notify(`已生成 ${result.created} 条匿名问答`);
            refresh();
        } catch (error) {
            const text = error instanceof Error ? error.message : "生成失败";
            setMessage(text);
            notify(text, "error");
        } finally {
            setGenerating(false);
        }
    };
    return (
        <PageShell
            title="匿名提问箱"
            onBack={onClose}
            rightAction={(
                <button
                    type="button"
                    aria-label="刷新生成 5 条匿名问答"
                    title="刷新生成 5 条匿名问答"
                    disabled={generating}
                    onClick={generateBatch}
                    className="grid h-9 w-9 place-items-center rounded-full bg-[var(--c-input)] text-[var(--c-text)] disabled:opacity-50"
                >
                    <RefreshCw size={17} className={generating ? "animate-spin" : ""} />
                </button>
            )}
        >
            <div className="flex gap-2 overflow-x-auto pb-3">
                {([["public", "公共问答"], ["ask", "去提问"], ["mine", "给我的提问"]] as Array<[Tab, string]>).map(([id, label]) => (
                    <button key={id} onClick={() => setTab(id)} className={`shrink-0 rounded-full px-4 py-2 text-sm ${tab === id ? "bg-[var(--c-primary)] text-white" : "bg-[var(--c-input)] text-[var(--c-text)]"}`}>{label}</button>
                ))}
            </div>
            {message && <div className="mb-2 rounded-xl bg-[var(--c-input)] px-3 py-2 text-xs text-[var(--c-icon)]">{message}</div>}

            {tab === "ask" && (
                <div className="rounded-2xl bg-[var(--c-card)] p-4">
                    <div className="text-sm font-medium text-[var(--c-text)]">匿名问一个问题</div>
                    <div className="mt-1 text-[11px] text-[var(--c-icon)]">对方只会看到随机 alias，不会看到你的名字；公开问答会进共同记忆。</div>
                    <select value={targetId} onChange={e => setTargetId(e.target.value)} className="ui-select mt-3 w-full">{characters.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
                    <textarea value={text} onChange={e => setText(e.target.value)} rows={4} placeholder="想问什么？" className="ui-input mt-2 w-full resize-none" />
                    <label className="mt-2 flex items-center gap-2 text-xs text-[var(--c-icon)]"><input type="checkbox" checked={publicQuestion} onChange={e => setPublicQuestion(e.target.checked)} />公开到提问箱（所有角色可见）</label>
                    <button onClick={ask} className="ui-btn ui-btn-primary mt-3 w-full">匿名投递</button>
                </div>
            )}

            {tab === "ask" && characters.length > 0 && (
                <div className="mt-3 rounded-2xl bg-[var(--c-card)] p-4">
                    <div className="text-sm font-medium text-[var(--c-text)]">让 TA 主动提问</div>
                    <div className="mt-1 text-[11px] text-[var(--c-icon)]">点一下会触发这个角色在后台生成一次匿名提问；提问者只显示随机 alias。</div>
                    <div className="mt-3 flex gap-2">
                        <select value={askerId} onChange={e => setAskerId(e.target.value)} className="ui-select flex-1">
                            {characters.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </select>
                        <select value={askerTargetType} onChange={e => setAskerTargetType(e.target.value === "character" ? "character" : "user")} className="ui-select w-28">
                            <option value="user">问我</option>
                            <option value="character">问角色</option>
                        </select>
                    </div>
                    {askerTargetType === "character" && (
                        <select value={askerTargetId} onChange={e => setAskerTargetId(e.target.value)} className="ui-select mt-2 w-full">
                            {characters.filter(c => c.id !== askerId).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </select>
                    )}
                    <button onClick={askByCharacter} disabled={askerBusy} className="ui-btn ui-btn-primary mt-3 w-full">
                        {askerBusy ? "正在让 TA 去提问…" : "让 TA 现在匿名提问"}
                    </button>
                </div>
            )}

            {tab === "public" && (
                <div className="flex flex-col gap-3">
                    {publicRows.map(q => {
                        const target = characters.find(c => c.id === q.targetId);
                        const targetLabel = q.targetType === "user" ? "你" : (target?.name || "角色");
                        return (
                            <div key={q.id} className="rounded-2xl bg-[var(--c-card)] p-4">
                                <div className="flex items-center justify-between gap-2 text-[11px] text-[var(--c-icon)]">
                                    <span>{q.askerAlias} 问 {targetLabel}</span>
                                    <span className={q.status === "answered" ? "text-emerald-600" : "text-amber-600"}>{q.status === "answered" ? "已回答" : "等待回答"}</span>
                                </div>
                                <div className="mt-2 text-sm text-[var(--c-text)]">{q.question}</div>
                                {q.answer ? <div className="mt-3 rounded-xl bg-[var(--c-input)] p-3 text-sm text-[var(--c-text)]"><span className="text-[11px] text-[var(--c-icon)]">{targetLabel}：</span>{q.answer}</div> : <div className="mt-2 text-[11px] text-[var(--c-icon)]">等待回答。</div>}
                            </div>
                        );
                    })}
                    {publicRows.length === 0 && <div className="rounded-2xl bg-[var(--c-card)] p-6 text-center text-sm text-[var(--c-icon)]">还没有公开问答</div>}
                </div>
            )}

            {tab === "mine" && (
                <div className="flex flex-col gap-3">
                    {myRows.map(q => {
                        const asker = characters.find(c => c.id === q.askerId);
                        return (
                            <div key={q.id} className="rounded-2xl bg-[var(--c-card)] p-4">
                                <div className="text-[11px] text-[var(--c-icon)]">{q.askerAlias} 问你{q.audience === "public" ? "（公开）" : "（仅你可见）"}</div>
                                <div className="mt-2 text-sm text-[var(--c-text)]">{q.question}</div>
                                {q.answer ? <div className="mt-2 text-sm text-[var(--c-icon)]">你的回答：{q.answer}</div> : (
                                    <div className="mt-2 flex gap-2"><input value={answers[q.id] || ""} onChange={e => setAnswers(prev => ({ ...prev, [q.id]: e.target.value }))} placeholder="回答..." className="ui-input flex-1" /><button onClick={() => answer(q.id)} className="ui-btn ui-btn-primary">回答</button></div>
                                )}
                                <div className="mt-1 text-[10px] text-[var(--c-icon)]">问的人：{q.revealIdentity ? (asker?.name || q.askerId) : "匿名"}</div>
                            </div>
                        );
                    })}
                    {myRows.length === 0 && <div className="rounded-2xl bg-[var(--c-card)] p-6 text-center text-sm text-[var(--c-icon)]">还没有角色向你提问</div>}
                </div>
            )}
        </PageShell>
    );
}
