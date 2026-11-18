// Share + details (属性) dialogs for files and folders.
import { useEffect, useState } from "react";
import { Copy, Link2 } from "lucide-react";
import { client, ok, type FsItem } from "../lib/api";
import { appLink, copyText } from "../lib/links";
import { fmtSize, KIND_LABEL, kindOf } from "../lib/util";
import { Button, Input, Modal, toast } from "../ui/ui";
import { FileIcon } from "./FileIcon";

export function ShareDialog({ item, onClose }: { item: FsItem | null; onClose: () => void }) {
  const [qr, setQr] = useState<string>("");
  const link = item ? appLink(item) : "";
  useEffect(() => {
    setQr("");
    if (!item) return;
    import("qrcode").then((Q) => Q.toDataURL(link, { margin: 1, width: 168 })).then(setQr).catch(() => {});
  }, [item, link]);
  return (
    <Modal open={!!item} onClose={onClose} title={item ? `分享「${item.name}」` : ""} footer={<Button onClick={onClose}>完成</Button>}>
      {item && (
        <div className="space-y-4">
          <div className="flex items-center gap-3 rounded-2xl border border-line bg-panel-2 p-3">
            <FileIcon name={item.name} isDir={item.is_dir} mountKind={item.mount_kind} className="size-8" />
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{item.name}</p>
              <p className="truncate text-xs text-faint">{item.path}</p>
            </div>
          </div>
          <div className="flex gap-2">
            <Input readOnly value={link} aria-label="分享链接" onFocus={(e) => e.target.select()} />
            <Button variant="primary" onClick={async () => ((await copyText(link)) ? toast.ok("链接已复制") : toast.err("复制失败"))}>
              <Copy className="size-4" /> 复制
            </Button>
          </div>
          {qr && <img src={qr} alt="分享链接二维码" className="mx-auto size-[168px] rounded-xl border border-line bg-white p-1" />}
          <p className="flex items-start gap-1.5 text-xs text-muted">
            <Link2 className="mt-0.5 size-3.5 shrink-0" />
            站内链接：对方需要登录且有该路径的访问权限（访客可访问公开目录）。公开外链（有效期 / 提取码）随 DEPTAI-474 分享功能上线。
          </p>
        </div>
      )}
    </Modal>
  );
}

export function DetailsDialog({ item, onClose }: { item: FsItem | null; onClose: () => void }) {
  const [info, setInfo] = useState<FsItem | null>(null);
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    setInfo(null);
    setCount(null);
    if (!item) return;
    ok(client.GET("/api/fs/stat", { params: { query: { path: item.path } } })).then(setInfo).catch(() => setInfo(item));
    if (item.is_dir) ok(client.GET("/api/fs/list", { params: { query: { path: item.path, page: 1, per_page: 1 } } })).then((r) => setCount(r.total)).catch(() => {});
  }, [item]);
  const i = info ?? item;
  const rows: [string, React.ReactNode][] = i
    ? [
        ["名称", i.name],
        ["类型", i.mount_kind ? `存储（${i.mount_kind}）` : KIND_LABEL[kindOf(i.name, i.is_dir)]],
        ["位置", i.path],
        ...(i.is_dir ? ([["包含", count == null ? "…" : `${count} 项`]] as [string, React.ReactNode][]) : ([["大小", `${fmtSize(i.size)}（${i.size.toLocaleString()} 字节）`]] as [string, React.ReactNode][])),
        ["修改时间", i.modified_unix ? new Date(i.modified_unix * 1000).toLocaleString() : "—"],
        ["存储", i.path.split("/")[1] || "—"],
        ["权限", i.read_only ? "只读" : "可读写"],
      ]
    : [];
  return (
    <Modal open={!!item} onClose={onClose} title="属性" footer={<Button onClick={onClose}>关闭</Button>}>
      {i && (
        <div className="space-y-4">
          <div className="flex flex-col items-center gap-2 py-2">
            <FileIcon name={i.name} isDir={i.is_dir} mountKind={i.mount_kind} className="size-14" />
            <p className="max-w-full truncate text-sm font-semibold">{i.name}</p>
          </div>
          <dl className="divide-y divide-line rounded-2xl border border-line text-[13px]">
            {rows.map(([k, v]) => (
              <div key={k} className="flex gap-3 px-3.5 py-2.5">
                <dt className="w-16 shrink-0 text-muted">{k}</dt>
                <dd className="min-w-0 flex-1 break-all">{v}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </Modal>
  );
}
