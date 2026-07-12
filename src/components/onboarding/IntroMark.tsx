import iconUrl from "../../../src-tauri/icons/128x128@2x.png";

/**
 * The real Comail app icon (the glowing planet), shown on arrival in the
 * first-run intro. Imported straight from the Tauri icon set so it always
 * matches the shipped app icon - no hand-drawn stand-in.
 */
export function IntroMark({ className }: { className?: string }) {
  return (
    <img
      src={iconUrl}
      alt=""
      aria-hidden
      draggable={false}
      className={className}
      style={{ objectFit: "contain" }}
    />
  );
}
