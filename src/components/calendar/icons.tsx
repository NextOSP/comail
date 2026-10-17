import { Icon, type IconName } from "../ui/Icon";

/** Calendar alias for the app-wide icon set (components/ui/Icon). */
export type CalIconName = IconName;

export function CalIcon({ name, size = 14 }: { name: CalIconName; size?: number }) {
  return <Icon name={name} size={size} />;
}
