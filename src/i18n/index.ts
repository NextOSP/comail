// i18n bootstrap. Import once from main.tsx before rendering <App/>.
//
// Locales are auto-discovered from ./locales/<lng>/*.json at build time - no
// per-language wiring here. English is bundled eagerly for instant first paint;
// every other language is code-split and fetched on demand the first time it's
// selected, so the initial download stays flat no matter how many languages
// exist. Adding a language = drop a ./locales/<code>/ folder (mirroring en/),
// add its endonym in SettingsPanel's LANGUAGE_NAMES, and a tray_labels arm in
// src-tauri/src/lib.rs. Nothing in this file changes.

import i18n from "i18next";
import { initReactI18next } from "react-i18next";

type Catalog = Record<string, unknown>;

// English: bundled into the main chunk (default language, needed immediately).
const EN_FILES = import.meta.glob("./locales/en/*.json", {
  eager: true,
  import: "default",
}) as Record<string, Catalog>;

// Every non-English locale as a lazy loader: path -> () => Promise<catalog>.
// Used both to enumerate available languages and to fetch a language's chunk on
// demand. English is excluded - it's already bundled eagerly above.
const LOCALE_LOADERS = import.meta.glob(["./locales/*/*.json", "!./locales/en/*.json"], {
  import: "default",
}) as Record<string, () => Promise<Catalog>>;

/** "./locales/es/common.json" -> "common" */
const nsOf = (path: string) => path.slice(path.lastIndexOf("/") + 1, -".json".length);
/** "./locales/es/common.json" -> "es" */
const lngOf = (path: string) => path.split("/")[2];

const buildBundle = (entries: [string, Catalog][]): Record<string, Catalog> => {
  const bundle: Record<string, Catalog> = {};
  for (const [path, catalog] of entries) bundle[nsOf(path)] = catalog;
  return bundle;
};

const enBundle = buildBundle(Object.entries(EN_FILES));

/** Language codes the UI can switch to - English plus every locale folder. */
export const SUPPORTED_LANGUAGES = Array.from(
  new Set(["en", ...Object.keys(LOCALE_LOADERS).map(lngOf)]),
).sort();
export type LanguageCode = string;

/** Persisted "language" setting value that follows the OS/browser locale. */
export const SYSTEM_LANGUAGE = "system" as const;

const NAMESPACES = Object.keys(enBundle);

/** Resolve a persisted setting ("system" | a code) to a concrete i18next lng. */
export function resolveLanguage(setting: string | null | undefined): string {
  if (!setting || setting === SYSTEM_LANGUAGE) {
    const nav = typeof navigator !== "undefined" ? navigator.language : "en";
    const base = (nav ?? "en").split("-")[0];
    return SUPPORTED_LANGUAGES.includes(base) ? base : "en";
  }
  return SUPPORTED_LANGUAGES.includes(setting) ? setting : "en";
}

const initPromise = i18n.use(initReactI18next).init({
  resources: { en: enBundle },
  lng: "en",
  fallbackLng: "en",
  ns: NAMESPACES,
  defaultNS: "common",
  interpolation: { escapeValue: false }, // React already escapes
  returnNull: false,
});

const loaded = new Set<string>(["en"]);

/** Fetch and register a language's catalogs (idempotent). */
async function loadLanguage(lng: string): Promise<void> {
  if (loaded.has(lng)) return;
  const entries = await Promise.all(
    Object.entries(LOCALE_LOADERS)
      .filter(([path]) => lngOf(path) === lng)
      .map(async ([path, load]) => [path, await load()] as [string, Catalog]),
  );
  for (const [path, catalog] of entries) {
    i18n.addResourceBundle(lng, nsOf(path), catalog, true, true);
  }
  loaded.add(lng);
}

/** Switch the active language. Pass a setting value ("system" or a code). */
export async function setLanguage(setting: string | null | undefined): Promise<void> {
  const lng = resolveLanguage(setting);
  await loadLanguage(lng);
  await i18n.changeLanguage(lng);
}

// Apply the OS/browser-resolved language once init settles; a later
// settings-driven setLanguage() call refines this to the persisted choice.
void initPromise.then(() => setLanguage(SYSTEM_LANGUAGE));

export default i18n;
