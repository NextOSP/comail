/** Coarse file families the UI distinguishes (badge color, friendly label). */
export type FileFamily =
  | "pdf"
  | "doc"
  | "sheet"
  | "csv"
  | "slides"
  | "archive"
  | "image"
  | "video"
  | "audio"
  | "text"
  | "other";

export interface FileKind {
  family: FileFamily;
  /** short badge text, e.g. "PDF", "XLS", or the uppercased extension */
  label: string;
  color: string;
  /** lowercased extension without the dot ("" when there is none) */
  ext: string;
}

const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "heic", "avif", "ico"];

/** Maps a file to a family + short badge label + accent color by extension/mime. */
export function fileKind(filename: string | null, mimeType: string | null): FileKind {
  const ext = filename?.includes(".") ? (filename.split(".").pop() ?? "").toLowerCase() : "";
  const mime = mimeType?.toLowerCase() ?? "";
  const pick = (family: FileFamily, label: string, color: string): FileKind => ({ family, label, color, ext });
  if (ext === "pdf" || mime.includes("pdf")) return pick("pdf", "PDF", "#e5484d");
  if (["doc", "docx", "rtf", "odt"].includes(ext) || mime.includes("word")) return pick("doc", "DOC", "#2f6fed");
  if (ext === "csv" || ext === "tsv" || mime === "text/csv") return pick("csv", ext === "tsv" ? "TSV" : "CSV", "#1a9e5b");
  if (["xls", "xlsx", "ods"].includes(ext) || mime.includes("sheet") || mime.includes("excel"))
    return pick("sheet", "XLS", "#1a9e5b");
  if (["ppt", "pptx", "ppsx", "odp"].includes(ext) || mime.includes("presentation") || mime.includes("powerpoint"))
    return pick("slides", "PPT", "#e8590c");
  if (["zip", "rar", "7z", "tar", "gz"].includes(ext) || mime.includes("zip") || mime.includes("compressed"))
    return pick("archive", "ZIP", "#a16207");
  if (IMAGE_EXTS.includes(ext) || mime.startsWith("image/")) return pick("image", "IMG", "#8b5cf6");
  if (["mp4", "mov", "avi", "mkv", "webm"].includes(ext) || mime.startsWith("video/"))
    return pick("video", "VID", "#db2777");
  if (["mp3", "wav", "flac", "aac", "ogg", "m4a"].includes(ext) || mime.startsWith("audio/"))
    return pick("audio", "AUD", "#0891b2");
  if (["txt", "md", "log", "json", "xml", "ics", "eml"].includes(ext) || mime.startsWith("text/"))
    return pick("text", ext && ext.length <= 4 ? ext.toUpperCase() : "TXT", "#64748b");
  return pick("other", ext ? ext.slice(0, 4).toUpperCase() : "FILE", "#64748b");
}
