import { useState } from "react";
import type { Address } from "../../ipc/types";
import { addressName, hueOf, initials } from "../../lib/format";
import { useSenderAvatar } from "../../queries/hooks";

/**
 * Round sender avatar: tinted initials, optionally overlaid with the sender's
 * picture. The backend resolves that once per sender (Gravatar, then the
 * company's BIMI brand logo, then its site icon) and caches it on disk.
 */
export function Avatar({
  address,
  size,
  photo = false,
  className = "",
}: {
  address: Address;
  /** Diameter in px; the initials scale with it. */
  size: number;
  /** Look up a picture for the sender (network on first sight, then cached). */
  photo?: boolean;
  className?: string;
}) {
  const hue = hueOf(address.email);
  const { data: src } = useSenderAvatar(address.email, photo);
  const [failed, setFailed] = useState<string | null>(null);
  const showImg = src != null && failed !== src;

  return (
    <span
      className={`relative flex shrink-0 items-center justify-center overflow-hidden rounded-full font-semibold ${className}`}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.36),
        background: `color-mix(in srgb, hsl(${hue} 45% 55%) 22%, var(--bg2))`,
        color: `hsl(${hue} 32% 42%)`,
      }}
      title={addressName(address)}
    >
      {initials(address)}
      {showImg && (
        <img
          src={src}
          alt=""
          draggable={false}
          className="absolute inset-0 size-full bg-white object-cover"
          onError={() => setFailed(src)}
        />
      )}
    </span>
  );
}
