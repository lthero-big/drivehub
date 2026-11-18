import { File, FileArchive, FileAudio, FileCode2, FileImage, FileSpreadsheet, FileText, FileVideo, Folder, HardDrive, Presentation, Cloud, Server } from "lucide-react";
import { ext, kindOf } from "../lib/util";
import { cx } from "../lib/util";

const TONE: Record<string, string> = {
  folder: "text-[#e0a526]",
  image: "text-[#d9488f]",
  video: "text-[#7c5cff]",
  audio: "text-[#e2683c]",
  pdf: "text-[#e5484d]",
  markdown: "text-[#3b82f6]",
  code: "text-[#10a37f]",
  text: "text-muted",
  archive: "text-[#a16207]",
  office: "text-[#2563eb]",
  other: "text-faint",
};

/** Layered folder: back plate, three papers, front lid (hover = lid tips back + papers rise / fan out). */
export function FolderIcon({ size = 20, open, className }: { size?: number; open?: boolean; className?: string }) {
  return (
    <span aria-hidden className={cx("fi", size < 28 && "fi-sm", size >= 44 && "fi-lg", open && "fi-open", className)} style={{ width: size, height: size * 0.82 }}>
      <i className="fi-back" />
      <i className="fi-paper p1" />
      <i className="fi-paper p3" />
      <i className="fi-paper p2" />
      <i className="fi-front" />
    </span>
  );
}

export function FileIcon({ name, isDir, mountKind, className, size }: { name: string; isDir: boolean; mountKind?: string | null; className?: string; size?: number }) {
  const c = cx("shrink-0", className ?? "size-5");
  if (isDir && !mountKind) {
    const m = /size-(\d+(?:\.\d+)?)/.exec(className ?? "");
    return <FolderIcon size={size ?? (m ? Number(m[1]) * 4 : 20)} />;
  }
  if (mountKind) {
    const I = mountKind === "fs" ? HardDrive : mountKind === "s3" ? Cloud : Server;
    return <I className={cx(c, "text-accent")} aria-hidden />;
  }
  const k = kindOf(name, isDir);
  const e = ext(name);
  const I =
    k === "folder" ? Folder
    : k === "image" ? FileImage
    : k === "video" ? FileVideo
    : k === "audio" ? FileAudio
    : k === "code" ? FileCode2
    : k === "archive" ? FileArchive
    : k === "office" ? (["xls", "xlsx", "ods"].includes(e) ? FileSpreadsheet : ["ppt", "pptx", "odp"].includes(e) ? Presentation : FileText)
    : k === "pdf" || k === "markdown" || k === "text" ? FileText
    : File;
  return <I className={cx(c, TONE[k])} aria-hidden fill={k === "folder" ? "currentColor" : "none"} fillOpacity={k === "folder" ? 0.18 : 0} />;
}
