import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import i18n, {
  setLanguage,
  SUPPORTED_LANGUAGES,
  SYSTEM_LANGUAGE,
} from "../../i18n";
import { call } from "../../ipc/commands";
import { errorMessage } from "../../ipc/errors";
import { appVersion, checkForUpdate } from "../../ipc/updater";
import { HEATMAP_OPACITY, heatmapLevel } from "../../lib/heatmap";
import { useInstallUpdate } from "../../lib/useInstallUpdate";
import type {
  AiTier,
  Settings,
  SyncBackgroundPhase,
  SyncState,
  SyncStatus,
} from "../../ipc/types";
import { normalizeSyncStatus } from "../../lib/syncStatus";
import { inboxTabOrder } from "../../lib/splitOrder";
import { queryClient } from "../../queries/client";
import {
  useAccounts,
  useAiModels,
  useAiStatus,
  useAiUsage,
  useEmailStats,
  useEmbeddingStatus,
  useLabels,
  useLearnVoice,
  useSettings,
  useSplits,
} from "../../queries/hooks";
import { commandScore } from "../../keyboard/commandScore";
import { useUi, type SettingsTab } from "../../stores/ui";
import { AccountsSection } from "./AccountsSettings";
import { CalendarSettings } from "./CalendarSettings";
import { SignaturesSection } from "./SignaturesSettings";
import { InboxUiPicker } from "./InboxUiPicker";
import { LabelsSection } from "./LabelsPanel";
import { McpSection } from "./McpSettings";
import {
  ACCENT_PRESETS,
  accentHex,
  DEFAULT_ACCENT,
  isCustomAccent,
} from "../../lib/accent";
import { FONT_PRESETS, normalizeFontFamily } from "../../lib/font";
import { splitModelTags, tagsFor, toggleModelTag } from "../../lib/modelTags";
import { SnippetsSection } from "./SnippetsPanel";
import { SplitInboxSection } from "./SplitsPanel";
import { CategoriesEditor } from "./CategoriesEditor";
import { DecisionSettings } from "./DecisionSettings";
import { RulesEditor } from "./RulesEditor";
import { AiBadge } from "../ui/Ai";
import { Icon } from "../ui/Icon";
import {
  Button,
  Checkbox,
  EmptyState,
  inputCls,
  PageHeader,
  PanelShell,
  SectionLabel,
  Segmented,
  Select,
  SettingRow,
  SettingsGroup,
  Toggle,
} from "./panelKit";

/** Endonyms for the language picker - a language is named in its own language. */
const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  es: "Español",
  fr: "Français",
  zh: "中文",
  vi: "Tiếng Việt",
};

const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  accentColor: DEFAULT_ACCENT,
  fontFamily: "",
  language: "system",
  calendarWeekStart: "monday",
  inboxUi: "classic",
  showSenderPhotos: true,
  showBundles: true,
  undoSendSeconds: 10,
  loadRemoteImages: false,
  aiBaseUrl: "",
  aiModel: "",
  aiModelInstant: "",
  aiModelCheap: "",
  aiModelIntelligent: "",
  aiTierAsk: "intelligent",
  aiTierDraft: "intelligent",
  aiTierSummarize: "instant",
  aiTierVoice: "cheap",
  googleClientId: "",
  googleClientSecret: "",
  msClientId: "",
  msClientSecret: "",
  embeddingBackend: "local",
  embeddingModel: "bge-small-en-v1.5",
  voiceDrafting: false,
  voiceProfile: "",
  voiceLearnedAt: 0,
  meetingNotifyLeadMinutes: 10,
  notificationsEnabled: true,
  notificationScope: "important",
  notificationTabs: [],
  soundEnabled: true,
  copyVerificationCodes: true,
  autoAdvance: true,
  selectAdvance: true,
  autoLabelsEnabled: true,
  aiCategorize: false,
  aiCategoryPrompt: "",
  aiAutomationRules: [],
  decisionProvider: "off",
  decisionBaseUrl: "",
  decisionFormat: "openrouter",
  decisionModel: "",
  decisionMinConfidence: 0.6,
  decisionBackups: [],
  decisionUseCategories: true,
  decisionUseRules: true,
  decisionUseSplits: true,
  decisionChatFallback: true,
  aiCategoryDescriptions: {},
  mcpEnabled: false,
  mcpPort: 47823,
  mcpAllowDrafts: true,
  mcpAllowSend: false,
  mcpAllowActions: false,
  mcpInstructions: "",
  aiTierCategorize: "instant",
  groupByDate: true,
  contactSuggestAllAccounts: false,
  dockBadgeEnabled: true,
  dockBadgeSource: "inbox",
  signatures: {},
  signatureList: [],
  signatureDefaults: {},
  accountThemes: {},
  showAccountBadges: true,
  accountColors: {},
  accountShortNames: {},
};

/** Optimistic settings write: cache first, backend follows, rollback on error. */
export async function updateSettings(patch: Partial<Settings>): Promise<boolean> {
  const cur =
    queryClient.getQueryData<Settings>(["settings"]) ?? DEFAULT_SETTINGS;
  const next: Settings = { ...cur, ...patch };
  queryClient.setQueryData(["settings"], next);
  if (patch.theme) useUi.getState().set({ theme: patch.theme });
  try {
    await call("set_settings", { settings: next });
    return true;
  } catch (err) {
    useUi.getState().pushToast({
      kind: "error",
      message: i18n.t("settings:toast.settingsSaveFailed", {
        detail: errorMessage(err),
      }),
    });
    void queryClient.invalidateQueries({ queryKey: ["settings"] });
    return false;
  }
}

function SettingsNavIcon({ tab }: { tab: SettingsTab }) {
  if (tab === "ai") return <Icon name="sparkle" size={18} className="co-ai-icon" />;
  const paths: Record<Exclude<SettingsTab, "ai">, React.ReactNode> = {
    appearance: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor" stroke="none" />
      </>
    ),
    notifications: (
      <>
        <path d="M6 9a6 6 0 0 1 12 0c0 5 2 6.5 2 6.5H4S6 14 6 9" />
        <path d="M10 19a2 2 0 0 0 4 0" />
      </>
    ),
    reading: (
      <>
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="M3 7l9 6 9-6" />
      </>
    ),
    compose: (
      <>
        <path d="M4 20h4L19 9l-4-4L4 16z" />
        <path d="M13 7l4 4" />
      </>
    ),
    calendar: (
      <>
        <rect x="3" y="5" width="18" height="16" rx="2" />
        <path d="M3 10h18M8 3v4M16 3v4" />
      </>
    ),
    about: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 11v5M12 8h.01" />
      </>
    ),
    stats: (
      <>
        <path d="M4 20V10M10 20V4M16 20v-7M22 20V7" />
        <path d="M2 20h22" />
      </>
    ),
    splits: (
      <>
        <rect x="3" y="4" width="7" height="16" rx="2" />
        <rect x="14" y="4" width="7" height="7" rx="2" />
        <rect x="14" y="15" width="7" height="5" rx="2" />
      </>
    ),
    snippets: (
      <>
        <path d="M6 3h9l4 4v14H6z" />
        <path d="M14 3v5h5M9 12h6M9 16h6" />
      </>
    ),
    labels: (
      <>
        <path d="M3 12V5a2 2 0 0 1 2-2h7l9 9-9 9z" />
        <circle cx="8" cy="8" r="1.5" />
      </>
    ),
    ai_automation: (
      <>
        <path d="M5 4v5M5 15v5M19 4v5M19 15v5M5 12h14" />
        <circle cx="5" cy="12" r="3" />
        <circle cx="19" cy="12" r="3" />
      </>
    ),
    mcp: (
      <>
        <rect x="3" y="4" width="18" height="12" rx="2" />
        <path d="M7 9l2 1.5L7 12M11 12h4M9 20h6M12 16v4" />
      </>
    ),
    rag: (
      <>
        <ellipse cx="10" cy="6" rx="6" ry="3" />
        <path d="M4 6v7c0 1.7 2.7 3 6 3 1 0 2-.1 2.8-.4M16 6v4" />
        <circle cx="17" cy="16" r="4" />
        <path d="M20 19l2 2" />
      </>
    ),
    accounts: (
      <>
        <circle cx="9" cy="8" r="3" />
        <path d="M3.5 20a5.5 5.5 0 0 1 11 0" />
        <circle cx="17" cy="9" r="2.5" />
        <path d="M15.5 15.5A5 5 0 0 1 21 20" />
      </>
    ),
    sync: (
      <>
        <path d="M20 7h-5V2" />
        <path d="M19 7a8 8 0 0 0-13.5-2L4 7" />
        <path d="M4 17h5v5" />
        <path d="M5 17a8 8 0 0 0 13.5 2L20 17" />
      </>
    ),
  };
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[tab]}
    </svg>
  );
}

export function SettingsPanel() {
  const { t } = useTranslation();
  const open = useUi((s) => s.panel === "settings");
  const requestedTab = useUi((s) => s.settingsTab);
  const set = useUi((s) => s.set);
  const { data: settings } = useSettings();
  const { data: splits } = useSplits();
  const { data: labels } = useLabels();
  const [tab, setTab] = useState<SettingsTab>("appearance");
  const [query, setQuery] = useState("");

  const TAB_KEYS: SettingsTab[] = [
    "appearance",
    "notifications",
    "reading",
    "compose",
    "calendar",
    "splits",
    "snippets",
    "labels",
    "ai",
    "ai_automation",
    "rag",
    "mcp",
    "accounts",
    "sync",
    "stats",
    "about",
  ];

  // Adopt a requested tab (sidebar chevron, "Split inbox rules" row, palette).
  useEffect(() => {
    if (open && requestedTab) {
      if ((TAB_KEYS as string[]).includes(requestedTab)) {
        setTab(requestedTab as SettingsTab);
        setQuery("");
      }
      set({ settingsTab: null });
    }
    // TAB_KEYS is a stable literal; excluded intentionally.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, requestedTab, set]);

  if (!open) return null;
  const s = settings ?? DEFAULT_SETTINGS;

  // The inbox tabs a "specific tabs" notification scope can pick from, keyed by
  // the same route keys the backend stores in `threads.routed_tab`.
  const notifyTabOptions = inboxTabOrder(
    splits,
    labels,
    s.autoLabelsEnabled !== false,
  ).map((item) => {
    if (item.kind === "important")
      return { key: "important", name: t("inbox:split.important") };
    if (item.kind === "other")
      return { key: "other", name: t("inbox:split.other") };
    if (item.kind === "split")
      return { key: `split:${item.id}`, name: item.name };
    return { key: `label:${item.id}`, name: item.name };
  });
  const toggleNotifyTab = (key: string, on: boolean) => {
    const next = on
      ? [...s.notificationTabs, key]
      : s.notificationTabs.filter((k) => k !== key);
    void updateSettings({ notificationTabs: next });
  };

  // Jump to a tab and drop out of search mode.
  const goTab = (next: SettingsTab) => {
    setTab(next);
    setQuery("");
  };

  const TAB_LABELS: Record<SettingsTab, string> = {
    appearance: t("settings:section.appearance"),
    notifications: t("settings:section.notifications"),
    reading: t("settings:section.reading"),
    compose: t("settings:section.compose"),
    calendar: t("settings:section.calendar"),
    stats: t("settings:section.stats"),
    splits: t("settings:section.splitInbox"),
    snippets: t("settings:section.snippets"),
    labels: t("settings:section.labels"),
    ai: t("settings:section.ai"),
    ai_automation: t("settings:section.aiAutomation"),
    rag: t("settings:section.ragSearch"),
    mcp: t("settings:section.mcp"),
    accounts: t("settings:section.accounts"),
    sync: t("settings:section.sync"),
    about: t("settings:section.about"),
  };

  const TAB_GROUPS: { label: string; tabs: SettingsTab[] }[] = [
    {
      label: t("settings:navigation.general"),
      tabs: ["appearance", "notifications", "reading", "compose", "calendar"],
    },
    {
      label: t("settings:navigation.organization"),
      tabs: ["splits", "snippets", "labels"],
    },
    {
      label: t("settings:navigation.intelligence"),
      tabs: ["ai", "ai_automation", "rag", "mcp"],
    },
    {
      label: t("settings:navigation.system"),
      tabs: ["accounts", "sync", "stats", "about"],
    },
  ];

  // Flat index of every setting, so search can jump straight to its tab.
  // `label` is localized (matches localized queries); `keywords` add English synonyms.
  const INDEX: { tab: SettingsTab; label: string; keywords: string }[] = [
    {
      tab: "mcp",
      label: t("settings:section.mcp"),
      keywords:
        "mcp model context protocol claude code desktop chatgpt cursor vscode copilot windsurf codex gemini zed lm studio agent integration connector",
    },
    {
      tab: "stats",
      label: t("settings:section.stats"),
      keywords:
        "statistics analytics activity sent received email heatmap volume",
    },
    {
      tab: "appearance",
      label: t("settings:theme.label"),
      keywords: "appearance dark light snow carbon color",
    },
    {
      tab: "appearance",
      label: t("settings:accent.label"),
      keywords: "accent color colour highlight brand tint",
    },
    {
      tab: "notifications",
      label: t("settings:sound.label"),
      keywords: "sound chime audio new mail",
    },
    {
      tab: "notifications",
      label: t("settings:verificationCodes.label"),
      keywords: "verification code otp 2fa copy clipboard",
    },
    {
      tab: "reading",
      label: t("settings:selectAdvance.label"),
      keywords: "select advance next selection",
    },
    {
      tab: "calendar",
      label: t("settings:meetingReminder.label"),
      keywords: "meeting reminder event notify minutes before",
    },
    {
      tab: "calendar",
      label: t("settings:calendar.section"),
      keywords: "calendar google outlook connect events",
    },
    {
      tab: "appearance",
      label: t("settings:language.label"),
      keywords: "locale translation",
    },
    {
      tab: "calendar",
      label: t("settings:calendarWeekStart.label"),
      keywords: "calendar week start first day sunday monday",
    },
    {
      tab: "compose",
      label: t("settings:undoSend.label"),
      keywords: "undo send delay cancel",
    },
    {
      tab: "reading",
      label: t("settings:loadRemoteImages.label"),
      keywords: "images privacy tracking pixels remote",
    },
    {
      tab: "notifications",
      label: t("settings:notifications.label"),
      keywords:
        "notify alerts desktop scope important all tabs split inbox spam",
    },
    {
      tab: "notifications",
      label: t("settings:dockBadge.label"),
      keywords: "dock badge unread count icon red important",
    },
    {
      tab: "reading",
      label: t("settings:autoAdvance.label"),
      keywords: "auto advance next thread cursor",
    },
    {
      tab: "appearance",
      label: t("settings:inboxUi.label"),
      keywords: "inbox ui layout style avatar classic list rows look design view",
    },
    {
      tab: "appearance",
      label: t("settings:showSenderPhotos.label"),
      keywords: "sender photos avatars gravatar pictures logos brand bimi company icons",
    },
    {
      tab: "appearance",
      label: t("settings:groupByDate.label"),
      keywords: "group date today yesterday timeline headers sections",
    },
    {
      tab: "compose",
      label: t("settings:contactSuggestAllAccounts.label"),
      keywords:
        "contacts autocomplete suggestions recipients to account domain all",
    },
    {
      tab: "splits",
      label: t("settings:autoLabels.label"),
      keywords: "auto labels categorize",
    },
    {
      tab: "splits",
      label: t("settings:section.splitInbox"),
      keywords: "split inbox tabs rules important other sender subject",
    },
    {
      tab: "snippets",
      label: t("settings:snippets.title"),
      keywords: "snippets templates canned responses shortcuts",
    },
    {
      tab: "labels",
      label: t("settings:labels.title"),
      keywords: "labels tags colors folders",
    },
    {
      tab: "ai",
      label: t("settings:section.ai"),
      keywords: "ai provider model api key openai anthropic openrouter",
    },
    {
      tab: "ai",
      label: t("settings:decision.section"),
      keywords: "decision model jev typesafe openai decisions confidence classify",
    },
    {
      tab: "ai_automation",
      label: t("settings:section.aiAutomation"),
      keywords: "ai automation rules condition sort actions labels trash subject decision",
    },
    {
      tab: "rag",
      label: t("settings:section.ragSearch"),
      keywords: "rag semantic search embeddings vector meaning offline reindex",
    },
    {
      tab: "ai",
      label: t("settings:voice.section"),
      keywords: "voice draft style learn tone",
    },
    {
      tab: "accounts",
      label: t("settings:section.accounts"),
      keywords:
        "accounts add remove gmail microsoft imap oauth color short name theme",
    },
    {
      tab: "compose",
      label: t("settings:signature.section"),
      keywords: "signature sign-off footer",
    },
    {
      tab: "accounts",
      label: t("settings:section.oauthApps"),
      keywords: "oauth client id secret google microsoft app credentials",
    },
    {
      tab: "sync",
      label: t("settings:section.sync"),
      keywords: "sync synchronize refresh check mail inbox status progress",
    },
    {
      tab: "sync",
      label: t("settings:sync.background"),
      keywords:
        "background cache caching history headers content indexing failed retry",
    },
    {
      tab: "about",
      label: t("settings:about.section"),
      keywords: "about version update upgrade release check",
    },
  ];

  const q = query.trim();
  const results =
    q === ""
      ? []
      : INDEX.map((e) => ({
          e,
          score: commandScore(`${e.label} ${e.keywords}`, q),
        }))
          .filter((r) => r.score > 0)
          .sort((a, b) => b.score - a.score)
          .map((r) => r.e);

  const sideNav = (
    <nav className="flex flex-col" aria-label={t("settings:title")}>
      {TAB_GROUPS.map((group, groupIndex) => (
        <section
          key={group.label}
          className={
            groupIndex === 0 ? "pb-2" : "border-t border-hairline py-2"
          }
        >
          <h3 className="mb-1 px-3 text-2xs font-semibold tracking-[0.13em] text-ink-faint uppercase">
            {group.label}
          </h3>
          <div className="flex flex-col gap-0.5">
            {group.tabs.map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => goTab(k)}
                aria-current={tab === k && q === "" ? "page" : undefined}
                className={`group flex w-full items-center gap-2.5 rounded-control px-3 py-1.5 text-left text-base transition-colors ${
                  tab === k && q === ""
                    ? "bg-accent/10 font-medium text-accent"
                    : "text-ink-muted hover:bg-bg2 hover:text-ink"
                }`}
              >
                <span
                  className={`flex size-6 shrink-0 items-center justify-center rounded-control ${
                    tab === k && q === ""
                      ? "bg-accent/10"
                      : "bg-bg1 group-hover:bg-bg0"
                  }`}
                >
                  <SettingsNavIcon tab={k} />
                </span>
                <span className="truncate">{TAB_LABELS[k]}</span>
              </button>
            ))}
          </div>
        </section>
      ))}
    </nav>
  );

  const search = (
    <input
      className={`${inputCls} !w-[280px] !py-1.5`}
      placeholder={t("settings:search.placeholder")}
      value={query}
      onChange={(e) => setQuery(e.target.value)}
      spellCheck={false}
      aria-label={t("settings:search.placeholder")}
    />
  );

  if (q !== "") {
    return (
      <PanelShell
        title={t("settings:title")}
        onClose={() => set({ panel: null })}
        sidebar={sideNav}
        search={search}
        width={940}
      >
        {results.length === 0 ? (
          <p className="py-6 text-center text-base text-ink-faint">
            {t("settings:search.noResults", { query: q })}
          </p>
        ) : (
          <div className="flex flex-col gap-1">
            {results.map((e, i) => (
              <button
                key={`${e.tab}-${i}`}
                onClick={() => goTab(e.tab)}
                className="flex items-center justify-between gap-3 rounded-control px-3 py-2 text-left hover:bg-bg2"
              >
                <span className="text-base text-ink">{e.label}</span>
                <span className="shrink-0 rounded bg-bg2 px-1.5 py-px text-2xs font-semibold tracking-wide text-ink-faint uppercase">
                  {TAB_LABELS[e.tab]}
                </span>
              </button>
            ))}
          </div>
        )}
      </PanelShell>
    );
  }

  return (
    <PanelShell
      title={t("settings:title")}
      onClose={() => set({ panel: null })}
      sidebar={sideNav}
      search={search}
      width={940}
    >
      <PageHeader
        title={TAB_LABELS[tab]}
        description={
          tab === "stats"
            ? t("settings:stats.intro")
            : tab === "sync"
              ? t("settings:sync.intro")
              : t(`settings:page.${tab}`)
        }
        badge={tab === "ai" || tab === "ai_automation" || tab === "rag" ? <AiBadge /> : undefined}
      />
      <div>
        {tab === "appearance" && (
          <>
            <SettingsGroup title={t("settings:groups.theme")}>
            <SettingRow
              label={t("settings:theme.label")}
              hint={t("settings:theme.hint")}
            >
              <Segmented
                value={s.theme}
                options={[
                  { value: "snow", label: t("settings:theme.snow") },
                  { value: "carbon", label: t("settings:theme.carbon") },
                  { value: "system", label: t("settings:theme.system") },
                ]}
                onChange={(theme) => void updateSettings({ theme })}
              />
            </SettingRow>
            <SettingRow
              label={t("settings:accent.label")}
              hint={t("settings:accent.hint")}
            >
              <AccentPicker
                value={s.accentColor ?? DEFAULT_ACCENT}
                onChange={(accentColor) => void updateSettings({ accentColor })}
              />
            </SettingRow>
            </SettingsGroup>
            <SettingsGroup title={t("settings:groups.font")}>
              <FontPicker
                value={s.fontFamily ?? ""}
                onChange={(fontFamily) => void updateSettings({ fontFamily })}
              />
            </SettingsGroup>
            <SettingsGroup title={t("settings:groups.inboxLayout")}>
            <InboxUiPicker
              value={s.inboxUi}
              onChange={(inboxUi) => void updateSettings({ inboxUi })}
            />
            {s.inboxUi === "avatar" && (
              <SettingRow
                label={t("settings:showSenderPhotos.label")}
                hint={t("settings:showSenderPhotos.hint")}
              >
                <Toggle
                  label={t("settings:showSenderPhotos.label")}
                  checked={s.showSenderPhotos}
                  onChange={(showSenderPhotos) =>
                    void updateSettings({ showSenderPhotos })
                  }
                />
              </SettingRow>
            )}
            {s.inboxUi === "avatar" && (
              <SettingRow
                label={t("settings:showBundles.label")}
                hint={t("settings:showBundles.hint")}
              >
                <Toggle
                  label={t("settings:showBundles.label")}
                  checked={s.showBundles}
                  onChange={(showBundles) => void updateSettings({ showBundles })}
                />
              </SettingRow>
            )}
            <SettingRow
              label={t("settings:groupByDate.label")}
              hint={t("settings:groupByDate.hint")}
            >
              <Toggle
                label={t("settings:groupByDate.label")}
                checked={s.groupByDate}
                onChange={(groupByDate) => void updateSettings({ groupByDate })}
              />
            </SettingRow>
            </SettingsGroup>
            <SettingsGroup title={t("settings:groups.language")}>
            <SettingRow
              label={t("settings:language.label")}
              hint={t("settings:language.hint")}
            >
              <Select
                value={s.language}
                onChange={(e) => {
                  setLanguage(e.target.value);
                  void updateSettings({ language: e.target.value });
                }}
                className="!w-[200px]"
              >
                <option value={SYSTEM_LANGUAGE}>
                  {t("settings:language.system")}
                </option>
                {SUPPORTED_LANGUAGES.map((code) => (
                  <option key={code} value={code}>
                    {LANGUAGE_NAMES[code] ?? code}
                  </option>
                ))}
              </Select>
            </SettingRow>
            </SettingsGroup>
          </>
        )}

        {tab === "notifications" && (
          <>
            <SettingsGroup title={t("settings:groups.alerts")}>
            <SettingRow
              label={t("settings:notifications.label")}
              hint={t("settings:notifications.hint")}
            >
              <Toggle
                label={t("settings:notifications.label")}
                checked={s.notificationsEnabled}
                onChange={(notificationsEnabled) =>
                  void updateSettings({ notificationsEnabled })
                }
              />
            </SettingRow>
            {s.notificationsEnabled && (
              <SettingRow
                label={t("settings:notificationScope.label")}
                hint={t("settings:notificationScope.hint")}
              >
                <div className="flex flex-col items-end gap-2">
                  <Segmented
                    value={s.notificationScope}
                    options={[
                      {
                        value: "important" as const,
                        label: t("settings:notificationScope.important"),
                      },
                      {
                        value: "all" as const,
                        label: t("settings:notificationScope.all"),
                      },
                      {
                        value: "tabs" as const,
                        label: t("settings:notificationScope.tabs"),
                      },
                    ]}
                    onChange={(notificationScope) =>
                      void updateSettings({ notificationScope })
                    }
                  />
                  {s.notificationScope === "tabs" && (
                    <div className="flex flex-col items-end gap-1.5 pt-1">
                      {notifyTabOptions.map((opt) => (
                        <Checkbox
                          key={opt.key}
                          label={opt.name}
                          checked={s.notificationTabs.includes(opt.key)}
                          onChange={(on) => toggleNotifyTab(opt.key, on)}
                        />
                      ))}
                      {notifyTabOptions.length === 0 && (
                        <span className="text-sm text-ink-muted">
                          {t("settings:notificationScope.noTabs")}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </SettingRow>
            )}
            <SettingRow
              label={t("settings:sound.label")}
              hint={t("settings:sound.hint")}
            >
              <Toggle
                label={t("settings:sound.label")}
                checked={s.soundEnabled}
                onChange={(soundEnabled) =>
                  void updateSettings({ soundEnabled })
                }
              />
            </SettingRow>
            <SettingRow
              label={t("settings:verificationCodes.label")}
              hint={t("settings:verificationCodes.hint")}
            >
              <Toggle
                label={t("settings:verificationCodes.label")}
                checked={s.copyVerificationCodes}
                onChange={(copyVerificationCodes) =>
                  void updateSettings({ copyVerificationCodes })
                }
              />
            </SettingRow>
            </SettingsGroup>
            <SettingsGroup title={t("settings:groups.dockBadge")}>
            <SettingRow
              label={t("settings:dockBadge.label")}
              hint={t("settings:dockBadge.hint")}
            >
              <Toggle
                label={t("settings:dockBadge.label")}
                checked={s.dockBadgeEnabled}
                onChange={(dockBadgeEnabled) =>
                  void updateSettings({ dockBadgeEnabled })
                }
              />
            </SettingRow>
            {s.dockBadgeEnabled && (
              <SettingRow
                label={t("settings:dockBadgeSource.label")}
                hint={t("settings:dockBadgeSource.hint")}
              >
                <Segmented
                  value={s.dockBadgeSource}
                  options={[
                    {
                      value: "inbox" as const,
                      label: t("settings:dockBadgeSource.all"),
                    },
                    {
                      value: "important" as const,
                      label: t("settings:dockBadgeSource.important"),
                    },
                  ]}
                  onChange={(dockBadgeSource) =>
                    void updateSettings({ dockBadgeSource })
                  }
                />
              </SettingRow>
            )}
            </SettingsGroup>
          </>
        )}

        {tab === "reading" && (
          <SettingsGroup title={t("settings:groups.reading")}>
            <SettingRow
              label={t("settings:loadRemoteImages.label")}
              hint={t("settings:loadRemoteImages.hint")}
            >
              <Toggle
                label={t("settings:loadRemoteImages.label")}
                checked={s.loadRemoteImages}
                onChange={(loadRemoteImages) =>
                  void updateSettings({ loadRemoteImages })
                }
              />
            </SettingRow>
            <SettingRow
              label={t("settings:autoAdvance.label")}
              hint={t("settings:autoAdvance.hint")}
            >
              <Toggle
                label={t("settings:autoAdvance.label")}
                checked={s.autoAdvance}
                onChange={(autoAdvance) => void updateSettings({ autoAdvance })}
              />
            </SettingRow>
            <SettingRow
              label={t("settings:selectAdvance.label")}
              hint={t("settings:selectAdvance.hint")}
            >
              <Toggle
                label={t("settings:selectAdvance.label")}
                checked={s.selectAdvance}
                onChange={(selectAdvance) =>
                  void updateSettings({ selectAdvance })
                }
              />
            </SettingRow>
          </SettingsGroup>
        )}

        {tab === "compose" && (
          <>
            <SettingsGroup title={t("settings:groups.sending")}>
            <SettingRow
              label={t("settings:undoSend.label")}
              hint={t("settings:undoSend.hint")}
            >
              <Segmented
                value={s.undoSendSeconds}
                options={[5, 10, 20, 30].map((n) => ({
                  value: n,
                  label: t("settings:undoSend.seconds", { n }),
                }))}
                onChange={(undoSendSeconds) =>
                  void updateSettings({ undoSendSeconds })
                }
              />
            </SettingRow>
            <SettingRow
              label={t("settings:contactSuggestAllAccounts.label")}
              hint={t("settings:contactSuggestAllAccounts.hint")}
            >
              <Toggle
                label={t("settings:contactSuggestAllAccounts.label")}
                checked={s.contactSuggestAllAccounts}
                onChange={(contactSuggestAllAccounts) =>
                  void updateSettings({ contactSuggestAllAccounts })
                }
              />
            </SettingRow>
            </SettingsGroup>
            <SignaturesSection settings={s} />
          </>
        )}

        {tab === "calendar" && (
          <>
            <SettingsGroup title={t("settings:groups.calendarView")}>
            <SettingRow
              label={t("settings:calendarWeekStart.label")}
              hint={t("settings:calendarWeekStart.hint")}
            >
              <Segmented
                value={s.calendarWeekStart}
                options={(["sunday", "monday"] as const).map((day) => ({
                  value: day,
                  label: t(`settings:calendarWeekStart.${day}`),
                }))}
                onChange={(calendarWeekStart) =>
                  void updateSettings({ calendarWeekStart })
                }
              />
            </SettingRow>
            <SettingRow
              label={t("settings:meetingReminder.label")}
              hint={t("settings:meetingReminder.hint")}
            >
              <Select
                className="!w-[180px]"
                value={s.meetingNotifyLeadMinutes}
                onChange={(e) =>
                  void updateSettings({
                    meetingNotifyLeadMinutes: Number(e.target.value),
                  })
                }
              >
                <option value={0}>{t("settings:meetingReminder.off")}</option>
                {[5, 10, 15, 30].map((m) => (
                  <option key={m} value={m}>
                    {t("settings:meetingReminder.minutes", { count: m })}
                  </option>
                ))}
              </Select>
            </SettingRow>
            </SettingsGroup>
            <CalendarSettings />
          </>
        )}

        {tab === "about" && <AboutSection />}

        {tab === "stats" && <EmailStatsDashboard />}

        {tab === "splits" && (
          <>
            <SettingsGroup>
              <SettingRow
                label={t("settings:autoLabels.label")}
                hint={t("settings:autoLabels.hint")}
              >
                <Toggle
                  label={t("settings:autoLabels.label")}
                  checked={s.autoLabelsEnabled}
                  onChange={(autoLabelsEnabled) =>
                    void updateSettings({ autoLabelsEnabled })
                  }
                />
              </SettingRow>
            </SettingsGroup>
            <SplitInboxSection />
          </>
        )}

        {tab === "snippets" && <SnippetsSection />}

        {tab === "labels" && (
          <LabelsSection
            settings={s}
            commitRules={(aiAutomationRules) =>
              void updateSettings({ aiAutomationRules })
            }
          />
        )}

        {tab === "ai" && (
          <>
            <VoiceSection settings={s} />
            <AiSection settings={s} page="models" />
            <AiUsageDashboard />
          </>
        )}

        {tab === "ai_automation" && (
          <AiSection settings={s} page="automation" />
        )}

        {tab === "rag" && <SemanticSearchSection settings={s} />}

        {tab === "mcp" && <McpSection settings={s} />}

        {tab === "accounts" && (
          <>
            <AccountsSection />
            <OAuthSection settings={s} />
          </>
        )}

        {tab === "sync" && <SyncSection />}
      </div>
    </PanelShell>
  );
}

/** Accent swatches (each previews its color under the active theme), plus a
 *  rainbow swatch that opens the system color picker for any custom color. */
function AccentPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (key: string) => void;
}) {
  const { t } = useTranslation();
  const resolved = document.documentElement.dataset.theme ?? "snow";
  const custom = isCustomAccent(value);
  // The native picker fires on every drag step; preview live through the
  // accent variable and persist once (on change end / blur), not per step.
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => {
    if (draft == null) return;
    document.documentElement.style.setProperty("--accent", accentHex(draft, resolved));
    const id = setTimeout(() => {
      onChange(draft.toLowerCase());
      setDraft(null);
    }, 400);
    return () => clearTimeout(id);
  }, [draft, resolved, onChange]);
  const commit = () => {
    if (draft != null) {
      onChange(draft.toLowerCase());
      setDraft(null);
    }
  };
  return (
    <div className="flex items-center gap-1.5" role="radiogroup" aria-label={t("settings:accent.label")}>
      {ACCENT_PRESETS.map((p) => {
        const selected = p.key === value;
        const name = t(`settings:accent.colors.${p.key}`);
        return (
          <button
            key={p.key}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={name}
            title={name}
            onClick={() => onChange(p.key)}
            className={`flex size-6 items-center justify-center rounded-full transition-transform hover:scale-110 ${
              selected ? "ring-2 ring-offset-2 ring-offset-bg1" : ""
            }`}
            style={{
              background: accentHex(p.key, resolved),
              ["--tw-ring-color" as string]: accentHex(p.key, resolved),
            }}
          >
            {selected && <Icon name="check" size={12} className="text-on-accent" />}
          </button>
        );
      })}
      <span className="mx-1 h-5 w-px bg-hairline" aria-hidden="true" />
      <label
        title={t("settings:accent.custom")}
        className={`relative flex size-6 cursor-pointer items-center justify-center rounded-full transition-transform hover:scale-110 ${
          custom ? "ring-2 ring-offset-2 ring-offset-bg1" : ""
        }`}
        style={{
          background: custom
            ? accentHex(value, resolved)
            : "conic-gradient(#e5484d, #f5a524, #46a758, #12a5b0, #3e63dd, #8e4ec6, #e5484d)",
          ["--tw-ring-color" as string]: custom ? accentHex(value, resolved) : undefined,
        }}
      >
        {custom ? (
          <Icon name="check" size={12} className="text-on-accent" />
        ) : (
          <span className="size-2.5 rounded-full bg-bg1" />
        )}
        <input
          type="color"
          aria-label={t("settings:accent.custom")}
          className="absolute inset-0 cursor-pointer opacity-0"
          value={custom ? value : accentHex(value, "snow")}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
        />
      </label>
      {custom && (
        <span className="ml-1 font-mono text-xs text-ink-faint uppercase tabular-nums">
          {value}
        </span>
      )}
    </div>
  );
}

/** Curated font cards (each previewed in its own face) plus any Google Font by name. */
function FontPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (family: string) => void;
}) {
  const { t } = useTranslation();
  const isPreset = (FONT_PRESETS as readonly string[]).includes(value);
  const [custom, setCustom] = useState(isPreset ? "" : value);

  // Preload the preset faces so each card previews in its own font.
  useEffect(() => {
    const id = "comail-font-previews";
    if (document.getElementById(id)) return;
    const families = FONT_PRESETS.filter(Boolean)
      .map((f) => `family=${encodeURIComponent(f).replace(/%20/g, "+")}:wght@400;600`)
      .join("&");
    const link = document.createElement("link");
    link.id = id;
    link.rel = "stylesheet";
    link.href = `https://fonts.googleapis.com/css2?${families}&display=swap`;
    document.head.appendChild(link);
  }, []);

  const applyCustom = () => {
    const name = normalizeFontFamily(custom);
    setCustom(name);
    if (name && name !== value) onChange(name);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="text-xs text-ink-faint">{t("settings:font.hint")}</div>
      <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label={t("settings:groups.font")}>
        {FONT_PRESETS.map((family) => {
          const selected = family === value;
          const name = family || t("settings:font.system");
          return (
            <button
              key={family || "system"}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => {
                setCustom("");
                onChange(family);
              }}
              className={`flex flex-col items-start gap-0.5 rounded-control border px-3 py-2 text-left transition-colors ${
                selected
                  ? "border-accent bg-accent/10"
                  : "border-hairline hover:bg-bg2"
              }`}
              style={family ? { fontFamily: `"${family}", var(--font-sans)` } : undefined}
            >
              <span className="text-lg font-semibold text-ink">Aa</span>
              <span className={`truncate text-sm ${selected ? "text-accent" : "text-ink-muted"}`}>
                {name}
              </span>
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-2">
        <input
          className={`${inputCls} min-w-0 flex-1 ${!isPreset ? "!border-accent/60" : ""}`}
          placeholder={t("settings:font.customPlaceholder")}
          aria-label={t("settings:font.custom")}
          value={custom}
          spellCheck={false}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") applyCustom();
          }}
        />
        <Button
          size="sm"
          disabled={!normalizeFontFamily(custom) || normalizeFontFamily(custom) === value}
          onClick={applyCustom}
        >
          {t("settings:font.apply")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void openUrl("https://fonts.google.com")}
        >
          {t("settings:font.browse")}
        </Button>
      </div>
    </div>
  );
}

/** Sentinel base URL the core routes to Apple's on-device model. */
const APPLE_AI_BASE_URL = "apple://intelligence";

const isAppleAi = (baseUrl: string) =>
  baseUrl.trim().toLowerCase().startsWith("apple:");

/** Known OpenAI-compatible providers; picking one fills the base URL. */
const AI_PROVIDER_PRESETS: {
  id: string;
  label: string;
  baseUrl: string;
  defaultModel?: string;
}[] = [
  {
    id: "apple",
    label: "Apple Intelligence (on-device)",
    baseUrl: APPLE_AI_BASE_URL,
    defaultModel: "apple-intelligence",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "openai/gpt-6-luna",
  },
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    baseUrl: "https://api.anthropic.com/v1",
    defaultModel: "claude-sonnet-5-5",
  },
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-6-luna",
  },
  {
    id: "lmstudio",
    label: "LM Studio (local)",
    baseUrl: "http://localhost:1234/v1",
  },
  {
    id: "ollama",
    label: "Ollama (local)",
    baseUrl: "http://localhost:11434/v1",
  },
  {
    id: "minimax",
    label: "MiniMax",
    baseUrl: "https://api.minimax.io/v1",
    defaultModel: "MiniMax-M3",
  },
  {
    id: "kimi",
    label: "Kimi (Moonshot)",
    baseUrl: "https://api.moonshot.ai/v1",
    defaultModel: "kimi-k3",
  },
  {
    id: "zai",
    label: "Z.ai (GLM)",
    baseUrl: "https://api.z.ai/api/paas/v4",
    defaultModel: "glm-5.3",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-v4.1-flash",
  },
  {
    id: "gemini",
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    defaultModel: "gemini-flash-latest",
  },
  {
    id: "mistral",
    label: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    defaultModel: "mistral-large-latest",
  },
  {
    id: "qwen",
    label: "Alibaba Qwen (multilingual)",
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    defaultModel: "qwen-plus",
  },
  {
    id: "groq",
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "openai/gpt-oss-120b",
  },
];

/** Version readout plus a manual "check for updates" against GitHub Releases. */
function AboutSection() {
  const { t } = useTranslation();
  const pushToast = useUi((s) => s.pushToast);
  const install = useInstallUpdate();
  const [version, setVersion] = useState("");
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    void appVersion().then(setVersion);
  }, []);

  async function onCheck() {
    setChecking(true);
    try {
      const update = await checkForUpdate();
      if (update) {
        pushToast({
          kind: "info",
          message: t("settings:about.updateAvailable", {
            version: update.version,
          }),
          actionLabel: t("settings:about.restartInstall"),
          onAction: () => install(update),
          durationMs: 30000,
        });
      } else {
        pushToast({
          kind: "info",
          message: t("settings:about.upToDate"),
          durationMs: 3000,
        });
      }
    } catch (err) {
      pushToast({ kind: "error", message: errorMessage(err) });
    } finally {
      setChecking(false);
    }
  }

  async function onOpenLogs() {
    try {
      await call("open_logs_dir", {});
    } catch (err) {
      pushToast({ kind: "error", message: errorMessage(err) });
    }
  }

  return (
    <SettingsGroup title={t("settings:about.section")}>
      <SettingRow
        label={t("settings:about.version")}
        hint={t("settings:about.versionHint")}
      >
        <div className="flex items-center gap-3">
          <span className="text-base tabular-nums text-ink-muted">
            {version || "…"}
          </span>
          <Button size="sm" busy={checking} onClick={() => void onCheck()}>
            {checking ? t("settings:about.checking") : t("settings:about.checkUpdates")}
          </Button>
        </div>
      </SettingRow>
      <SettingRow
        label={t("settings:about.logs")}
        hint={t("settings:about.logsHint")}
      >
        <Button size="sm" onClick={() => void onOpenLogs()}>
          {t("settings:about.openLogs")}
        </Button>
      </SettingRow>
    </SettingsGroup>
  );
}

const AI_TIERS: AiTier[] = ["instant", "cheap", "intelligent"];

/** A model-id field for one tier. Empty means "fall back to the default model". */
function TierModelField({
  label,
  hint,
  value,
  baseUrl,
  placeholder,
  onCommit,
}: {
  label: string;
  hint: string;
  value: string;
  baseUrl: string;
  placeholder: string;
  onCommit: (v: string) => Promise<boolean>;
}) {
  return (
    <SettingRow label={label} hint={hint}>
      <ModelInput value={value} baseUrl={baseUrl} placeholder={placeholder} onCommit={onCommit} />
    </SettingRow>
  );
}

/** Model-id input sharing the global `ai-model-options` datalist. Commits on
 *  blur / Enter, and right away when a listed model is picked (a datalist pick
 *  fires no blur, so closing Settings would otherwise drop it). Flashes
 *  "Saved" once the write lands. */
function ModelInput({
  value,
  baseUrl,
  placeholder,
  onCommit,
}: {
  value: string;
  baseUrl: string;
  placeholder: string;
  onCommit: (v: string) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [v, setV] = useState(value);
  const [saved, setSaved] = useState(false);
  const savedTimer = useRef<number | undefined>(undefined);
  useEffect(() => setV(value), [value]);
  useEffect(() => () => window.clearTimeout(savedTimer.current), []);
  const commit = (next: string) => {
    void onCommit(next).then((ok) => {
      if (!ok) return;
      setSaved(true);
      window.clearTimeout(savedTimer.current);
      savedTimer.current = window.setTimeout(() => setSaved(false), 1800);
    });
  };
  const listed = (id: string) =>
    Array.from(
      document.querySelectorAll<HTMLOptionElement>("#ai-model-options option"),
    ).some((o) => o.value === id);
  return (
    <>
      <ModelTagChips
        model={v}
        baseUrl={baseUrl}
        onChange={(next) => {
          setV(next);
          commit(next);
        }}
      />
      <div className="relative">
        <input
          value={v}
          onChange={(e) => {
            setV(e.target.value);
            if (listed(e.target.value)) commit(e.target.value);
          }}
          onBlur={() => commit(v.trim())}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit(v.trim());
          }}
          placeholder={placeholder}
          spellCheck={false}
          list="ai-model-options"
          className={`${inputCls} !w-[280px]`}
        />
        <span
          aria-live="polite"
          className={`pointer-events-none absolute top-full right-0 mt-0.5 flex items-center gap-1 text-2xs text-accent transition-opacity duration-300 ${
            saved ? "opacity-100" : "opacity-0"
          }`}
        >
          <Icon name="check" size={11} />
          {t("settings:saved")}
        </span>
      </div>
    </>
  );
}

/** Toggle chips for the `:tag` suffixes the endpoint understands (see
 *  `lib/modelTags`); hidden when there are none or no model id yet. */
function ModelTagChips({
  model,
  baseUrl,
  onChange,
}: {
  model: string;
  baseUrl: string;
  onChange: (model: string) => void;
}) {
  const { t } = useTranslation();
  const offered = tagsFor(baseUrl);
  const [base, active] = splitModelTags(model.trim());
  if (offered.length === 0 || !base) return null;
  return (
    <div className="mb-1.5 flex justify-end gap-1">
      {offered.map((tag) => {
        const on = active.includes(tag);
        return (
          <button
            key={tag}
            type="button"
            aria-pressed={on}
            title={t(`settings:ai.modelTag.${tag}`)}
            onClick={() => onChange(toggleModelTag(model, tag))}
            className={`rounded-full border px-2 py-0.5 font-mono text-2xs transition-colors ${
              on
                ? "border-transparent bg-accent/15 text-accent"
                : "border-hairline text-ink-faint hover:bg-bg2"
            }`}
          >
            :{tag}
          </button>
        );
      })}
    </div>
  );
}

/** Dropdown routing one AI scenario to a model tier. */
function ScenarioRouteRow({
  label,
  hint,
  value,
  onChange,
  tierLabel,
}: {
  label: string;
  hint: string;
  value: AiTier;
  onChange: (v: AiTier) => void;
  tierLabel: (t: AiTier) => string;
}) {
  return (
    <SettingRow label={label} hint={hint}>
      <Select
        value={value}
        onChange={(e) => onChange(e.target.value as AiTier)}
        className="!w-[180px]"
      >
        {AI_TIERS.map((tier) => (
          <option key={tier} value={tier}>
            {tierLabel(tier)}
          </option>
        ))}
      </Select>
    </SettingRow>
  );
}

function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function formatMetricCount(value: number): string {
  return new Intl.NumberFormat(i18n.language, {
    notation: value >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(value);
}

/** Sent/received totals and a daily activity grid over the last year. */
function EmailStatsDashboard() {
  const { t } = useTranslation();
  const { data: stats } = useEmailStats();
  const [metric, setMetric] = useState<"all" | "sent" | "received">("all");
  const dayByDate = new Map((stats?.days ?? []).map((day) => [day.date, day]));
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - start.getDay() - 51 * 7);
  const heatmapDays: Date[] = [];
  for (
    const cursor = new Date(start);
    cursor <= today;
    cursor.setDate(cursor.getDate() + 1)
  ) {
    heatmapDays.push(new Date(cursor));
  }
  const countFor = (sent: number, received: number) =>
    metric === "sent"
      ? sent
      : metric === "received"
        ? received
        : sent + received;
  const activityCounts = Array.from(dayByDate.values(), (day) =>
    countFor(day.sent, day.received),
  );
  const heatColor =
    metric === "sent"
      ? "var(--ok)"
      : metric === "received"
        ? "var(--info)"
        : "var(--accent)";
  const summaries = [
    { label: t("settings:stats.totalSent"), value: stats?.totalSent ?? 0 },
    {
      label: t("settings:stats.totalReceived"),
      value: stats?.totalReceived ?? 0,
    },
    { label: t("settings:stats.todaySent"), value: stats?.todaySent ?? 0 },
    {
      label: t("settings:stats.todayReceived"),
      value: stats?.todayReceived ?? 0,
    },
    {
      label: t("settings:stats.last7Sent"),
      value: stats?.last7DaysSent ?? 0,
    },
    {
      label: t("settings:stats.last7Received"),
      value: stats?.last7DaysReceived ?? 0,
    },
    {
      label: t("settings:stats.last30Sent"),
      value: stats?.last30DaysSent ?? 0,
    },
    {
      label: t("settings:stats.last30Received"),
      value: stats?.last30DaysReceived ?? 0,
    },
  ];

  return (
    <section className="flex flex-col gap-3">
      <div className="grid grid-cols-4 gap-2">
        {summaries.map((summary) => (
          <div
            key={summary.label}
            className="rounded-card border border-hairline bg-bg1 px-3 py-2.5"
          >
            <div className="truncate text-2xs font-medium text-ink-faint">
              {summary.label}
            </div>
            <div
              className="mt-1 truncate text-lg font-semibold tabular-nums tracking-tight text-ink"
              title={summary.value.toLocaleString(i18n.language)}
            >
              {formatMetricCount(summary.value)}
            </div>
          </div>
        ))}
      </div>

      <div className="rounded-card border border-hairline bg-bg1 px-3.5 py-3">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-medium text-ink-muted">
              {t("settings:stats.activity")}
            </div>
            <div className="mt-0.5 text-2xs text-ink-faint">
              {t("settings:stats.recent")}
            </div>
          </div>
          <Segmented
            value={metric}
            options={[
              { value: "all", label: t("settings:stats.all") },
              { value: "sent", label: t("settings:stats.sent") },
              { value: "received", label: t("settings:stats.received") },
            ]}
            onChange={setMetric}
          />
        </div>
        <div className="flex items-stretch gap-2">
          <div className="grid shrink-0 grid-rows-7 items-center gap-[3px] text-[9px] leading-[10px] text-ink-faint">
            <span />
            <span>{t("settings:ai.usage.monday")}</span>
            <span />
            <span>{t("settings:ai.usage.wednesday")}</span>
            <span />
            <span>{t("settings:ai.usage.friday")}</span>
            <span />
          </div>
          <div
            className="grid flex-1 gap-[3px]"
            style={{
              gridAutoFlow: "column",
              gridTemplateRows: "repeat(7, auto)",
              gridAutoColumns: "minmax(0, 1fr)",
            }}
            aria-label={t("settings:stats.activity")}
          >
            {heatmapDays.map((date) => {
              const key = localDateKey(date);
              const day = dayByDate.get(key);
              const sent = day?.sent ?? 0;
              const received = day?.received ?? 0;
              const count = countFor(sent, received);
              const level = heatmapLevel(count, activityCounts);
              const title = t("settings:stats.dayTitle", {
                date: date.toLocaleDateString(i18n.language, {
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                }),
                sent: sent.toLocaleString(i18n.language),
                received: received.toLocaleString(i18n.language),
              });
              return (
                <span
                  key={key}
                  className="aspect-square w-full rounded-[2px] ring-1 ring-inset ring-hairline"
                  style={
                    level > 0
                      ? {
                          background: heatColor,
                          opacity: HEATMAP_OPACITY[level],
                        }
                      : { background: "transparent" }
                  }
                  title={title}
                  aria-label={title}
                />
              );
            })}
          </div>
        </div>
        <div className="mt-2 flex items-center justify-end gap-1 text-2xs text-ink-faint">
          <span>{t("settings:ai.usage.less")}</span>
          {HEATMAP_OPACITY.map((opacity, index) => (
            <span
              key={index}
              className="size-2.5 rounded-[2px] ring-1 ring-inset ring-hairline"
              style={
                index === 0
                  ? { background: "transparent" }
                  : { background: heatColor, opacity }
              }
            />
          ))}
          <span>{t("settings:ai.usage.more")}</span>
        </div>
      </div>
    </section>
  );
}

/** Token totals and a GitHub-style daily activity grid for recent AI requests. */
function AiUsageDashboard() {
  const { t } = useTranslation();
  const { data: usage } = useAiUsage();
  const dayByDate = new Map((usage?.days ?? []).map((day) => [day.date, day]));
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  // A full year of weeks (GitHub-style) so the grid fills the card width instead
  // of a narrow 13-week strip stranded on the left of a wide panel.
  start.setDate(start.getDate() - start.getDay() - 51 * 7);
  const heatmapDays: Date[] = [];
  for (
    const cursor = new Date(start);
    cursor <= today;
    cursor.setDate(cursor.getDate() + 1)
  ) {
    heatmapDays.push(new Date(cursor));
  }
  const activityTokens = Array.from(
    dayByDate.values(),
    (day) => day.totalTokens,
  );
  const summaries = [
    { label: t("settings:ai.usage.total"), value: usage?.totalTokens ?? 0 },
    { label: t("settings:ai.usage.today"), value: usage?.todayTokens ?? 0 },
    {
      label: t("settings:ai.usage.yesterday"),
      value: usage?.yesterdayTokens ?? 0,
    },
    { label: t("settings:ai.usage.last7"), value: usage?.last7DaysTokens ?? 0 },
    {
      label: t("settings:ai.usage.last30"),
      value: usage?.last30DaysTokens ?? 0,
    },
  ];

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-end justify-between gap-4">
        <div>
          <SectionLabel className="!mb-0">{t("settings:ai.usage.section")}</SectionLabel>
          <p className="mt-1 text-xs leading-relaxed text-ink-faint">
            {t("settings:ai.usage.intro")}
          </p>
        </div>
        <span className="shrink-0 text-xs tabular-nums text-ink-faint">
          {t("settings:ai.usage.requests", {
            count: usage?.totalRequests ?? 0,
          })}
        </span>
      </div>

      <div className="grid grid-cols-5 gap-2">
        {summaries.map((summary) => (
          <div
            key={summary.label}
            className="rounded-card border border-hairline bg-bg1 px-3 py-2.5"
          >
            <div className="truncate text-2xs font-medium text-ink-faint">
              {summary.label}
            </div>
            <div
              className="mt-1 truncate text-lg font-semibold tabular-nums tracking-tight text-ink"
              title={(summary.value ?? 0).toLocaleString(i18n.language)}
            >
              {formatMetricCount(summary.value)}
            </div>
          </div>
        ))}
      </div>

      <div className="rounded-card border border-hairline bg-bg1 px-3.5 py-3">
        <div className="mb-3 flex items-center justify-between gap-3">
          <span className="text-sm font-medium text-ink-muted">
            {t("settings:ai.usage.activity")}
          </span>
          <span className="text-2xs text-ink-faint">
            {t("settings:ai.usage.recent")}
          </span>
        </div>
        <div className="flex items-stretch gap-2">
          <div className="grid shrink-0 grid-rows-7 items-center gap-[3px] text-[9px] leading-[10px] text-ink-faint">
            <span />
            <span>{t("settings:ai.usage.monday")}</span>
            <span />
            <span>{t("settings:ai.usage.wednesday")}</span>
            <span />
            <span>{t("settings:ai.usage.friday")}</span>
            <span />
          </div>
          <div
            className="grid flex-1 gap-[3px]"
            style={{
              gridAutoFlow: "column",
              gridTemplateRows: "repeat(7, auto)",
              gridAutoColumns: "minmax(0, 1fr)",
            }}
            aria-label={t("settings:ai.usage.activity")}
          >
            {heatmapDays.map((date) => {
              const key = localDateKey(date);
              const day = dayByDate.get(key);
              const tokens = day?.totalTokens ?? 0;
              const level = heatmapLevel(tokens, activityTokens);
              const title = t("settings:ai.usage.dayTitle", {
                date: date.toLocaleDateString(i18n.language, {
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                }),
                tokens: tokens.toLocaleString(i18n.language),
                requests: day?.requests ?? 0,
              });
              return (
                <span
                  key={key}
                  className="aspect-square w-full rounded-[2px] ring-1 ring-inset ring-hairline"
                  style={
                    level > 0
                      ? {
                          background: "var(--accent)",
                          opacity: HEATMAP_OPACITY[level],
                        }
                      : { background: "transparent" }
                  }
                  title={title}
                  aria-label={title}
                />
              );
            })}
          </div>
        </div>
        <div className="mt-2 flex items-center justify-end gap-1 text-2xs text-ink-faint">
          <span>{t("settings:ai.usage.less")}</span>
          {HEATMAP_OPACITY.map((opacity, index) => (
            <span
              key={index}
              className="size-2.5 rounded-[2px] ring-1 ring-inset ring-hairline"
              style={
                index === 0
                  ? { background: "transparent" }
                  : { background: "var(--accent)", opacity }
              }
            />
          ))}
          <span>{t("settings:ai.usage.more")}</span>
        </div>
      </div>
    </section>
  );
}

function AiSection({
  settings,
  page,
}: {
  settings: Settings;
  page: "models" | "automation";
}) {
  const { t } = useTranslation();
  const { data: status } = useAiStatus();
  const pushToast = useUi((s) => s.pushToast);
  const [apiKey, setApiKey] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const [baseUrl, setBaseUrl] = useState(settings.aiBaseUrl);
  const [model, setModel] = useState(settings.aiModel);
  const [forceCustom, setForceCustom] = useState(false);
  const [categoryPrompt, setCategoryPrompt] = useState(
    settings.aiCategoryPrompt,
  );
  const [resorting, setResorting] = useState(false);
  const baseUrlRef = useRef<HTMLInputElement>(null);
  const { data: models, error: modelsError } = useAiModels(settings.aiBaseUrl);
  const onDevice = isAppleAi(settings.aiBaseUrl);
  const appleState = status?.appleIntelligence ?? "unsupported";
  // Only offer Apple Intelligence on Macs that could run it (or if it's
  // already selected, so the picker never shows a blank choice).
  const presets = AI_PROVIDER_PRESETS.filter(
    (p) => p.id !== "apple" || onDevice || appleState !== "unsupported",
  );

  // Follow external settings refreshes (initial load, other writers).
  useEffect(() => setBaseUrl(settings.aiBaseUrl), [settings.aiBaseUrl]);
  useEffect(() => setModel(settings.aiModel), [settings.aiModel]);
  useEffect(
    () => setCategoryPrompt(settings.aiCategoryPrompt),
    [settings.aiCategoryPrompt],
  );

  const resort = async () => {
    if (resorting) return;
    setResorting(true);
    try {
      const n = await call("reroute_all", {});
      pushToast({
        kind: "info",
        message: t("settings:ai.resorted", { count: n }),
        durationMs: 2500,
      });
      void queryClient.invalidateQueries({ queryKey: ["threads"] });
      void queryClient.invalidateQueries({ queryKey: ["unreadCounts"] });
      void queryClient.invalidateQueries({ queryKey: ["labels"] });
    } catch (err) {
      pushToast({ kind: "error", message: errorMessage(err) });
    } finally {
      setResorting(false);
    }
  };

  const saveKey = async () => {
    setSavingKey(true);
    try {
      await call("set_ai_key", { apiKey: apiKey.trim() });
      pushToast({
        kind: "info",
        message: apiKey.trim()
          ? t("settings:ai.keySaved")
          : t("settings:ai.keyCleared"),
        durationMs: 2500,
      });
      setApiKey("");
      void queryClient.invalidateQueries({ queryKey: ["aiStatus"] });
      // The list fetched before the key existed was refused; load it again.
      void queryClient.invalidateQueries({ queryKey: ["aiModels"] });
    } catch (err) {
      pushToast({
        kind: "error",
        message: errorMessage(err),
      });
    } finally {
      setSavingKey(false);
    }
  };

  const commitField = (patch: Partial<Settings>): Promise<boolean> => {
    const key = Object.keys(patch)[0] as keyof Settings;
    if (patch[key] === settings[key]) return Promise.resolve(false);
    return updateSettings(patch);
  };

  return (
    <section>
      {page === "models" ? (
        <>
          <SettingsGroup title={t("settings:groups.models")}>
          <SettingRow
            label={t("settings:ai.statusLabel")}
            hint={t("settings:ai.statusHint")}
          >
            <span className="flex items-center gap-2 text-sm text-ink-muted">
              <span
                className="size-2 rounded-full"
                style={{
                  background: status?.configured ? "var(--ok)" : "var(--bg4)",
                }}
              />
              {status
                ? status.configured
                  ? onDevice
                    ? t("settings:ai.appleReady")
                    : t("settings:ai.configured", { model: status.model })
                  : onDevice
                    ? t(`settings:ai.appleState.${appleState}`)
                    : t("settings:ai.notConfigured")
                : t("settings:ai.loading")}
            </span>
          </SettingRow>
          {!onDevice && (
            <SettingRow
              label={t("settings:ai.apiKeyLabel")}
              hint={t("settings:ai.apiKeyHint")}
            >
              <div className="flex items-center gap-2">
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void saveKey();
                  }}
                  placeholder={t("settings:ai.apiKeyPlaceholder")}
                  autoComplete="off"
                  className={`${inputCls} !w-[220px]`}
                />
                <Button
                  variant="primary"
                  busy={savingKey}
                  onClick={() => void saveKey()}
                >
                  {t("settings:ai.save")}
                </Button>
              </div>
            </SettingRow>
          )}
          <SettingRow
            label={t("settings:ai.providerLabel")}
            hint={
              onDevice
                ? t("settings:ai.appleProviderHint")
                : t("settings:ai.providerHint")
            }
          >
            <Select
              value={
                forceCustom
                  ? "custom"
                  : onDevice
                    ? "apple"
                    : (AI_PROVIDER_PRESETS.find(
                        (p) => p.baseUrl === settings.aiBaseUrl,
                      )?.id ?? "custom")
              }
              onChange={(e) => {
                if (e.target.value === "custom") {
                  // Keep whatever URL is set and hand focus to the field below
                  // (the on-device sentinel isn't a URL anyone wants to edit).
                  if (onDevice) void updateSettings({ aiBaseUrl: "" });
                  setForceCustom(true);
                  baseUrlRef.current?.focus();
                  baseUrlRef.current?.select();
                  return;
                }
                const preset = AI_PROVIDER_PRESETS.find(
                  (p) => p.id === e.target.value,
                );
                if (!preset) return;
                setForceCustom(false);
                void updateSettings({
                  aiBaseUrl: preset.baseUrl,
                  ...(preset.defaultModel
                    ? { aiModel: preset.defaultModel }
                    : {}),
                });
              }}
              className="!w-[280px]"
            >
              {presets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
              <option value="custom">{t("settings:ai.customProvider")}</option>
            </Select>
          </SettingRow>
          {!onDevice && (
            <>
              <SettingRow
                label={t("settings:ai.baseUrlLabel")}
                hint={t("settings:ai.baseUrlHint")}
              >
                <input
                  ref={baseUrlRef}
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  onBlur={() => commitField({ aiBaseUrl: baseUrl.trim() })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter")
                      commitField({ aiBaseUrl: baseUrl.trim() });
                  }}
                  placeholder={t("settings:ai.baseUrlPlaceholder")}
                  spellCheck={false}
                  className={`${inputCls} !w-[280px]`}
                />
              </SettingRow>
              <SettingRow
                label={t("settings:ai.modelLabel")}
                hint={
                  models && models.length > 0
                    ? t("settings:ai.modelsAvailable", { n: models.length })
                    : modelsError
                      ? t("settings:ai.modelsFailed", { error: errorMessage(modelsError) })
                      : t("settings:ai.modelHintEmpty")
                }
              >
                <ModelInput
                  value={model}
                  baseUrl={settings.aiBaseUrl}
                  placeholder={t("settings:ai.modelPlaceholder")}
                  onCommit={(v) => {
                    setModel(v);
                    return commitField({ aiModel: v });
                  }}
                />
                <datalist id="ai-model-options">
                  {(models ?? []).map((id) => (
                    <option key={id} value={id} />
                  ))}
                </datalist>
              </SettingRow>
            </>
          )}
          </SettingsGroup>
          <DecisionSettings
            settings={settings}
            update={(patch) => void updateSettings(patch)}
          />
          {!onDevice && (
            <>
              <SettingsGroup
                title={t("settings:ai.tiersSection")}
                description={t("settings:ai.tiersIntro")}
              >
              <TierModelField
                label={t("settings:ai.tier.instant")}
                hint={t("settings:ai.tierInstantHint")}
                value={settings.aiModelInstant}
                baseUrl={settings.aiBaseUrl}
                placeholder={t("settings:ai.tierFallback")}
                onCommit={(v) => commitField({ aiModelInstant: v })}
              />
              <TierModelField
                label={t("settings:ai.tier.cheap")}
                hint={t("settings:ai.tierCheapHint")}
                value={settings.aiModelCheap}
                baseUrl={settings.aiBaseUrl}
                placeholder={t("settings:ai.tierFallback")}
                onCommit={(v) => commitField({ aiModelCheap: v })}
              />
              <TierModelField
                label={t("settings:ai.tier.intelligent")}
                hint={t("settings:ai.tierIntelligentHint")}
                value={settings.aiModelIntelligent}
                baseUrl={settings.aiBaseUrl}
                placeholder={t("settings:ai.tierFallback")}
                onCommit={(v) => commitField({ aiModelIntelligent: v })}
              />
              </SettingsGroup>

              <details className="group mb-6">
                <summary className="mb-2 flex cursor-pointer list-none items-center gap-1.5 text-xs font-semibold tracking-[0.12em] text-ink-faint uppercase hover:text-ink-muted">
                  <Icon
                    name="chevronRight"
                    size={12}
                    className="transition-transform group-open:rotate-90"
                  />
                  {t("settings:groups.advanced")}
                </summary>
              <SettingsGroup
                title={t("settings:ai.routingSection")}
                description={t("settings:ai.routingIntro")}
              >
              <ScenarioRouteRow
                label={t("settings:ai.routeAsk")}
                hint={t("settings:ai.routeAskHint")}
                value={settings.aiTierAsk}
                onChange={(v) => commitField({ aiTierAsk: v })}
                tierLabel={(tier) => t(`settings:ai.tier.${tier}`)}
              />
              <ScenarioRouteRow
                label={t("settings:ai.routeDraft")}
                hint={t("settings:ai.routeDraftHint")}
                value={settings.aiTierDraft}
                onChange={(v) => commitField({ aiTierDraft: v })}
                tierLabel={(tier) => t(`settings:ai.tier.${tier}`)}
              />
              <ScenarioRouteRow
                label={t("settings:ai.routeSummarize")}
                hint={t("settings:ai.routeSummarizeHint")}
                value={settings.aiTierSummarize}
                onChange={(v) => commitField({ aiTierSummarize: v })}
                tierLabel={(tier) => t(`settings:ai.tier.${tier}`)}
              />
              <ScenarioRouteRow
                label={t("settings:ai.routeVoice")}
                hint={t("settings:ai.routeVoiceHint")}
                value={settings.aiTierVoice}
                onChange={(v) => commitField({ aiTierVoice: v })}
                tierLabel={(tier) => t(`settings:ai.tier.${tier}`)}
              />
              </SettingsGroup>
              </details>
            </>
          )}
        </>
      ) : (
        <>
          <SettingsGroup
            title={t("settings:ai.categorizeSection")}
            description={t("settings:ai.categorizeIntro")}
          >
          <SettingRow
            label={t("settings:ai.categorizeLabel")}
            hint={t("settings:ai.categorizeHint")}
          >
            <Toggle
              label={t("settings:ai.categorizeLabel")}
              checked={settings.aiCategorize}
              onChange={(aiCategorize) => void updateSettings({ aiCategorize })}
            />
          </SettingRow>
          {settings.aiCategorize && !onDevice && (
            <ScenarioRouteRow
              label={t("settings:ai.routeCategorize")}
              hint={t("settings:ai.routeCategorizeHint")}
              value={settings.aiTierCategorize}
              onChange={(v) => commitField({ aiTierCategorize: v })}
              tierLabel={(tier) => t(`settings:ai.tier.${tier}`)}
            />
          )}
          <SettingRow
            label={t("settings:ai.resortLabel")}
            hint={t("settings:ai.resortHint")}
          >
            <Button size="sm" busy={resorting} onClick={() => void resort()}>
              {resorting ? t("settings:ai.resorting") : t("settings:ai.resort")}
            </Button>
          </SettingRow>
          </SettingsGroup>
          <SettingsGroup
            title={t("settings:rules.section")}
            description={t("settings:rules.intro")}
          >
            <RulesEditor
              settings={settings}
              commit={(aiAutomationRules) =>
                void updateSettings({ aiAutomationRules })
              }
            />
          </SettingsGroup>
          {settings.aiCategorize && (
            <div className="flex flex-col gap-3">
              <SettingsGroup
                title={t("settings:categories.section")}
                description={t("settings:categories.intro")}
              >
                <div className="px-4 py-3.5">
                  <CategoriesEditor
                    settings={settings}
                    update={(patch) => void updateSettings(patch)}
                  />
                </div>
              </SettingsGroup>
              <details className="group rounded-card border border-hairline bg-bg1">
                <summary className="flex cursor-pointer list-none items-center justify-between px-3.5 py-3 text-sm font-medium text-ink-muted">
                  <span>{t("settings:ai.categoryPromptLabel")}</span>
                  <Icon
                    name="chevronDown"
                    size={14}
                    className="transition-transform group-open:rotate-180"
                  />
                </summary>
                <div className="flex flex-col gap-2 border-t border-hairline px-3.5 py-3">
                  <textarea
                    value={categoryPrompt}
                    onChange={(e) => setCategoryPrompt(e.target.value)}
                    onBlur={() => {
                      if (categoryPrompt !== settings.aiCategoryPrompt)
                        void updateSettings({
                          aiCategoryPrompt: categoryPrompt,
                        });
                    }}
                    rows={6}
                    spellCheck={false}
                    placeholder={t("settings:ai.categoryPromptPlaceholder")}
                    className={`${inputCls} w-full resize-y !text-sm leading-relaxed`}
                  />
                  <p className="text-xs text-ink-faint">
                    {t("settings:ai.categoryPromptHint")}
                  </p>
                </div>
              </details>
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** Local embedding models mirrored from the Rust `embed::registry`. */
const EMBEDDING_MODELS: { id: string; label: string }[] = [
  { id: "bge-small-en-v1.5", label: "BGE Small (384d · fast · bundled)" },
  { id: "all-MiniLM-L6-v2", label: "MiniLM L6 (384d · fast)" },
  { id: "bge-base-en-v1.5", label: "BGE Base (768d · higher quality)" },
  {
    id: "paraphrase-multilingual-MiniLM-L12-v2",
    label: "Multilingual MiniLM (384d · 50+ languages)",
  },
];

/** Semantic search: local embedding backend, model picker, index progress. */
function SemanticSearchSection({ settings }: { settings: Settings }) {
  const { t } = useTranslation();
  const { data: status } = useEmbeddingStatus();
  const pushToast = useUi((s) => s.pushToast);
  const [reindexing, setReindexing] = useState(false);
  const [clearingHistory, setClearingHistory] = useState(false);

  const on = settings.embeddingBackend === "local";

  // Search learns from the results you open; this forgets all of it.
  const clearHistory = async () => {
    setClearingHistory(true);
    try {
      await call("clear_search_history", {});
      pushToast({ kind: "info", message: t("settings:rag.historyCleared"), durationMs: 2500 });
      void queryClient.invalidateQueries({ queryKey: ["search"] });
    } catch (err) {
      pushToast({ kind: "error", message: errorMessage(err) });
    } finally {
      setClearingHistory(false);
    }
  };
  const pct =
    status && status.total > 0
      ? Math.round((status.embedded / status.total) * 100)
      : 0;

  const reindex = async () => {
    setReindexing(true);
    try {
      const n = await call("semantic_reindex", {});
      pushToast({
        kind: "info",
        message: t("settings:rag.reindexToast", { count: n }),
        durationMs: 2500,
      });
      void queryClient.invalidateQueries({ queryKey: ["embeddingStatus"] });
    } catch (err) {
      pushToast({ kind: "error", message: errorMessage(err) });
    } finally {
      setReindexing(false);
    }
  };

  return (
    <SettingsGroup>
      <SettingRow
        label={t("settings:rag.toggleLabel")}
        hint={t("settings:rag.toggleHint")}
      >
        <Toggle
          label={t("settings:rag.toggleLabel")}
          checked={on}
          onChange={(enabled) =>
            void updateSettings({ embeddingBackend: enabled ? "local" : "off" })
          }
        />
      </SettingRow>
      {on && (
        <>
          <SettingRow
            label={t("settings:rag.modelLabel")}
            hint={t("settings:rag.modelHint")}
          >
            <Select
              value={settings.embeddingModel}
              onChange={(e) =>
                void updateSettings({ embeddingModel: e.target.value })
              }
              className="!w-[280px]"
            >
              {EMBEDDING_MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </Select>
          </SettingRow>
          <SettingRow
            label={t("settings:rag.indexLabel")}
            hint={
              status
                ? status.ready
                  ? `${t("settings:rag.indexStatus", {
                      embedded: status.embedded.toLocaleString(i18n.language),
                      total: status.total.toLocaleString(i18n.language),
                    })}${
                      status.pending
                        ? ` · ${t("settings:rag.indexQueued", {
                            count: status.pending,
                            n: status.pending.toLocaleString(i18n.language),
                          })}`
                        : ""
                    }`
                  : t("settings:rag.loadingModel")
                : "…"
            }
          >
            <div className="flex items-center gap-3">
              <div className="h-1.5 w-[160px] overflow-hidden rounded-full bg-[var(--bg4)]">
                <div
                  className={`co-progress-fill h-full rounded-full bg-[var(--accent)]${
                    pct < 100 || (status?.pending ?? 0) > 0 || reindexing
                      ? " is-loading"
                      : ""
                  }`}
                  style={{ width: `${pct}%` }}
                />
              </div>
              <Button size="sm" busy={reindexing} onClick={() => void reindex()}>
                {reindexing ? t("settings:rag.rebuilding") : t("settings:rag.rebuild")}
              </Button>
            </div>
          </SettingRow>
        </>
      )}
      <SettingRow
        label={t("settings:rag.historyLabel")}
        hint={t("settings:rag.historyHint")}
      >
        <Button size="sm" busy={clearingHistory} onClick={() => void clearHistory()}>
          {t("settings:rag.historyClear")}
        </Button>
      </SettingRow>
    </SettingsGroup>
  );
}

/** Writing voice: learn a style profile from sent mail and draft in it. */
function VoiceSection({ settings }: { settings: Settings }) {
  const { t } = useTranslation();
  const pushToast = useUi((s) => s.pushToast);
  const learn = useLearnVoice();
  const [profile, setProfile] = useState(settings.voiceProfile);

  useEffect(() => setProfile(settings.voiceProfile), [settings.voiceProfile]);

  const learned = settings.voiceLearnedAt > 0;
  const runLearn = () => {
    learn.mutate(undefined, {
      onSuccess: (p) => {
        setProfile(p);
        pushToast({
          kind: "info",
          message: t("settings:voice.learnedToast"),
          durationMs: 2500,
        });
      },
      onError: (e) => pushToast({ kind: "error", message: errorMessage(e) }),
    });
  };

  return (
    <SettingsGroup title={t("settings:voice.section")}>
      <SettingRow
        label={t("settings:voice.draftLabel")}
        hint={t("settings:voice.draftHint")}
      >
        <Toggle
          label={t("settings:voice.draftLabel")}
          checked={settings.voiceDrafting}
          onChange={(voiceDrafting) => void updateSettings({ voiceDrafting })}
        />
      </SettingRow>
      <SettingRow
        label={t("settings:voice.profileLabel")}
        hint={
          learned
            ? t("settings:voice.learnedOn", {
                date: new Date(settings.voiceLearnedAt).toLocaleDateString(i18n.language),
              })
            : t("settings:voice.notLearned")
        }
      >
        <Button variant="ai" size="sm" busy={learn.isPending} onClick={runLearn}>
          {learn.isPending
            ? t("settings:voice.learning")
            : learned
              ? t("settings:voice.relearn")
              : t("settings:voice.learn")}
        </Button>
      </SettingRow>
      {(learned || profile) && (
        <div>
          <textarea
            value={profile}
            onChange={(e) => setProfile(e.target.value)}
            onBlur={() => {
              if (profile !== settings.voiceProfile)
                void updateSettings({ voiceProfile: profile });
            }}
            rows={5}
            spellCheck={false}
            placeholder={t("settings:voice.profilePlaceholder")}
            aria-label={t("settings:voice.profileLabel")}
            className={`${inputCls} w-full resize-y font-mono !text-sm leading-relaxed`}
          />
        </div>
      )}
    </SettingsGroup>
  );
}

/** One debounced-commit text field bound to a Settings key. */
function OAuthField({
  settings,
  field,
  label,
  hint,
  placeholder,
  secret,
}: {
  settings: Settings;
  field:
    "googleClientId" | "googleClientSecret" | "msClientId" | "msClientSecret";
  label: string;
  hint?: string;
  placeholder: string;
  secret?: boolean;
}) {
  const [value, setValue] = useState(settings[field]);
  useEffect(() => setValue(settings[field]), [settings, field]);

  const commit = () => {
    if (value.trim() === settings[field]) return;
    void updateSettings({ [field]: value.trim() });
  };

  return (
    <SettingRow label={label} hint={hint}>
      <input
        type={secret ? "password" : "text"}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        className={`${inputCls} !w-[280px]`}
      />
    </SettingRow>
  );
}

/** Full setup guide on GitHub; packaged builds ship no docs folder. */
const OAUTH_DOCS_URL =
  "https://github.com/NextOSP/comail/blob/master/docs/oauth-setup.md";

/** In-app setup walkthrough; packaged builds have no docs folder. */
function OAuthGuide() {
  const { t } = useTranslation();
  const open = (url: string) => {
    void openUrl(url).catch(() => window.open(url, "_blank"));
  };
  const providers = [
    {
      key: "google",
      title: t("settings:oauth.guide.googleTitle"),
      linkLabel: t("settings:oauth.guide.openGoogle"),
      url: "https://console.cloud.google.com/apis/credentials",
      steps: ["g1", "g2", "g3", "g4", "g5", "g6", "g7"],
      note: undefined as string | undefined,
    },
    {
      key: "ms",
      title: t("settings:oauth.guide.msTitle"),
      linkLabel: t("settings:oauth.guide.openMs"),
      url: "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
      steps: ["m1", "m2", "m3", "m4", "m5", "m6"],
      note: t("settings:oauth.guide.msNote"),
    },
  ];
  return (
    <details>
      <summary className="cursor-pointer text-sm font-medium text-ink-muted select-none">
        {t("settings:oauth.guide.title")}
      </summary>
      <div className="mt-3 flex flex-col gap-4 text-sm leading-relaxed text-ink-muted">
        {providers.map((p) => (
          <div key={p.key}>
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <span className="font-semibold text-ink">{p.title}</span>
              <Button size="sm" onClick={() => open(p.url)}>
                {p.linkLabel}
              </Button>
            </div>
            <ol className="flex list-decimal flex-col gap-1 pl-5">
              {p.steps.map((k) => (
                <li key={k}>{t(`settings:oauth.guide.${k}`)}</li>
              ))}
            </ol>
            {p.note && (
              <p className="mt-2 rounded-control bg-bg2 px-2.5 py-1.5 text-xs text-ink-faint">
                {p.note}
              </p>
            )}
          </div>
        ))}
        <div className="flex items-center justify-between gap-2 border-t border-hairline pt-3">
          <span className="text-xs text-ink-faint">
            {t("settings:oauth.guide.docsHint")}
          </span>
          <Button size="sm" onClick={() => open(OAUTH_DOCS_URL)}>
            {t("settings:oauth.guide.viewDocs")}
          </Button>
        </div>
      </div>
    </details>
  );
}

function OAuthSection({ settings }: { settings: Settings }) {
  const { t } = useTranslation();
  return (
    <SettingsGroup
      title={t("settings:section.oauthApps")}
      description={
        <Trans
          i18nKey="settings:oauth.description"
          components={{ b: <b />, code: <code /> }}
        />
      }
    >
      <OAuthGuide />
      <OAuthField
        settings={settings}
        field="googleClientId"
        label={t("settings:oauth.googleClientIdLabel")}
        placeholder={t("settings:oauth.googleClientIdPlaceholder")}
      />
      <OAuthField
        settings={settings}
        field="googleClientSecret"
        label={t("settings:oauth.googleClientSecretLabel")}
        hint={t("settings:oauth.googleClientSecretHint")}
        placeholder={t("settings:oauth.googleClientSecretPlaceholder")}
        secret
      />
      <OAuthField
        settings={settings}
        field="msClientId"
        label={t("settings:oauth.msClientIdLabel")}
        hint={t("settings:oauth.msClientIdHint")}
        placeholder={t("settings:oauth.msClientIdPlaceholder")}
      />
      <OAuthField
        settings={settings}
        field="msClientSecret"
        label={t("settings:oauth.msClientSecretLabel")}
        hint={t("settings:oauth.msClientSecretHint")}
        placeholder={t("settings:oauth.msClientSecretPlaceholder")}
        secret
      />
    </SettingsGroup>
  );
}

const SYNC_DOT: Record<SyncState, string> = {
  idle: "var(--ok)",
  syncing: "var(--info)",
  error: "var(--danger)",
  needs_reauth: "var(--danger)",
  offline: "var(--bg4)",
};

function SyncSection() {
  const { t } = useTranslation();
  const { data: accounts } = useAccounts();
  const syncStatuses = useUi((state) => state.syncStatuses);
  const replaceSyncStatuses = useUi((state) => state.replaceSyncStatuses);
  const pushToast = useUi((state) => state.pushToast);
  const [busyAccountId, setBusyAccountId] = useState<number | null>(null);
  const [reauthAccountId, setReauthAccountId] = useState<number | null>(null);

  const phaseLabel = (phase: SyncBackgroundPhase) => {
    switch (phase) {
      case "headers":
        return t("settings:sync.phase.headers");
      case "content":
        return t("settings:sync.phase.content");
      case "indexing":
        return t("settings:sync.phase.indexing");
      case "retrying":
        return t("settings:sync.phase.retrying");
    }
  };

  const syncNow = async (accountId: number, email: string) => {
    setBusyAccountId(accountId);
    try {
      // This command resolves after the account's foreground Inbox pass, not
      // merely after enqueueing it. Refresh views and the authoritative status
      // snapshot only after that boundary.
      await call("sync_now", { accountId });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["threads"] }),
        queryClient.invalidateQueries({ queryKey: ["unreadCounts"] }),
        queryClient.invalidateQueries({ queryKey: ["accounts"] }),
      ]);
      const statuses = (await call("get_sync_status", {}))
        .map(normalizeSyncStatus)
        .filter((status): status is SyncStatus => status != null);
      replaceSyncStatuses(statuses);
      pushToast({
        kind: "info",
        message: t("settings:sync.syncComplete", { email }),
      });
    } catch (error) {
      pushToast({
        kind: "error",
        message: t("settings:sync.syncFailed", {
          email,
          detail: errorMessage(error),
        }),
      });
    } finally {
      setBusyAccountId(null);
    }
  };

  // Reauth reopens the provider's browser consent and swaps fresh tokens onto
  // the same account; a second click while waiting cancels the pending flow.
  const reauth = async (accountId: number, email: string) => {
    if (reauthAccountId === accountId) {
      void call("cancel_oauth", {}).catch(() => {});
      return;
    }
    setReauthAccountId(accountId);
    try {
      await call("reauth_account", { accountId });
      const statuses = (await call("get_sync_status", {}))
        .map(normalizeSyncStatus)
        .filter((status): status is SyncStatus => status != null);
      replaceSyncStatuses(statuses);
      await queryClient.invalidateQueries({ queryKey: ["accounts"] });
      pushToast({
        kind: "info",
        message: t("settings:sync.reauthDone", { email }),
      });
    } catch (error) {
      const message = errorMessage(error);
      if (!message.includes("sign-in cancelled")) {
        pushToast({
          kind: "error",
          message: t("settings:sync.reauthFailed", { email, detail: message }),
        });
      }
    } finally {
      setReauthAccountId(null);
    }
  };

  return (
    (accounts ?? []).length === 0 ? (
      <EmptyState icon="repeat" title={t("settings:sync.noAccounts")} />
    ) : (
    <SettingsGroup>
      {(accounts ?? []).map((account) => {
        const status: SyncStatus = syncStatuses[account.id] ?? {
          accountId: account.id,
          state: account.syncState,
          foregroundPhase: account.syncState === "syncing" ? "inbox" : "idle",
          background: null,
        };
        const busy = busyAccountId === account.id;
        const foreground =
          status.foregroundPhase === "inbox"
            ? t("settings:sync.checking")
            : status.state === "idle"
              ? t("settings:sync.upToDate")
              : t(`common:syncState.${status.state}`);
        const background = status.background;
        const percent =
          background && background.total > 0
            ? Math.min(
                100,
                Math.max(0, (background.done / background.total) * 100),
              )
            : 0;

        return (
          <div key={account.id} className="!py-4">
            <div className="flex items-center gap-2.5">
              <span
                className="size-2 shrink-0 rounded-full"
                style={{ background: SYNC_DOT[status.state] }}
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-base font-medium text-ink">
                  {account.email}
                </div>
                <div className="text-xs text-ink-faint">
                  {t(`settings:accounts.provider.${account.provider}`)} ·{" "}
                  {t(`common:syncState.${status.state}`)}
                </div>
              </div>
              {status.state === "needs_reauth" &&
              account.provider !== "imap" ? (
                <Button
                  variant="primary"
                  size="sm"
                  busy={reauthAccountId === account.id}
                  disabled={
                    reauthAccountId != null && reauthAccountId !== account.id
                  }
                  aria-label={t("settings:sync.reauthAccount", {
                    email: account.email,
                  })}
                  onClick={() => void reauth(account.id, account.email)}
                >
                  {reauthAccountId === account.id
                    ? t("settings:sync.reauthWaiting")
                    : t("common:reauthBanner.action", {
                        provider: t(
                          `settings:accounts.provider.${account.provider}`,
                        ),
                      })}
                </Button>
              ) : (
                <Button
                  size="sm"
                  busy={busy || status.foregroundPhase === "inbox"}
                  disabled={busyAccountId != null}
                  aria-label={t("settings:sync.syncNowAccount", {
                    email: account.email,
                  })}
                  onClick={() => void syncNow(account.id, account.email)}
                >
                  {busy || status.foregroundPhase === "inbox"
                    ? t("settings:sync.syncingNow")
                    : t("settings:sync.syncNow")}
                </Button>
              )}
            </div>

            <div className="mt-4 grid grid-cols-[110px_minmax(0,1fr)] gap-x-4 gap-y-3 border-t border-hairline pt-3 text-sm">
              <span className="text-ink-faint">
                {t("settings:sync.foreground")}
              </span>
              <span className="text-ink">{foreground}</span>

              <span className="text-ink-faint">
                {t("settings:sync.background")}
              </span>
              {background ? (
                <div className="min-w-0">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-ink">
                      {phaseLabel(background.phase)}
                    </span>
                    <span className="shrink-0 tabular-nums text-ink-muted">
                      {t("settings:sync.progress", {
                        done: background.done.toLocaleString(),
                        total: background.total.toLocaleString(),
                      })}
                    </span>
                  </div>
                  <div
                    className="mt-2 h-1.5 overflow-hidden rounded-full bg-bg3"
                    role="progressbar"
                    aria-label={phaseLabel(background.phase)}
                    aria-valuemin={0}
                    aria-valuemax={background.total}
                    aria-valuenow={Math.min(background.done, background.total)}
                  >
                    <div
                      className={`co-progress-fill h-full rounded-full bg-accent${
                        percent < 100 ? " is-loading" : ""
                      }`}
                      style={{ width: `${percent}%` }}
                    />
                  </div>
                  <div className="mt-1.5 text-xs text-ink-faint">
                    {t("settings:sync.failed", { count: background.failed })}
                  </div>
                </div>
              ) : (
                <span className="text-ink">{t("settings:sync.complete")}</span>
              )}
            </div>
          </div>
        );
      })}
    </SettingsGroup>
    )
  );
}
