// Tag editor (DEPTAI-485 r5): animated-tags picker (educalvolpz) for one or more items.
import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import type { FsItem } from "../lib/api";
import { TAG_COLORS, tagStore, useTags, type Tag } from "../lib/tags";
import { cx, errMsg } from "../lib/util";
import { AnimatedTags } from "../ui/r5";
import { Button, Input, Modal, toast } from "../ui/ui";

export function TagDialog({ items, current, onClose, onChanged }: { items: FsItem[]; current: Record<string, Tag[]>; onClose: () => void; onChanged: (m: Record<string, Tag[]>) => void }) {
  const all = useTags();
  const paths = items.map((i) => i.path);
  // a tag counts as selected when every item carries it
  const common = () => all.filter((t) => paths.every((p) => (current[p] ?? []).some((x) => x.id === t.id))).map((t) => String(t.id));
  const [sel, setSel] = useState<string[]>(common);
  const [name, setName] = useState("");
  const [color, setColor] = useState<string>("blue");
  useEffect(() => setSel(common()), [all.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = async (ids: string[], ch: { id: string; on: boolean }) => {
    setSel(ids);
    try {
      onChanged(await tagStore.assign(paths, ch.on ? { add: [Number(ch.id)] } : { remove: [Number(ch.id)] }));
    } catch (e) {
      toast.err(errMsg(e));
      setSel(common());
    }
  };
  const create = async () => {
    const n = name.trim();
    if (!n) return;
    try {
      const t = await tagStore.create(n, color);
      onChanged(await tagStore.assign(paths, { add: [t.id] }));
      setSel((s) => [...s, String(t.id)]);
      setName("");
    } catch (e) {
      toast.err(errMsg(e));
    }
  };
  return (
    <Modal open onClose={onClose} title={items.length === 1 ? `标签 · ${items[0].name}` : `标签 · ${items.length} 项`} footer={<Button variant="primary" onClick={onClose}>完成</Button>}>
      <div className="space-y-4" data-tag-dialog>
        <AnimatedTags options={all.map((t) => ({ id: String(t.id), label: t.name, color: t.color }))} selected={sel} onChange={toggle} emptyText="点下面的标签加进来" />
        <form className="space-y-2 border-t border-dashed border-line pt-3" onSubmit={(e) => (e.preventDefault(), create())}>
          <div className="flex gap-2">
            <Input placeholder="新标签名" value={name} onChange={(e) => setName(e.target.value)} aria-label="新标签名" maxLength={32} />
            <Button type="submit" disabled={!name.trim()}><Plus className="size-4" /> 新建并添加</Button>
          </div>
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="标签颜色">
            {TAG_COLORS.map((c) => <button key={c} type="button" role="radio" aria-checked={color === c} aria-label={c} onClick={() => setColor(c)} className={cx("size-6 rounded-full border-2 transition", `tc-${c}`, color === c ? "scale-110 border-fg" : "border-transparent")} />)}
          </div>
        </form>
      </div>
    </Modal>
  );
}
