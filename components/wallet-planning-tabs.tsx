"use client";

import { useEffect, useMemo, useState } from "react";
import { CalendarDays, CirclePlus, Repeat2, Target, Trash2 } from "lucide-react";
import { loadWalletState, formatWalletAmount } from "@/lib/wallet-storage";
import {
  addWalletBudget, addWalletRecurringBill, addWalletSavingsGoal, contributeToWalletGoal,
  loadWalletPlanning, removeWalletBudget, removeWalletBill, removeWalletGoal, updateWalletBill,
  type WalletPlanningState, runDueWalletBills,
} from "@/lib/wallet-planning";

export type WalletPlanningTab = "budget" | "goals" | "bills" | "calendar" | "insights";
const money = formatWalletAmount;
const monthKey = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}`;
const dateLabel = (value: string) => new Date(value).toLocaleDateString("zh-CN",{month:"long",day:"numeric"});
const todayInput = () => new Date(Date.now()-new Date().getTimezoneOffset()*60000).toISOString().slice(0,10);
function Panel({children}:{children:React.ReactNode}) { return <section className="wallet-section rounded-2xl p-4">{children}</section>; }
function Label({children}:{children:React.ReactNode}) { return <div className="wallet-kicker mb-2">{children}</div>; }
function Field({label,...props}:{label:string;value:string;onChange:(e:React.ChangeEvent<HTMLInputElement>)=>void;placeholder?:string;type?:string;step?:string}) {
  return <label className="block min-w-0 text-[11px] text-[#827d70]">{label}<input {...props} className="ui-input mt-1 w-full"/></label>;
}
export function WalletPlanningTabs({tab,onChange}:{tab:WalletPlanningTab;onChange:()=>void}) {
  const [state,setState]=useState<WalletPlanningState>(()=>loadWalletPlanning());
  const [revision,setRevision]=useState(0);
  const [category,setCategory]=useState("餐饮");
  const [budget,setBudget]=useState("2000");
  const [goalName,setGoalName]=useState("");
  const [goalAmount,setGoalAmount]=useState("5000");
  const [goalDeadline,setGoalDeadline]=useState("");
  const [contributions,setContributions]=useState<Record<string,string>>({});
  const [billName,setBillName]=useState("");
  const [billAmount,setBillAmount]=useState("99");
  const [billCategory,setBillCategory]=useState("订阅");
  const [billCadence,setBillCadence]=useState<"weekly"|"monthly">("monthly");
  const [billDate,setBillDate]=useState(todayInput());
  const wallet=loadWalletState();
  const refresh=()=>{setState(loadWalletPlanning());setRevision(v=>v+1);onChange();};
  useEffect(()=>{const sync=()=>setState(loadWalletPlanning());window.addEventListener("wallet-planning-updated",sync);return()=>window.removeEventListener("wallet-planning-updated",sync);},[]);
  const currentMonth=monthKey();
  const monthTransactions=wallet.transactions.filter(tx=>tx.createdAt.slice(0,7)===currentMonth);
  const expenses=monthTransactions.filter(tx=>tx.amount<0 && tx.kind==="payment");
  const income=monthTransactions.filter(tx=>tx.amount>0 && tx.kind!=="transfer_in" ? true : tx.amount>0 && tx.kind==="refund");
  const expenseTotal=expenses.reduce((sum,tx)=>sum+Math.abs(tx.amount),0);
  const incomeTotal=income.reduce((sum,tx)=>sum+tx.amount,0);
  const categoryTotals=useMemo(()=>expenses.reduce<Record<string,number>>((acc,tx)=>{acc[tx.category||"其他"]=(acc[tx.category||"其他"]||0)+Math.abs(tx.amount);return acc;},{}),[wallet.transactions,revision]);
  const budgetRows=state.budgets.filter(v=>v.month===currentMonth);
  const budgetTotal=budgetRows.reduce((sum,v)=>sum+v.limit,0);
  const dueBills=state.bills.filter(v=>v.status==="active").sort((a,b)=>a.nextDueAt.localeCompare(b.nextDueAt));
  const calendarItems=[
    ...dueBills.map(v=>({id:v.id,date:v.nextDueAt,title:v.title,detail:`周期账单 · ${money(v.amount)}`,kind:"bill"})),
    ...wallet.transactions.slice(0,100).map(v=>({id:v.id,date:v.createdAt,title:v.title,detail:`${v.amount<0?"支出":"收入"} · ${money(Math.abs(v.amount))}`,kind:"tx"})),
  ].sort((a,b)=>a.date.localeCompare(b.date));
  const submit=(fn:()=>unknown)=>{try{fn();refresh();}catch(error){window.dispatchEvent(new CustomEvent("app-global-notice",{detail:{kind:"error",message:error instanceof Error?error.message:"操作失败"}}));}};
  if(tab==="budget") return <div className="wallet-private-bank flex flex-col gap-3" data-revision={revision}>
    <Panel><div className="flex items-start justify-between"><div><Label>MONTHLY CONTROL</Label><div className="text-xl font-semibold text-[#292b25]">本月预算</div><p className="mt-1 text-[11px] text-[#8a8579]">{currentMonth} · 根据钱包实际支出流水统计</p></div><div className="text-right"><div className="text-[10px] text-[#8a8579]">本月已支出</div><div className="text-xl font-semibold">{money(expenseTotal)}</div></div></div><div className="wallet-metal-line my-4"/><div className="grid grid-cols-2 gap-3"><div><div className="text-[10px] text-[#8a8579]">已设置分类预算</div><div className="mt-1 text-lg font-semibold">{money(budgetTotal)}</div></div><div><div className="text-[10px] text-[#8a8579]">预算剩余</div><div className="mt-1 text-lg font-semibold">{money(Math.max(0,budgetTotal-expenseTotal))}</div></div></div></Panel>
    <Panel><Label>ADD A LIMIT</Label><div className="grid grid-cols-2 gap-2"><label className="text-[11px] text-[#827d70]">支出分类<select value={category} onChange={e=>setCategory(e.target.value)} className="ui-select mt-1 w-full">{["餐饮","交通","购物","居住","娱乐","医疗","订阅","学习","其他"].map(v=><option key={v}>{v}</option>)}</select></label><Field label="月度限额" value={budget} onChange={e=>setBudget(e.target.value)} type="number"/></div><button onClick={()=>submit(()=>addWalletBudget({month:currentMonth,category,limit:Number(budget)}))} className="ui-btn ui-btn-primary mt-3 w-full"><CirclePlus size={14} className="mr-1 inline"/> 添加 / 更新分类预算</button></Panel>
    {budgetRows.map(row=>{const spent=categoryTotals[row.category]||0;const pct=Math.min(100,spent/row.limit*100);return <Panel key={row.id}><div className="flex justify-between"><div><div className="font-medium text-[#33352e]">{row.category}</div><div className="mt-1 text-[10px] text-[#8a8579]">限额 {money(row.limit)} · 已用 {money(spent)}</div></div><button aria-label="删除预算" onClick={()=>submit(()=>removeWalletBudget(row.id))} className="text-[#aaa]"><Trash2 size={15}/></button></div><div className="mt-3 h-2 overflow-hidden rounded-full bg-[#e5e2d9]"><div className="h-full rounded-full" style={{width:pct+"%",background:pct>=100?"#9d554a":"linear-gradient(90deg,#a99569,#454b3e)"}}/></div><div className="mt-2 flex justify-between text-[10px] text-[#8a8579]"><span>{pct>=100?"已超出预算":`还可使用 ${money(row.limit-spent)}`}</span><span>{pct.toFixed(0)}%</span></div></Panel>})}
    {!budgetRows.length&&<Panel><div className="py-5 text-center text-sm text-[#999]">还没有分类预算，先为最常花钱的类别设个上限。</div></Panel>}
  </div>;
  if(tab==="goals") return <div className="wallet-private-bank flex flex-col gap-3" data-revision={revision}>
    <Panel><Label>WEALTH PLAN</Label><div className="text-xl font-semibold">储蓄目标</div><p className="mt-1 text-[11px] text-[#8a8579]">每次存入都会从钱包余额真实扣款，并写入储蓄流水。</p><div className="mt-4 grid grid-cols-2 gap-2"><Field label="目标名称" value={goalName} onChange={e=>setGoalName(e.target.value)} placeholder="例如：旅行基金"/><Field label="目标金额" value={goalAmount} onChange={e=>setGoalAmount(e.target.value)} type="number"/></div><Field label="目标日期（选填）" value={goalDeadline} onChange={e=>setGoalDeadline(e.target.value)} type="date"/><button onClick={()=>submit(()=>{addWalletSavingsGoal({title:goalName,target:Number(goalAmount),deadline:goalDeadline||undefined});setGoalName("");})} className="ui-btn ui-btn-primary mt-3 w-full">创建储蓄目标</button></Panel>
    {state.goals.map(goal=>{const pct=Math.min(100,goal.saved/goal.target*100);return <Panel key={goal.id}><div className="flex items-start justify-between"><div><div className="font-medium text-[#33352e]">{goal.title}</div><div className="mt-1 text-[10px] text-[#8a8579]">{goal.deadline?`目标日期 ${goal.deadline}`:"没有设定截止日期"}</div></div><Target size={19} className="text-[#a18c5e]"/></div><div className="mt-4 flex items-end justify-between"><div className="text-2xl font-semibold">{money(goal.saved)}</div><div className="text-[11px] text-[#8a8579]">目标 {money(goal.target)}</div></div><div className="mt-2 h-2 overflow-hidden rounded-full bg-[#e5e2d9]"><div className="h-full rounded-full bg-gradient-to-r from-[#a99569] to-[#414b3d]" style={{width:pct+"%"}}/></div><div className="mt-2 flex justify-between text-[10px] text-[#8a8579]"><span>{pct>=100?"目标已达成":`还差 ${money(goal.target-goal.saved)}`}</span><span>{pct.toFixed(0)}%</span></div>{pct<100&&<div className="mt-3 flex gap-2"><input value={contributions[goal.id]||"100"} onChange={e=>setContributions(p=>({...p,[goal.id]:e.target.value}))} inputMode="decimal" className="ui-input min-w-0 flex-1" placeholder="存入金额"/><button onClick={()=>submit(()=>contributeToWalletGoal(goal.id,Number(contributions[goal.id]||100)))} className="ui-btn ui-btn-primary">存入</button></div>}<button onClick={()=>submit(()=>removeWalletGoal(goal.id))} className="mt-3 text-[10px] text-[#aaa]">删除目标（已存金额不退回钱包）</button></Panel>})}
    {!state.goals.length&&<Panel><div className="py-5 text-center text-sm text-[#999]">给下一次旅行、心仪物品或长期计划留一笔钱。</div></Panel>}
  </div>;
  if(tab==="bills") return <div className="wallet-private-bank flex flex-col gap-3" data-revision={revision}>
    <Panel><Label>RECURRING PAYMENTS</Label><div className="text-xl font-semibold">周期账单</div><p className="mt-1 text-[11px] leading-5 text-[#8a8579]">到期账单会在钱包打开时自动从余额扣款；余额不足会标记为待处理，不会反复扣款。</p><div className="mt-4 grid grid-cols-2 gap-2"><Field label="账单名称" value={billName} onChange={e=>setBillName(e.target.value)} placeholder="例如：音乐会员"/><Field label="每期金额" value={billAmount} onChange={e=>setBillAmount(e.target.value)} type="number"/></div><div className="mt-2 grid grid-cols-2 gap-2"><label className="text-[11px] text-[#827d70]">分类<select value={billCategory} onChange={e=>setBillCategory(e.target.value)} className="ui-select mt-1 w-full">{["订阅","居住","通讯","交通","其他"].map(v=><option key={v}>{v}</option>)}</select></label><label className="text-[11px] text-[#827d70]">周期<select value={billCadence} onChange={e=>setBillCadence(e.target.value as "weekly"|"monthly")} className="ui-select mt-1 w-full"><option value="monthly">每月</option><option value="weekly">每周</option></select></label></div><Field label="首次扣款日期" value={billDate} onChange={e=>setBillDate(e.target.value)} type="date"/><button onClick={()=>submit(()=>{addWalletRecurringBill({title:billName,amount:Number(billAmount),category:billCategory,cadence:billCadence,firstDueAt:new Date(billDate+"T09:00:00").toISOString()});setBillName("");})} className="ui-btn ui-btn-primary mt-3 w-full">添加周期账单</button></Panel>
    {state.bills.map(bill=><Panel key={bill.id}><div className="flex items-start justify-between"><div><div className="font-medium text-[#33352e]">{bill.title}</div><div className="mt-1 text-[10px] text-[#8a8579]">{bill.category} · {bill.cadence==="monthly"?"每月":"每周"} · 下次 {dateLabel(bill.nextDueAt)}</div></div><div className="text-right"><div className="font-semibold">{money(bill.amount)}</div><div className={`mt-1 text-[10px] ${bill.status==="overdue"?"text-[#a45145]":bill.status==="paused"?"text-[#999]":"text-[#68745d]"}`}>{bill.status==="overdue"?"扣款失败 · 待处理":bill.status==="paused"?"已暂停":"自动扣款开启"}</div></div></div>{bill.lastError&&<div className="mt-2 text-[10px] text-[#a45145]">{bill.lastError}</div>}<div className="mt-3 flex gap-2"><button onClick={()=>submit(()=>{updateWalletBill(bill.id,{status:bill.status==="active"?"paused":"active"});if(bill.status!=="active")runDueWalletBills();})} className="ui-btn ui-btn-ghost flex-1">{bill.status==="active"?"暂停":bill.status==="overdue"?"重新扣款":"恢复"}</button><button onClick={()=>submit(()=>removeWalletBill(bill.id))} className="ui-btn ui-btn-ghost text-[#999]">删除</button></div></Panel>)}
    {!state.bills.length&&<Panel><div className="py-5 text-center text-sm text-[#999]">把固定订阅、房租等周期支出集中管理。</div></Panel>}
  </div>;
  if(tab==="calendar") return <div className="wallet-private-bank flex flex-col gap-3">
    <Panel><Label>FINANCIAL CALENDAR</Label><div className="text-xl font-semibold">财务日历</div><p className="mt-1 text-[11px] text-[#8a8579]">账单到期日与最近的实际收支流水。</p></Panel>
    {calendarItems.length?calendarItems.map(item=><div key={item.id} className="wallet-section flex items-center gap-3 rounded-xl p-3"><div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#e8e4d8] text-[#8a7955]">{item.kind==="bill"?<CalendarDays size={17}/>:<Repeat2 size={17}/>}</div><div className="min-w-0 flex-1"><div className="truncate text-sm font-medium text-[#34362f]">{item.title}</div><div className="mt-1 text-[10px] text-[#8a8579]">{item.detail}</div></div><div className="text-[10px] text-[#8a8579]">{dateLabel(item.date)}</div></div>):<Panel><div className="py-8 text-center text-sm text-[#999]">暂时没有账单或流水事件。</div></Panel>}
  </div>;
  const sorted=Object.entries(categoryTotals).sort((a,b)=>b[1]-a[1]);
  const max=sorted[0]?.[1]||1;
  return <div className="wallet-private-bank flex flex-col gap-3">
    <Panel><Label>MONTHLY STATEMENT · {currentMonth}</Label><div className="text-xl font-semibold">月度财务报告</div><div className="mt-4 grid grid-cols-2 gap-3"><div className="rounded-xl bg-[#e9eee5] p-3"><div className="text-[10px] text-[#6c8068]">收入</div><div className="mt-1 text-xl font-semibold text-[#3f6547]">{money(incomeTotal)}</div></div><div className="rounded-xl bg-[#eee9e2] p-3"><div className="text-[10px] text-[#8d7165]">支出</div><div className="mt-1 text-xl font-semibold text-[#80594d]">{money(expenseTotal)}</div></div></div><div className="mt-4 flex items-center justify-between border-t border-[#e5e1d8] pt-3"><span className="text-[11px] text-[#8a8579]">本月净结余</span><strong className={incomeTotal-expenseTotal>=0?"text-[#476c4e]":"text-[#9a554a]"}>{money(incomeTotal-expenseTotal)}</strong></div><div className="mt-1 text-[10px] text-[#aaa]">仅统计当前钱包账户中已记录的收支，不包含角色账本和账户间转账。</div></Panel>
    <Panel><Label>SPENDING BREAKDOWN</Label><div className="mb-3 text-[15px] font-medium">支出分类</div>{sorted.length?sorted.map(([name,value])=><div key={name} className="mb-4 last:mb-0"><div className="mb-1 flex justify-between text-[11px]"><span className="text-[#55564f]">{name}</span><span className="text-[#777]">{money(value)} · {(value/expenseTotal*100).toFixed(0)}%</span></div><div className="h-2 overflow-hidden rounded-full bg-[#e5e2d9]"><div className="h-full rounded-full bg-gradient-to-r from-[#a99569] to-[#454b3e]" style={{width:value/max*100+"%"}}/></div></div>):<div className="py-6 text-center text-sm text-[#999]">本月还没有支出记录。</div>}</Panel>
    <Panel><Label>ACCOUNT ACTIVITY</Label><div className="text-[15px] font-medium">本月流水</div>{monthTransactions.slice(0,12).map(tx=><div key={tx.id} className="wallet-tx flex items-center justify-between gap-2 py-3"><div className="min-w-0"><div className="truncate text-[12px] text-[#44453e]">{tx.title}</div><div className="mt-1 text-[10px] text-[#999]">{new Date(tx.createdAt).toLocaleDateString("zh-CN")} · {tx.category}</div></div><div className={`shrink-0 text-[12px] font-semibold ${tx.amount<0?"text-[#986455]":"text-[#52765a]"}`}>{tx.amount>0?"+":"−"}{money(Math.abs(tx.amount))}</div></div>)}{!monthTransactions.length&&<div className="py-5 text-center text-sm text-[#999]">还没有本月流水。</div>}</Panel>
  </div>;
}
