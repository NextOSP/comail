# Translation status

`en` is the source of truth. Other locales mirror its namespaces exactly
(same keys, same `{{interpolation}}` placeholders and HTML tags).

| Locale | Language | Status |
|--------|----------|--------|
| `en`   | English  | Source |
| `es`   | Español  | Machine-translated - pending native review |
| `fr`   | Français | Machine-translated - pending native review |
| `zh`   | 中文 (简体) | Machine-translated - pending native review |
| `vi`   | Tiếng Việt | Machine-translated - pending native review |

## Adding / updating

- Add a language: create `locales/<code>/` mirroring `en/`, register it in
  `src/i18n/index.ts` (imports + `resources` + `SUPPORTED_LANGUAGES`), add its
  endonym to `LANGUAGE_NAMES` in `SettingsPanel.tsx`, and a `tray_labels` arm in
  `src-tauri/src/lib.rs`.
- When an `en` key changes, update every locale's matching key. Missing keys
  fall back to English automatically (i18next `fallbackLng: "en"`).
- `zh` and `vi` have no plural forms: their `_one`/`_other` variants are identical.

## Glossary: Split inbox

Use one name for the feature and one word for a tab, everywhere (Settings,
tab bar, palette commands, popover, tips). Don't mix in "group"/"division".

| Locale | Feature name | One tab |
|--------|--------------|---------|
| `en`   | Split inbox | split / tab |
| `es`   | Bandeja dividida | pestaña |
| `fr`   | Boîte de réception scindée | onglet |
| `vi`   | Hộp thư chia tab | tab |
| `zh`   | 分栏收件箱 | 分栏 |

Rule descriptions join value lists with `Intl.ListFormat` (see
`SplitsPanel.tsx`), so translations take the already-joined `{{senders}}` etc.
`splits.routesTo` carries the arrow so RTL locales can flip it.
