import type { AttachmentMeta } from "../../../ipc/types";
import { fileKind } from "../../../lib/fileKind";
import { useAttachmentPreview } from "../../../queries/hooks";
import { FileBadge } from "./common";

/** Images above this aren't fetched just to draw a thumbnail. */
const THUMB_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Square tile for an attachment: a real thumbnail for images (via the same
 * cached safe-preview payload the viewer uses), the colored type badge
 * otherwise or while the image is loading.
 */
export function AttachmentThumb({ attachment, size }: { attachment: AttachmentMeta; size: number }) {
  const kind = fileKind(attachment.filename, attachment.mimeType);
  const wantsImage = kind.family === "image" && (attachment.size ?? 0) <= THUMB_MAX_BYTES;
  const { data } = useAttachmentPreview(attachment.id, wantsImage);
  if (wantsImage && data?.kind === "image") {
    return (
      <span
        className="co-checker block shrink-0 overflow-hidden rounded-lg"
        style={{ width: size, height: size, boxShadow: "inset 0 0 0 1px var(--hairline)" }}
      >
        <img src={data.dataUri} alt="" draggable={false} className="h-full w-full object-cover" />
      </span>
    );
  }
  return <FileBadge kind={kind} size={size} />;
}
