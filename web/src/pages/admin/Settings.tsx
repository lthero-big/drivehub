import { useEffect, useState } from "react";
import { Mail, ShieldCheck } from "lucide-react";
import { call } from "../../lib/api";
import { useApp } from "../../lib/app";
import { go } from "../../lib/router";
import { errMsg } from "../../lib/util";
import { Badge, Card, PageHeader, Switch, Tabs, toast } from "../../ui/ui";

type S = { open_registration: boolean; require_email_verification: boolean };
type Tab = "access" | "service";

export function SettingsPage({ tab }: { tab?: string }) {
  const { status, reload } = useApp();
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
      {s && <Switch label={title} checked={s[k]} onChange={(v) => put({ [k]: v })} />}
    </div>
  );
  const cur: Tab = tab === "service" ? "service" : "access";
  return (
    <div className="max-w-3xl space-y-5">
      <PageHeader title="后台设置" desc="注册策略与服务状态" />
      <Tabs<Tab> tabs={[{ id: "access", label: "注册与登录", icon: <ShieldCheck /> }, { id: "service", label: "服务状态", icon: <Mail /> }]} value={cur} onChange={(t) => go(`#/admin/settings/${t}`)} />
      <div key={cur} className="anim-in">
        {cur === "access" ? (
          <Card title="注册与登录">
            <div className="divide-y divide-line">
              <Row k="open_registration" title="开放注册" desc="关闭后只有管理员能创建账号" />
              <Row k="require_email_verification" title="注册需验证邮箱" desc="新用户点击邮件链接后才能登录" />
            </div>
          </Card>
        ) : (
          <Card title="服务状态">
            <dl className="grid grid-cols-[8rem_1fr] gap-y-3 text-[14px]">
              <dt className="text-muted">邮件通道</dt>
              <dd>{status.mail_transport === "smtp" ? <Badge tone="ok">SMTP</Badge> : <Badge tone="warn">log（未配置 SMTP，邮件只写日志）</Badge>}</dd>
              <dt className="text-muted">OAuth 登录</dt>
              <dd>{status.oauth_providers.length ? status.oauth_providers.join("、") : <span className="text-muted">未配置（DRIVEHUB_OAUTH_* 环境变量）</span>}</dd>
            </dl>
          </Card>
        )}
      </div>
    </div>
  );
}
