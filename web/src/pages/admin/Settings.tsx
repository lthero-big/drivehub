import { useEffect, useState } from "react";
import { ArrowUpCircle, Mail, ShieldCheck } from "lucide-react";
import { BentoFocusGrid, type BentoFocusTile } from "../../components/BentoFocusGrid";
import { call } from "../../lib/api";
import { useApp } from "../../lib/app";
import { go } from "../../lib/router";
import { errMsg } from "../../lib/util";
import { Badge, Card, PageHeader, Switch, toast } from "../../ui/ui";
import { Sk } from "../../ui/r6";
import { UpdatePage } from "./Update";

type S = { open_registration: boolean; require_email_verification: boolean };
type Tab = "access" | "service" | "update";

function UpdateHint() {
  const [t, setT] = useState("正在读取版本…");
  useEffect(() => {
    call<{ current_version: string; last_check: { latest?: { version: string } | null; update_available?: boolean } | null }>("GET", "/api/admin/update/status")
      .then((v) => {
        const ver = v && v.current_version;
        if (!ver) { setT("暂时无法获取版本信息"); return; }
        const latest = v.last_check?.latest?.version;
        if (v.last_check?.update_available && latest) setT(`当前 ${ver} · 可更新到 ${latest}`);
        else setT(`当前 ${ver}${latest ? " · 已是最新" : ""}`);
      })
      .catch(() => setT("暂时无法获取更新状态"));
  }, []);
  return <p className="dh-set-hint">{t}</p>;
}

export function SettingsPage({ tab }: { tab?: string }) {
  const { status, reload, isAdmin } = useApp();
  const [s, setS] = useState<S | null>(null);
  useEffect(() => {
    call<S>("GET", "/api/admin/settings").then(setS).catch((e) => toast.err(errMsg(e)));
  }, []);
  const put = async (patch: Partial<S>) => {
    try {
      setS(await call("PUT", "/api/admin/settings", patch));
      reload();
      toast.ok("已保存");
    } catch (e) {
      toast.err(errMsg(e));
    }
  };
  const Row = ({ title, desc, k }: { title: string; desc: string; k: keyof S }) => (
    <div className="flex items-center gap-4 py-3">
      <div className="flex-1">
        <p className="text-[14px] font-medium">{title}</p>
        <p className="text-[13px] text-muted">{desc}</p>
      </div>
      {s ? <Switch label={title} checked={s[k]} onChange={(v) => put({ [k]: v })} /> : <Sk className="h-7 w-12 rounded-full" />}
    </div>
  );

  const tiles: BentoFocusTile[] = [
    {
      id: "access",
      label: "注册与登录",
      icon: <ShieldCheck className="size-4" />,
      hint: s
        ? `注册 ${s.open_registration ? "开放" : "已关闭"} · 邮箱验证 ${s.require_email_verification ? "必需" : "关闭"}`
        : "注册策略",
      home: (
        <>
          <p className="dh-set-stat">{s ? (s.open_registration ? "开放注册" : "关闭注册") : "…"}</p>
          <p className="dh-set-hint">{s ? (s.require_email_verification ? "新用户需要验证邮箱" : "注册后可直接登录") : "正在读取设置"}</p>
        </>
      ),
      full: (
        <Card title="注册与登录">
          <div className="divide-y divide-line">
            <Row k="open_registration" title="开放注册" desc="关闭后只有管理员能创建账号" />
            <Row k="require_email_verification" title="注册需验证邮箱" desc="新用户点击邮件链接后才能登录" />
          </div>
        </Card>
      ),
    },
    {
      id: "service",
      label: "服务状态",
      icon: <Mail className="size-4" />,
      hint: status.mail_transport === "smtp" ? "邮件通道 SMTP" : "邮件通道 log",
      home: (
        <>
          <p className="dh-set-stat">{status.mail_transport === "smtp" ? "SMTP" : "日志通道"}</p>
          <p className="dh-set-hint">
            {status.oauth_providers.length ? `OAuth：${status.oauth_providers.join("、")}` : "未配置 OAuth"}
          </p>
        </>
      ),
      full: (
        <Card title="服务状态">
          <dl className="grid grid-cols-[8rem_1fr] gap-y-3 text-[14px]">
            <dt className="text-muted">邮件通道</dt>
            <dd>{status.mail_transport === "smtp" ? <Badge tone="ok">SMTP</Badge> : <Badge tone="warn">log（未配置 SMTP，邮件只写日志）</Badge>}</dd>
            <dt className="text-muted">OAuth 登录</dt>
            <dd>{status.oauth_providers.length ? status.oauth_providers.join("、") : <span className="text-muted">未配置（DRIVEHUB_OAUTH_* 环境变量）</span>}</dd>
          </dl>
        </Card>
      ),
    },
  ];
  if (isAdmin) {
    tiles.push({
      id: "update",
      label: "系统更新",
      icon: <ArrowUpCircle className="size-4" />,
      home: <UpdateHint />,
      full: <UpdatePage />,
    });
  }

  const known: Tab[] = tiles.map((t) => t.id) as Tab[];
  const focus = known.includes(tab as Tab) ? (tab as Tab) : null;

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PageHeader title="后台设置" desc="注册策略、服务状态，以及系统更新" />
      <BentoFocusGrid
        tiles={tiles}
        focus={focus}
        onFocus={(id) => go(id ? `#/admin/settings/${id}` : "#/admin/settings")}
        cols={3}
        label="后台设置"
      />
    </div>
  );
}
