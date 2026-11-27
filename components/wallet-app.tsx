"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { PageShell } from "@/components/ui/page-shell";
import { loadCharacters } from "@/lib/character-storage";
import { loadWalletState, formatWalletAmount, WALLET_UPDATED_EVENT, creditWalletBalance, payWithWalletBalance } from "@/lib/wallet-storage";
import { runDueWalletBills } from "@/lib/wallet-planning";
import { WalletPlanningTabs, type WalletPlanningTab } from "@/components/wallet-planning-tabs";
import { WalletPanel } from "@/components/chat/wallet-panel";
import { loadCharacterLedger } from "@/lib/economy/character-ledger";
import {
  createFamilyCard, loadFamilyCardTransactions, loadFamilyCards, spendWithFamilyCard,
  updateFamilyCard, FAMILY_CARD_UPDATED_EVENT, type FamilyCard,
} from "@/lib/economy/family-card";
import {
  createJointFund, depositToJointFund, loadJointFundPlans, loadJointFunds,
  loadJointFundTransactions, removeJointFundPlan, runDueJointFundPlans,
  setJointFundPlan, JOINT_FUND_UPDATED_EVENT, type JointFund,
} from "@/lib/economy/joint-fund";
import {
  CHARACTER_ECONOMY_UPDATED_EVENT, ensureCharacterEconomyProfileAsync,
  setCharacterInitialDeposit, updateCharacterIncomePlan,
  type CharacterEconomyProfile, type CharacterIncomeCadence,
} from "@/lib/economy/character-income";

type WalletTab = "home" | "accounts" | "family" | "joint" | "ledger" | WalletPlanningTab;
type Props = { onClose: () => void; initialTab?: WalletTab };

const TABS: Array<{ id: WalletTab; label: string }> = [
  { id: "home", label: "总览" },
  { id: "accounts", label: "银行卡" },
  { id: "family", label: "亲属卡" },
  { id: "joint", label: "小金库" },
  { id: "ledger", label: "角色账本" },
  { id: "budget", label: "预算" },
  { id: "goals", label: "储蓄目标" },
  { id: "bills", label: "周期账单" },
  { id: "calendar", label: "财务日历" },
  { id: "insights", label: "财务报告" },
];

function money(value: number): string { return formatWalletAmount(value); }
function notify(message: string, kind: "success" | "error" | "info" = "success") {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("app-global-notice", { detail: { kind, message } }));
}
function time(value: number | string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function WalletApp({ onClose, initialTab = "home" }: Props) {
  const [tab, setTab] = useState<WalletTab>(initialTab);
  const [wallet, setWallet] = useState(() => loadWalletState());
  const [characters, setCharacters] = useState(() => loadCharacters());
  const [familyCards, setFamilyCards] = useState<FamilyCard[]>(() => loadFamilyCards());
  const [jointFunds, setJointFunds] = useState<JointFund[]>(() => loadJointFunds());
  const [tick, setTick] = useState(0);
  const [quickEntry, setQuickEntry] = useState<"income" | "expense" | null>(null);
  const [quickAmount, setQuickAmount] = useState("");
  const [quickTitle, setQuickTitle] = useState("");
  const [quickCategory, setQuickCategory] = useState("其他");
  const refresh = useCallback(() => {
    setWallet(loadWalletState());
    setCharacters(loadCharacters());
    setFamilyCards(loadFamilyCards());
    setJointFunds(loadJointFunds());
    setTick(v => v + 1);
  }, []);

  useEffect(() => {
    runDueJointFundPlans();
    const due = runDueWalletBills();
    if (due.paid) notify(`已自动处理 ${due.paid} 笔周期账单`);
    if (due.overdue) notify(`${due.overdue} 笔周期账单扣款失败，请检查余额`, "error");
    refresh();
    const events = [WALLET_UPDATED_EVENT, FAMILY_CARD_UPDATED_EVENT, JOINT_FUND_UPDATED_EVENT, CHARACTER_ECONOMY_UPDATED_EVENT, "characters-updated"];
    for (const name of events) window.addEventListener(name, refresh);
    return () => { for (const name of events) window.removeEventListener(name, refresh); };
  }, [refresh]);

  const saveQuickEntry = () => {
    const amount = Number(quickAmount);
    if (!Number.isFinite(amount) || amount <= 0 || !quickTitle.trim()) { notify("请填写有效金额和用途。", "error"); return; }
    const result = quickEntry === "income"
      ? creditWalletBalance(amount, quickTitle.trim(), "钱包手动收入", quickCategory)
      : payWithWalletBalance({ amount, title: quickTitle.trim(), detail: "钱包手动支出", category: quickCategory });
    if (!result.ok) { notify(result.error || "记账失败", "error"); return; }
    notify(quickEntry === "income" ? "收入已记账" : "支出已记账");
    setQuickEntry(null); setQuickAmount(""); setQuickTitle(""); refresh();
  };

  const totalLedger = useMemo(
    () => { void tick; return characters.reduce((sum, c) => sum + (loadCharacterLedger(c.id)?.balance || 0), 0); },
    [characters, tick],
  );

  if (tab === "accounts") return <WalletPanel onBack={() => setTab("home")} />;

  return (
    <PageShell title="钱包" onBack={onClose} className="wallet-private-bank">
      <style>{`
        .wallet-private-bank{color:#292b25}
        .wallet-private-bank .wallet-hero{background:radial-gradient(circle at 88% 8%,rgba(224,202,148,.23),transparent 30%),linear-gradient(135deg,#252b25,#111712 64%,#34372d);color:#f5f0e4;border:1px solid rgba(193,171,119,.35);box-shadow:0 18px 38px rgba(28,31,25,.2)}
        .wallet-private-bank .wallet-section{background:linear-gradient(145deg,#fffefa,#eeece4);border:1px solid rgba(153,137,100,.18);box-shadow:0 12px 28px rgba(43,39,28,.045)}
        .wallet-private-bank .wallet-kicker{font:600 9px/1.4 ui-sans-serif,system-ui;letter-spacing:.22em;text-transform:uppercase;color:#968664}
        .wallet-private-bank .wallet-tab{border:1px solid rgba(143,128,91,.22);background:rgba(255,255,255,.52);color:#69685f}
        .wallet-private-bank .wallet-tab[aria-pressed=true]{background:#202820;color:#f6f0e2;border-color:#202820;box-shadow:0 5px 14px rgba(20,28,20,.16)}
        .wallet-private-bank .wallet-metal-line{height:1px;background:linear-gradient(90deg,rgba(171,148,96,.5),transparent)}
        .wallet-private-bank .wallet-tx{border-bottom:1px solid rgba(143,128,91,.14)}
      `}</style>
      <div className="wallet-private-bank flex gap-2 overflow-x-auto px-1 pb-3">
        {TABS.map(item => (
          <button key={item.id} onClick={() => setTab(item.id)} aria-pressed={tab === item.id} className={`wallet-tab shrink-0 rounded-full px-4 py-2 text-sm transition-colors ${tab === item.id ? "" : ""}`}>{item.label}</button>
        ))}
      </div>

      {tab === "home" && (
        <div className="wallet-private-bank flex flex-col gap-3">
          <div className="wallet-hero rounded-3xl p-5 shadow-sm">
            <div className="wallet-kicker" style={{color:"#c7b78e"}}>PRIVATE WALLET · AVAILABLE BALANCE</div><div className="mt-2 text-[10px] tracking-[.12em] opacity-65">我的可用余额</div>
            <div className="mt-1 text-3xl font-semibold" style={{color:"#f5f0e4",fontFamily:"Georgia,serif"}}>{money(wallet.balance)}</div>
            <div className="mt-3 flex gap-4 text-xs text-[var(--c-icon)]">
              <button type="button" onClick={() => setTab("accounts")} className="underline underline-offset-4">银行卡 {wallet.cards.length} 张 · 管理</button>
              <span>亲属卡 {familyCards.length} 张</span>
              <span>小金库 {jointFunds.length} 个</span>
            </div>
          </div>
          <div className="wallet-section rounded-2xl p-4">
            <div className="mb-3 flex items-center justify-between"><div><div className="wallet-kicker mb-1">QUICK ENTRY</div><div className="text-sm font-medium text-[var(--c-text)]">快速记账</div></div><div className="flex gap-2"><button type="button" onClick={() => setQuickEntry("income")} className="rounded-full bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-700">＋ 收入</button><button type="button" onClick={() => setQuickEntry("expense")} className="rounded-full bg-rose-50 px-3 py-1.5 text-xs font-medium text-rose-700">－ 支出</button></div></div>
            {quickEntry && <div className="grid grid-cols-2 gap-2">
              <input value={quickTitle} onChange={event => setQuickTitle(event.target.value)} placeholder="用途 / 来源" className="ui-input col-span-2" />
              <input value={quickAmount} onChange={event => setQuickAmount(event.target.value)} type="number" inputMode="decimal" min="0" step="0.01" placeholder="金额" className="ui-input" />
              <select value={quickCategory} onChange={event => setQuickCategory(event.target.value)} className="ui-select">{["其他","餐饮","交通","购物","居住","娱乐","医疗","订阅","学习","工资","退款"].map(value => <option key={value}>{value}</option>)}</select>
              <button type="button" onClick={() => { setQuickEntry(null); setQuickAmount(""); setQuickTitle(""); }} className="ui-btn ui-btn-ghost">取消</button>
              <button type="button" onClick={saveQuickEntry} className="ui-btn ui-btn-primary">确认记账</button>
            </div>}
          </div>
          <div className="wallet-section rounded-2xl p-4">
            <div className="wallet-kicker mb-1">CHARACTER ASSETS</div><div className="text-sm font-medium text-[var(--c-text)]">角色账本总余额</div>
            <div className="mt-1 text-xl font-semibold text-[var(--c-text)]">{money(totalLedger)}</div>
            <div className="mt-1 text-xs text-[var(--c-icon)]">每个角色的收入/支出在「角色账本」里查看</div>
          </div>
          <div className="wallet-section rounded-2xl p-4">
            <div className="mb-2 flex items-center justify-between"><span className="text-sm font-medium text-[var(--c-text)]">最近流水</span><span className="text-xs text-[var(--c-icon)]">共 {wallet.transactions.length} 条</span></div>
            <div className="flex flex-col gap-2">
              {wallet.transactions.slice(0, 6).map(tx => (
                <div key={tx.id} className="flex items-center justify-between text-sm">
                  <div className="min-w-0"><div className="truncate text-[var(--c-text)]">{tx.title}</div><div className="text-[11px] text-[var(--c-icon)]">{time(tx.createdAt)} · {tx.category}</div></div>
                  <span className={tx.amount < 0 ? "text-rose-500" : "text-emerald-600"}>{tx.amount < 0 ? "-" : "+"}{money(Math.abs(tx.amount))}</span>
                </div>
              ))}
              {wallet.transactions.length === 0 && <div className="text-xs text-[var(--c-icon)]">还没有流水</div>}
            </div>
          </div>
        </div>
      )}

      {tab === "family" && <FamilyTab characters={characters} cards={familyCards} onChange={refresh} />}
      {tab === "joint" && <JointTab characters={characters} funds={jointFunds} onChange={refresh} />}
      {tab === "ledger" && <LedgerTab characters={characters} />}
      {(["budget","goals","bills","calendar","insights"] as WalletPlanningTab[]).includes(tab as WalletPlanningTab) && <WalletPlanningTabs tab={tab as WalletPlanningTab} onChange={refresh} />}
    </PageShell>
  );
}

function FamilyTab({ characters, cards, onChange }: { characters: ReturnType<typeof loadCharacters>; cards: FamilyCard[]; onChange: () => void }) {
  const [characterId, setCharacterId] = useState(characters[0]?.id || "");
  const [issuer, setIssuer] = useState<"user" | "character">("user");
  const [label, setLabel] = useState("随便花卡");
  const [limit, setLimit] = useState("500");
  const [spendAmount, setSpendAmount] = useState("10");
  const [message, setMessage] = useState("");

  const create = () => {
    if (!characterId) { setMessage("先创建角色"); return; }
    const value = Number(limit);
    if (!Number.isFinite(value) || value <= 0) { setMessage("额度无效"); return; }
    createFamilyCard({
      issuerType: issuer, issuerId: issuer === "user" ? "user" : characterId,
      beneficiaryType: issuer === "user" ? "character" : "user",
      beneficiaryId: issuer === "user" ? characterId : "user",
      label, monthlyLimit: value,
    });
    setMessage("已创建亲属卡"); notify("已创建亲属卡");
    onChange();
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-2xl bg-[var(--c-card)] p-4">
        <div className="text-sm font-medium text-[var(--c-text)]">新建亲属卡</div>
        <div className="mt-2 flex gap-2">
          <select value={issuer} onChange={e => setIssuer(e.target.value as "user" | "character")} className="ui-select flex-1">
            <option value="user">我给角色开卡</option>
            <option value="character">角色给我开卡</option>
          </select>
          <select value={characterId} onChange={e => setCharacterId(e.target.value)} className="ui-select flex-1">
            {characters.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div className="mt-2 flex gap-2">
          <input value={label} onChange={e => setLabel(e.target.value)} placeholder="卡名" className="ui-input flex-1" />
          <input value={limit} onChange={e => setLimit(e.target.value)} inputMode="decimal" placeholder="月额度" className="ui-input w-28" />
        </div>
        <button onClick={create} className="ui-btn ui-btn-primary mt-2 w-full">创建</button>
        {message && <div className="mt-2 text-xs text-[var(--c-icon)]">{message}</div>}
      </div>

      {cards.map(card => {
        const character = characters.find(c => c.id === (card.issuerType === "character" ? card.issuerId : card.beneficiaryId));
        const txs = loadFamilyCardTransactions(card.id);
        return (
          <div key={card.id} className="rounded-2xl bg-[var(--c-card)] p-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-medium text-[var(--c-text)]">{card.label}</div>
                <div className="text-[11px] text-[var(--c-icon)]">{card.issuerType === "user" ? "我 → " + (character?.name || "角色") : (character?.name || "角色") + " → 我"} · 每月 {money(card.monthlyLimit)}</div>
              </div>
              <span className={`rounded-full px-2 py-1 text-[10px] ${card.status === "active" ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>{card.status === "active" ? "生效中" : "已暂停"}</span>
            </div>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-[var(--c-input)]"><div className="h-full rounded-full bg-[var(--c-primary)]" style={{ width: Math.min(100, card.usedThisPeriod / card.monthlyLimit * 100) + "%" }} /></div>
            <div className="mt-1 flex justify-between text-[11px] text-[var(--c-icon)]"><span>已用 {money(card.usedThisPeriod)}</span><span>剩余 {money(Math.max(0, card.monthlyLimit - card.usedThisPeriod))}</span></div>
            <div className="mt-3 flex gap-2">
              <input value={spendAmount} onChange={e => setSpendAmount(e.target.value)} inputMode="decimal" className="ui-input w-20" />
              <button onClick={() => { const r = spendWithFamilyCard(card.id, Number(spendAmount), "亲属卡消费", "钱包 App 测试消费"); if (!r.ok) notify(r.error || "操作失败", "error"); else notify("操作成功"); onChange(); }} className="ui-btn ui-btn-ghost flex-1">记一笔消费</button>
              <button onClick={() => { updateFamilyCard(card.id, { status: card.status === "active" ? "paused" : "active" }); onChange(); }} className="ui-btn ui-btn-ghost">{card.status === "active" ? "暂停" : "恢复"}</button>
            </div>
            {txs.slice(0, 3).map(tx => <div key={tx.id} className="mt-2 flex justify-between text-[11px] text-[var(--c-icon)]"><span>{time(tx.at)} · {tx.title}</span><span>{money(tx.amount)}</span></div>)}
          </div>
        );
      })}
    </div>
  );
}

function JointTab({ characters, funds, onChange }: { characters: ReturnType<typeof loadCharacters>; funds: JointFund[]; onChange: () => void }) {
  const [characterId, setCharacterId] = useState(characters[0]?.id || "");
  const [name, setName] = useState("旅行基金");
  const [goal, setGoal] = useState("5000");
  const [amount, setAmount] = useState("100");
  const [member, setMember] = useState<"user" | "character">("user");
  const [message, setMessage] = useState("");

  const create = () => {
    if (!characterId) { setMessage("先创建角色"); return; }
    const value = Number(goal);
    if (!Number.isFinite(value) || value <= 0) { setMessage("目标金额无效"); return; }
    createJointFund({ name, goalLabel: name, goalAmount: value, userId: "user", characterId });
    setMessage("已创建小金库"); notify("已创建小金库");
    onChange();
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-2xl bg-[var(--c-card)] p-4">
        <div className="text-sm font-medium text-[var(--c-text)]">新建共同小金库</div>
        <div className="mt-2 flex gap-2">
          <input value={name} onChange={e => setName(e.target.value)} placeholder="目标名" className="ui-input flex-1" />
          <input value={goal} onChange={e => setGoal(e.target.value)} inputMode="decimal" placeholder="目标金额" className="ui-input w-28" />
        </div>
        <div className="mt-2 flex gap-2">
          <select value={characterId} onChange={e => setCharacterId(e.target.value)} className="ui-select flex-1">{characters.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          <button onClick={create} className="ui-btn ui-btn-primary">创建</button>
        </div>
        {message && <div className="mt-2 text-xs text-[var(--c-icon)]">{message}</div>}
      </div>

      {funds.map(fund => {
        const character = characters.find(c => c.id === fund.characterId);
        const plans = loadJointFundPlans(fund.id);
        const txs = loadJointFundTransactions(fund.id);
        return (
          <div key={fund.id} className="rounded-2xl bg-[var(--c-card)] p-4">
            <div className="flex items-center justify-between">
              <div><div className="text-sm font-medium text-[var(--c-text)]">{fund.name}</div><div className="text-[11px] text-[var(--c-icon)]">和 {character?.name || "角色"} 一起 · 目标 {money(fund.goalAmount)}</div></div>
              <span className="text-sm font-semibold text-[var(--c-text)]">{money(fund.balance)}</span>
            </div>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-[var(--c-input)]"><div className="h-full rounded-full bg-[var(--c-primary)]" style={{ width: Math.min(100, fund.balance / fund.goalAmount * 100) + "%" }} /></div>
            <div className="mt-3 flex gap-2">
              <select value={member} onChange={e => setMember(e.target.value as "user" | "character")} className="ui-select w-24"><option value="user">我存</option><option value="character">TA 存</option></select>
              <input value={amount} onChange={e => setAmount(e.target.value)} inputMode="decimal" className="ui-input w-24" />
              <button onClick={() => { const r = depositToJointFund(fund.id, member, member === "user" ? "user" : fund.characterId, Number(amount), "手动存入"); if (!r.ok) notify(r.error || "操作失败", "error"); else notify("操作成功"); onChange(); }} className="ui-btn ui-btn-primary flex-1">存入</button>
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              <button onClick={() => { setJointFundPlan({ fundId: fund.id, memberType: "user", memberId: "user", cadence: "weekly", amount: Number(amount) || 50 }); onChange(); }} className="ui-btn ui-btn-ghost text-xs">每周自动存</button>
              {plans.map(plan => <button key={plan.id} onClick={() => { removeJointFundPlan(plan.id); onChange(); }} className="ui-btn ui-btn-ghost text-xs">{plan.memberType === "user" ? "我" : "TA"} {plan.cadence === "weekly" ? "每周" : plan.cadence === "daily" ? "每日" : "每月"} {money(plan.amount)} · 取消</button>)}
            </div>
            {txs.slice(0, 3).map(tx => <div key={tx.id} className="mt-2 flex justify-between text-[11px] text-[var(--c-icon)]"><span>{time(tx.at)} · {tx.note}</span><span>{money(tx.amount)}</span></div>)}
          </div>
        );
      })}
    </div>
  );
}

function LedgerTab({ characters }: { characters: ReturnType<typeof loadCharacters> }) {
  return (
    <div className="flex flex-col gap-3">
      {characters.map(character => <CharacterLedgerCard key={character.id} character={character} />)}
      {characters.length === 0 && <div className="rounded-2xl bg-[var(--c-card)] p-6 text-center text-sm text-[var(--c-icon)]">还没有角色</div>}
    </div>
  );
}

function CharacterLedgerCard({ character }: { character: ReturnType<typeof loadCharacters>[number] }) {
  const [profile, setProfile] = useState<CharacterEconomyProfile | null>(null);
  const [initial, setInitial] = useState("");
  const [amount, setAmount] = useState("");
  const [cadence, setCadence] = useState<CharacterIncomeCadence>("monthly");
  const [enabled, setEnabled] = useState(true);
  const [revision, setRevision] = useState(0);
  const [loadingProfile, setLoadingProfile] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoadingProfile(true);
    void ensureCharacterEconomyProfileAsync(character).then(next => {
      if (!alive) return;
      setProfile(next);
      setInitial(String(next.initialDeposit));
      setAmount(String(next.incomeAmount));
      setCadence(next.cadence);
      setEnabled(next.enabled);
    }).catch(error => {
      if (alive) notify(error instanceof Error ? error.message : "经济档案生成失败", "error");
    }).finally(() => {
      if (alive) setLoadingProfile(false);
    });
    return () => { alive = false; };  }, [character]);

  useEffect(() => {
    const sync = () => setRevision(value => value + 1);
    window.addEventListener(CHARACTER_ECONOMY_UPDATED_EVENT, sync);
    return () => window.removeEventListener(CHARACTER_ECONOMY_UPDATED_EVENT, sync);
  }, []);

  const ledger = loadCharacterLedger(character.id);
  const latest = ledger?.statements?.[0];
  const monthPrefix = new Date().toISOString().slice(0, 7);
  const monthRows = (ledger?.transactions || []).filter(tx => new Date(tx.at).toISOString().slice(0, 7) === monthPrefix);
  const monthIncome = monthRows.filter(tx => tx.amount > 0).reduce((sum, tx) => sum + tx.amount, 0);
  const monthExpense = monthRows.filter(tx => tx.amount < 0).reduce((sum, tx) => sum + Math.abs(tx.amount), 0);
  const expenseCategories = monthRows.filter(tx => tx.amount < 0).reduce<Record<string, number>>((acc, tx) => { acc[tx.category] = (acc[tx.category] || 0) + Math.abs(tx.amount); return acc; }, {});
  const topExpense = Object.entries(expenseCategories).sort((a,b) => b[1] - a[1]).slice(0,3);
  const save = () => {
    try {
      setCharacterInitialDeposit(character.id, Number(initial) || 0);
      const next = updateCharacterIncomePlan(character.id, {
        incomeAmount: Number(amount) || 0,
        cadence,
        enabled,
      });
      setProfile(next);
      setRevision(value => value + 1);
      notify(`${character.name} 的账本设置已保存`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "保存失败", "error");
    }
  };

  return (
    <div className="rounded-2xl bg-[var(--c-card)] p-4" data-revision={revision}>
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium text-[var(--c-text)]">{character.name} 的账本</div>
        <div className="text-lg font-semibold">{money(ledger?.balance || 0)}</div>
      </div>
      <div className="mt-1 text-[11px] text-[var(--c-icon)]">
        {latest ? `本周收入 ${money(latest.income)} · 支出 ${money(latest.expense)} · 结余 ${money(latest.closing)}` : "还没有收支记录"}
        {profile?.initialAppliedAt ? " · 初始存款已入账" : ""}
        {profile?.enabled && profile.incomeAmount > 0 ? ` · 下次固定收入 ${time(profile.nextIncomeAt)}` : ""}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <div className="rounded-xl bg-[#e9eee5] p-3"><div className="text-[10px] text-[#6c8068]">本月收入</div><div className="mt-1 text-sm font-semibold text-[#3f6547]">{money(monthIncome)}</div></div>
        <div className="rounded-xl bg-[#eee9e2] p-3"><div className="text-[10px] text-[#8d7165]">本月支出</div><div className="mt-1 text-sm font-semibold text-[#80594d]">{money(monthExpense)}</div></div>
      </div>
      {topExpense.length > 0 && <div className="mt-2 rounded-xl bg-[var(--c-input)] p-3"><div className="mb-2 text-[10px] text-[var(--c-icon)]">本月消费去向</div><div className="flex flex-wrap gap-2">{topExpense.map(([name,value])=><span key={name} className="rounded-full bg-white/70 px-2 py-1 text-[10px] text-[#777]">{name} {money(value)}</span>)}</div></div>}
            {loadingProfile && <div className="mt-2 text-[11px] text-[var(--c-icon)]">正在根据角色卡分析经济档案…</div>}
      {!loadingProfile && profile?.basis && (
        <div className="mt-2 rounded-xl bg-[var(--c-input)] px-3 py-2 text-[10px] text-[var(--c-icon)]">
          {profile.source === "llm" ? "大模型按角色卡判断" : "人设关键词兜底"}：{profile.basis}
        </div>
      )}
      <div className="mt-3 grid grid-cols-2 gap-2">
        <label className="text-[11px] text-[var(--c-icon)]">初始存款
          <input type="number" inputMode="decimal" value={initial} disabled={loadingProfile} onChange={event => setInitial(event.target.value)} className="ui-input mt-1 w-full" />
        </label>
        <label className="text-[11px] text-[var(--c-icon)]">固定收入
          <input type="number" inputMode="decimal" value={amount} disabled={loadingProfile} onChange={event => setAmount(event.target.value)} className="ui-input mt-1 w-full" />
        </label>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <select value={cadence} disabled={loadingProfile} onChange={event => setCadence(event.target.value === "weekly" ? "weekly" : "monthly")} className="ui-select flex-1">
          <option value="monthly">每月发一次（30 天）</option>
          <option value="weekly">每周发一次（7 天）</option>
        </select>
        <button type="button" disabled={loadingProfile} onClick={() => setEnabled(value => !value)} className={`shrink-0 rounded-full px-3 py-2 text-xs ${enabled ? "bg-[var(--c-primary)] text-white" : "bg-[var(--c-input)] text-[var(--c-text)]"}`}>
          {enabled ? "自动收入开" : "自动收入关"}
        </button>
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <div className="text-[10px] text-[var(--c-icon)]">固定收入由系统自动入账；额外收入/支出仍由角色用收支工具记账。</div>
        <button type="button" disabled={loadingProfile} onClick={save} className="ui-btn ui-btn-primary shrink-0 px-4">保存</button>
      </div>
      <div className="mt-3 flex flex-col gap-1">
        {(ledger?.transactions || []).slice(-4).reverse().map(tx => (
          <div key={tx.id} className="flex justify-between text-[11px] text-[var(--c-icon)]">
            <span>{time(tx.at)} · {tx.note || tx.category}</span>
            <span className={tx.amount < 0 ? "text-rose-500" : "text-emerald-600"}>{tx.amount < 0 ? "-" : "+"}{money(Math.abs(tx.amount))}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
