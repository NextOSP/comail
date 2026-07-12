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
