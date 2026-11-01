import { NextResponse } from "next/server";

import { getCurrentAccount } from "@/lib/server/account-auth";
import { encodeSupabaseFilter, getSupabaseServerConfig, supabaseRestFetch } from "@/lib/server/supabase-rest";

type CloudLifeDiagnostic = {
  id: string;
  severity: "error" | "warning" | "info";
  code: string;
  detail: string;
  repair_hint: string;
  updated_at: string;
  resolved_at: string | null;
};

export async function GET(request: Request) {
  if (!getSupabaseServerConfig()) {
    return NextResponse.json({ ok: false, error: "站点 Supabase 未配置。", diagnostics: [] }, { status: 503 });
  }
  const account = await getCurrentAccount(request).catch(() => null);
  if (!account) {
    return NextResponse.json({ ok: false, error: "未登录。", diagnostics: [] }, { status: 401 });
  }
  const result = await supabaseRestFetch<CloudLifeDiagnostic[]>(
    "life_schedule_diagnostics?user_id=eq." + encodeSupabaseFilter(account.id)
      + "&resolved_at=is.null&select=id,severity,code,detail,repair_hint,updated_at,resolved_at"
      + "&order=updated_at.desc&limit=20",
  );
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error, diagnostics: [] }, { status: 502 });
  }
  return NextResponse.json({ ok: true, diagnostics: result.data });
}
