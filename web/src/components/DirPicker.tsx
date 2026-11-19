import { useEffect, useState } from "react";
import { ChevronRight, CornerLeftUp } from "lucide-react";
import { client, ok, type FsItem } from "../lib/api";
import { errMsg, parentOf } from "../lib/util";
import { Button, Modal } from "../ui/ui";
import { FileIcon } from "./FileIcon";
import { Sk, SkWrap } from "../ui/r6";

/** Folder chooser for move / copy targets. */
export function DirPicker({ open, title, start, onClose, onPick, allowRoot }: { open: boolean; title: string; start: string; onClose: () => void; onPick: (dir: string) => void; allowRoot?: boolean }) {
  const [dir, setDir] = useState(start);
  const [items, setItems] = useState<FsItem[] | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    if (open) setDir(start);
  }, [open, start]);
  useEffect(() => {
    if (!open) return;
    setItems(null);
    setErr("");
    ok(client.GET("/api/fs/list", { params: { query: { path: dir, per_page: 1000 } } }))
      .then((r) => setItems(r.items.filter((i) => i.is_dir)))
      .catch((e) => setErr(errMsg(e)));
  }, [open, dir]);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <span className="mr-auto self-center truncate text-xs text-muted">目标：{dir}</span>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" disabled={dir === "/" && !allowRoot} onClick={() => onPick(dir)}>
            选择此文件夹
          </Button>
        </>
      }
    >
      <div className="min-h-64">
        {dir !== "/" && (
          <button onClick={() => setDir(parentOf(dir))} className="mb-1 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] text-muted hover:bg-hover">
            <CornerLeftUp className="size-4" /> 上一级
          </button>
        )}
        {err && <p className="text-sm text-danger">{err}</p>}
        {!items && !err && <SkWrap label="正在加载文件夹" className="space-y-1 px-2 py-1">{Array.from({ length: 6 }, (_, i) => <span key={i} className="flex items-center gap-2 py-1.5"><Sk className="size-4 rounded" /><Sk className="h-3 rounded" style={{ width: `${35 + ((i * 23) % 40)}%` }} /></span>)}</SkWrap>}
        {items?.length === 0 && <p className="px-2 py-6 text-center text-[13px] text-faint">没有子文件夹</p>}
        <ul>
          {items?.map((i) => (
            <li key={i.path}>
              <button onClick={() => setDir(i.path)} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] hover:bg-hover">
                <FileIcon name={i.name} isDir mountKind={i.mount_kind} className="size-4" />
                <span className="flex-1 truncate">{i.name}</span>
                <ChevronRight className="size-4 text-faint" />
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  );
}
