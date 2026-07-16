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
  AiAutomationAction,
  AiAutomationPlan,
  AiAutomationRule,
  AiTier,
  Provider,
  Settings,
  Signature,
  SyncBackgroundPhase,
  SyncState,
  SyncStatus,
} from "../../ipc/types";
import { normalizeSyncStatus } from "../../lib/syncStatus";
import { inboxTabOrder } from "../../lib/splitOrder";
import { textToHtml } from "../../lib/richtext";
import { RichBody } from "../compose/RichBody";
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
import { CalendarSettings } from "./CalendarSettings";
import { LabelsSection } from "./LabelsPanel";
import { SnippetsSection } from "./SnippetsPanel";
import { SplitInboxSection } from "./SplitsPanel";
import {
  BusyLabel,
  ConfirmButton,
  ghostBtnCls,
  inputCls,
  PanelShell,
  primaryBtnCls,
  SectionLabel,
  Segmented,
  Select,
  SettingRow,
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
  language: "system",
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
  autoAdvance: true,
  selectAdvance: true,
  autoLabelsEnabled: true,
  aiCategorize: false,
  aiCategoryPrompt: "",
  aiAutomationRules: [],
  aiTierCategorize: "instant",
  groupByDate: true,
  contactSuggestAllAccounts: false,
  dockBadgeEnabled: true,
  dockBadgeSource: "inbox",
  signatures: {},
  signatureList: [],
  signatureDefaults: {},
  accountThemes: {},
};

/** Optimistic settings write: cache first, backend follows, rollback on error. */
async function updateSettings(patch: Partial<Settings>) {
  const cur =
    queryClient.getQueryData<Settings>(["settings"]) ?? DEFAULT_SETTINGS;
  const next: Settings = { ...cur, ...patch };
  queryClient.setQueryData(["settings"], next);
  if (patch.theme) useUi.getState().set({ theme: patch.theme });
  try {
    await call("set_settings", { settings: next });
  } catch (err) {
    useUi.getState().pushToast({
      kind: "error",
      message: i18n.t("settings:toast.settingsSaveFailed", {
        detail: errorMessage(err),
      }),
    });
    void queryClient.invalidateQueries({ queryKey: ["settings"] });
  }
}

function SettingsNavIcon({ tab }: { tab: SettingsTab }) {
  const paths: Record<SettingsTab, React.ReactNode> = {
    general: (
      <>
        <path d="M4 7h6M14 7h6M4 17h9M17 17h3" />
        <circle cx="12" cy="7" r="2" />
        <circle cx="15" cy="17" r="2" />
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
    ai: (
      <>
        <path d="M12 3l1.2 3.8L17 8l-3.8 1.2L12 13l-1.2-3.8L7 8l3.8-1.2z" />
        <path d="M18.5 14l.7 2.3 2.3.7-2.3.7-.7 2.3-.7-2.3-2.3-.7 2.3-.7zM5.5 14l.6 1.9 1.9.6-1.9.6-.6 1.9-.6-1.9-1.9-.6 1.9-.6z" />
      </>
    ),
    ai_automation: (
      <>
        <path d="M5 4v5M5 15v5M19 4v5M19 15v5M5 12h14" />
        <circle cx="5" cy="12" r="3" />
        <circle cx="19" cy="12" r="3" />
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
  const [tab, setTab] = useState<SettingsTab>("general");
  const [query, setQuery] = useState("");

  const TAB_KEYS: SettingsTab[] = [
    "general",
    "stats",
    "splits",
    "snippets",
    "labels",
    "ai",
    "ai_automation",
    "rag",
    "accounts",
    "sync",
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
    general: t("settings:section.preferences"),
    stats: t("settings:section.stats"),
    splits: t("settings:section.splitInbox"),
    snippets: t("settings:section.snippets"),
    labels: t("settings:section.labels"),
    ai: t("settings:section.ai"),
    ai_automation: t("settings:section.aiAutomation"),
    rag: t("settings:section.ragSearch"),
    accounts: t("settings:section.accounts"),
    sync: t("settings:section.sync"),
  };

  const TAB_GROUPS: { label: string; tabs: SettingsTab[] }[] = [
    { label: t("settings:navigation.general"), tabs: ["general", "stats"] },
    {
      label: t("settings:navigation.organization"),
      tabs: ["splits", "snippets", "labels"],
    },
    {
      label: t("settings:navigation.intelligence"),
      tabs: ["ai", "ai_automation", "rag"],
    },
    { label: t("settings:navigation.system"), tabs: ["accounts", "sync"] },
  ];

  // Flat index of every setting, so search can jump straight to its tab.
  // `label` is localized (matches localized queries); `keywords` add English synonyms.
  const INDEX: { tab: SettingsTab; label: string; keywords: string }[] = [
    {
      tab: "stats",
      label: t("settings:section.stats"),
      keywords: "statistics analytics activity sent received email heatmap volume",
    },
    {
      tab: "general",
      label: t("settings:theme.label"),
      keywords: "appearance dark light snow carbon color",
    },
    {
      tab: "general",
      label: t("settings:language.label"),
      keywords: "locale translation",
    },
    {
      tab: "general",
      label: t("settings:undoSend.label"),
      keywords: "undo send delay cancel",
    },
    {
      tab: "general",
      label: t("settings:loadRemoteImages.label"),
      keywords: "images privacy tracking pixels remote",
    },
    {
      tab: "general",
      label: t("settings:notifications.label"),
      keywords:
        "notify alerts desktop scope important all tabs split inbox spam",
    },
    {
      tab: "general",
      label: t("settings:dockBadge.label"),
      keywords: "dock badge unread count icon red important",
    },
    {
      tab: "general",
      label: t("settings:autoAdvance.label"),
      keywords: "auto advance next thread cursor",
    },
    {
      tab: "general",
      label: t("settings:groupByDate.label"),
      keywords: "group date today yesterday timeline headers sections",
    },
    {
      tab: "general",
      label: t("settings:contactSuggestAllAccounts.label"),
      keywords: "contacts autocomplete suggestions recipients to account domain all",
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
      tab: "ai_automation",
      label: t("settings:section.aiAutomation"),
      keywords: "ai automation rules sort actions labels trash subject",
    },
    {
      tab: "rag",
      label: t("settings:section.ragSearch"),
      keywords: "rag semantic search embeddings vector meaning offline reindex",
    },
    {
      tab: "ai",
      label: "Writing voice",
      keywords: "voice draft style learn tone",
    },
    {
      tab: "accounts",
      label: t("settings:section.accounts"),
      keywords: "accounts add remove gmail microsoft imap oauth",
    },
    {
      tab: "accounts",
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
      tab: "general",
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
          <h3 className="mb-1 px-3 text-[10px] font-semibold tracking-[0.13em] text-ink-faint uppercase">
            {group.label}
          </h3>
          <div className="flex flex-col gap-0.5">
            {group.tabs.map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => goTab(k)}
                aria-current={tab === k && q === "" ? "page" : undefined}
                className={`group flex w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-left text-[13.5px] transition-colors ${
                  tab === k && q === ""
                    ? "bg-accent/10 font-medium text-accent"
                    : "text-ink-muted hover:bg-bg2 hover:text-ink"
                }`}
              >
                <span
                  className={`flex size-6 shrink-0 items-center justify-center rounded-md ${
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
          <p className="py-6 text-center text-[13px] text-ink-faint">
            {t("settings:search.noResults", { query: q })}
          </p>
        ) : (
          <div className="flex flex-col gap-1">
            {results.map((e, i) => (
              <button
                key={`${e.tab}-${i}`}
                onClick={() => goTab(e.tab)}
                className="flex items-center justify-between gap-3 rounded-lg px-3 py-2 text-left hover:bg-bg2"
              >
                <span className="text-[13.5px] text-ink">{e.label}</span>
                <span className="shrink-0 rounded bg-bg2 px-1.5 py-px text-[10.5px] font-semibold tracking-wide text-ink-faint uppercase">
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
      <div className="flex flex-col gap-7">
        {tab === "general" && (
          <section className="flex flex-col gap-4">
            <SettingRow
              label={t("settings:theme.label")}
              hint={t("settings:theme.hint")}
            >
              <Segmented
                value={s.theme}
                options={[
                  { value: "snow", label: t("settings:theme.snow") },
                  { value: "carbon", label: t("settings:theme.carbon") },
                  { value: "holiday", label: t("settings:theme.holiday") },
                  { value: "system", label: t("settings:theme.system") },
                ]}
                onChange={(theme) => void updateSettings({ theme })}
              />
            </SettingRow>
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
                        <label
                          key={opt.key}
                          className="flex cursor-pointer items-center gap-2 text-[12.5px] text-ink-muted select-none"
                        >
                          <span>{opt.name}</span>
                          <input
                            type="checkbox"
                            className="size-4 accent-accent"
                            checked={s.notificationTabs.includes(opt.key)}
                            onChange={(e) =>
                              toggleNotifyTab(opt.key, e.target.checked)
                            }
                          />
                        </label>
                      ))}
                      {notifyTabOptions.length === 0 && (
                        <span className="text-[12px] text-ink-muted">
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
                onChange={(selectAdvance) => void updateSettings({ selectAdvance })}
              />
            </SettingRow>
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
            <AboutSection />
          </section>
        )}

        {tab === "stats" && <EmailStatsDashboard />}

        {tab === "splits" && (
          <>
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
            <SplitInboxSection />
          </>
        )}

        {tab === "snippets" && <SnippetsSection />}

        {tab === "labels" && <LabelsSection />}

        {tab === "ai" && (
          <>
            <AiUsageDashboard />
            <AiSection settings={s} page="models" />
            <VoiceSection settings={s} />
          </>
        )}

        {tab === "ai_automation" && (
          <AiSection settings={s} page="automation" />
        )}

        {tab === "rag" && <SemanticSearchSection settings={s} />}

        {tab === "accounts" && (
          <>
            <AccountsSection />
            <CalendarSettings />
            <SignaturesSection settings={s} />
            <OAuthSection settings={s} />
          </>
        )}

        {tab === "sync" && <SyncSection />}
      </div>
    </PanelShell>
  );
}

/** Known OpenAI-compatible providers; picking one fills the base URL. */
const AI_PROVIDER_PRESETS: {
  id: string;
  label: string;
  baseUrl: string;
  defaultModel?: string;
}[] = [
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "openai/gpt-5.6-luna",
  },
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    baseUrl: "https://api.anthropic.com/v1",
    defaultModel: "claude-sonnet-5",
  },
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-5.6-luna",
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
    defaultModel: "kimi-k2.6",
  },
  {
    id: "zai",
    label: "Z.ai (GLM)",
    baseUrl: "https://api.z.ai/api/paas/v4",
    defaultModel: "glm-5.2",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-v4-flash",
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
    <section className="mt-3 flex flex-col gap-4 border-t border-hairline pt-5">
      <SectionLabel>{t("settings:about.section")}</SectionLabel>
      <SettingRow
        label={t("settings:about.version")}
        hint={t("settings:about.versionHint")}
      >
        <div className="flex items-center gap-3">
          <span className="text-[13px] tabular-nums text-ink-muted">
            {version || "…"}
          </span>
          <button
            className={ghostBtnCls}
            onClick={() => void onCheck()}
            disabled={checking}
          >
            {checking
              ? <BusyLabel>{t("settings:about.checking")}</BusyLabel>
              : t("settings:about.checkUpdates")}
          </button>
        </div>
      </SettingRow>
      <SettingRow
        label={t("settings:about.logs")}
        hint={t("settings:about.logsHint")}
      >
        <button className={ghostBtnCls} onClick={() => void onOpenLogs()}>
          {t("settings:about.openLogs")}
        </button>
      </SettingRow>
    </section>
  );
}

const AI_TIERS: AiTier[] = ["instant", "cheap", "intelligent"];

/** A model-id field for one tier; commits on blur / Enter, shares the global
 *  `ai-model-options` datalist. Empty means "fall back to the default model". */
function TierModelField({
  label,
  hint,
  value,
  placeholder,
  onCommit,
}: {
  label: string;
  hint: string;
  value: string;
  placeholder: string;
  onCommit: (v: string) => void;
}) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <SettingRow label={label} hint={hint}>
      <input
        value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => onCommit(v.trim())}
        onKeyDown={(e) => {
          if (e.key === "Enter") onCommit(v.trim());
        }}
        placeholder={placeholder}
        spellCheck={false}
        list="ai-model-options"
        className={`${inputCls} !w-[280px]`}
      />
    </SettingRow>
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
    metric === "sent" ? sent : metric === "received" ? received : sent + received;
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
      <div>
        <SectionLabel>{t("settings:stats.section")}</SectionLabel>
        <p className="mt-1 text-[11.5px] leading-relaxed text-ink-faint">
          {t("settings:stats.intro")}
        </p>
      </div>

      <div className="grid grid-cols-4 gap-2">
        {summaries.map((summary) => (
          <div
            key={summary.label}
            className="rounded-xl border border-hairline bg-bg1 px-3 py-2.5"
          >
            <div className="truncate text-[10.5px] font-medium text-ink-faint">
              {summary.label}
            </div>
            <div
              className="mt-1 truncate text-[18px] font-semibold tabular-nums tracking-tight text-ink"
              title={summary.value.toLocaleString(i18n.language)}
            >
              {formatMetricCount(summary.value)}
            </div>
          </div>
        ))}
      </div>

      <div className="rounded-xl border border-hairline bg-bg1 px-3.5 py-3">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <div className="text-[12px] font-medium text-ink-muted">
              {t("settings:stats.activity")}
            </div>
            <div className="mt-0.5 text-[10.5px] text-ink-faint">
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
                      ? { background: heatColor, opacity: HEATMAP_OPACITY[level] }
                      : { background: "transparent" }
                  }
                  title={title}
                  aria-label={title}
                />
              );
            })}
          </div>
        </div>
        <div className="mt-2 flex items-center justify-end gap-1 text-[9.5px] text-ink-faint">
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
          <SectionLabel>{t("settings:ai.usage.section")}</SectionLabel>
          <p className="mt-1 text-[11.5px] leading-relaxed text-ink-faint">
            {t("settings:ai.usage.intro")}
          </p>
        </div>
        <span className="shrink-0 text-[11.5px] tabular-nums text-ink-faint">
          {t("settings:ai.usage.requests", {
            count: usage?.totalRequests ?? 0,
          })}
        </span>
      </div>

      <div className="grid grid-cols-5 gap-2">
        {summaries.map((summary) => (
          <div
            key={summary.label}
            className="rounded-xl border border-hairline bg-bg1 px-3 py-2.5"
          >
            <div className="truncate text-[10.5px] font-medium text-ink-faint">
              {summary.label}
            </div>
            <div
              className="mt-1 truncate text-[18px] font-semibold tabular-nums tracking-tight text-ink"
              title={(summary.value ?? 0).toLocaleString(i18n.language)}
            >
              {formatMetricCount(summary.value)}
            </div>
          </div>
        ))}
      </div>

      <div className="rounded-xl border border-hairline bg-bg1 px-3.5 py-3">
        <div className="mb-3 flex items-center justify-between gap-3">
          <span className="text-[12px] font-medium text-ink-muted">
            {t("settings:ai.usage.activity")}
          </span>
          <span className="text-[10.5px] text-ink-faint">
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
        <div className="mt-2 flex items-center justify-end gap-1 text-[9.5px] text-ink-faint">
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

function AiAutomationsEditor({ settings }: { settings: Settings }) {
  const { t } = useTranslation();
  const { data: labels } = useLabels();
  const { data: splits } = useSplits();
  const pushToast = useUi((s) => s.pushToast);
  const [draft, setDraft] = useState<AiAutomationRule | null>(null);
  const [plan, setPlan] = useState<AiAutomationPlan | null>(null);
  const [trying, setTrying] = useState(false);

  const commitRules = (rules: AiAutomationRule[]) =>
    void updateSettings({ aiAutomationRules: rules });
  const targetName = (value: string) => {
    if (value === "important") return t("inbox:split.important");
    if (value === "other") return t("inbox:split.other");
    if (value.startsWith("split:"))
      return (
        splits?.find((s) => s.id === Number(value.slice(6)))?.name ?? value
      );
    if (value.startsWith("label:"))
      return (
        labels?.find((l) => l.id === Number(value.slice(6)))?.name ?? value
      );
    return value;
  };
  const describeAction = (action: AiAutomationAction) => {
    const base = t(`settings:ai.actions.${action.kind}`);
    if (action.kind === "route_to")
      return `${base}: ${targetName(action.value)}`;
    if (action.kind === "add_label" || action.kind === "remove_label") {
      const name =
        labels?.find((l) => l.id === Number(action.value))?.name ??
        action.value;
      return `${base}: ${name}`;
    }
    if (action.kind === "subject_prefix" || action.kind === "body_note")
      return `${base}: ${action.value}`;
    return base;
  };
  const openRule = (rule: AiAutomationRule) => {
    const sourcePrompt =
      rule.sourcePrompt?.trim() ||
      `${rule.instruction}. ${rule.actions.map(describeAction).join(", ")}.`;
    setDraft({ ...structuredClone(rule), sourcePrompt });
    setPlan(null);
  };
  const closeEditor = () => {
    setDraft(null);
    setPlan(null);
  };
  const tryPrompt = async () => {
    if (!draft?.sourcePrompt.trim() || trying) return;
    setTrying(true);
    try {
      const next = await call("ai_plan_automation", {
        prompt: draft.sourcePrompt.trim(),
      });
      setPlan(next);
      if (next.supported) {
        setDraft((current) =>
          current
            ? {
                ...current,
                name: next.name,
                instruction: next.instruction,
                actions: next.actions,
              }
            : current,
        );
      }
    } catch (err) {
      setPlan(null);
      pushToast({ kind: "error", message: errorMessage(err) });
    } finally {
      setTrying(false);
    }
  };
  const valid = !!draft && !!plan?.supported && draft.actions.length > 0;

  if (draft) {
    return (
      <div className="rounded-xl border border-hairline bg-bg1 p-4 shadow-sm">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <div className="text-[14px] font-semibold text-ink">
              {settings.aiAutomationRules.some((r) => r.id === draft.id)
                ? t("settings:ai.automation.editTitle")
                : t("settings:ai.automation.newTitle")}
            </div>
            <p className="mt-0.5 text-[11.5px] text-ink-faint">
              {t("settings:ai.automation.editorHint")}
            </p>
          </div>
          <span className="rounded-full border border-accent/20 bg-accent/10 px-2 py-0.5 text-[10.5px] font-semibold text-accent">
            AI
          </span>
        </div>
        <div className="flex flex-col gap-3.5">
          <label className="flex flex-col gap-1.5">
            <span className="text-[11.5px] font-medium text-ink-faint">
              {t("settings:ai.automation.promptLabel")}
            </span>
            <textarea
              className={`${inputCls} min-h-32 resize-y leading-relaxed`}
              value={draft.sourcePrompt}
              onChange={(e) => {
                setDraft({ ...draft, sourcePrompt: e.target.value });
                setPlan(null);
              }}
              placeholder={t("settings:ai.automation.promptPlaceholder")}
              rows={5}
              autoFocus
            />
            <span className="text-[10.5px] leading-relaxed text-ink-faint">
              {t("settings:ai.automation.promptHint")}
            </span>
          </label>

          <div className="flex items-center gap-2">
            <button
              type="button"
              className={`${primaryBtnCls}${trying ? " co-btn-busy" : ""}`}
              disabled={trying || !draft.sourcePrompt.trim()}
              onClick={() => void tryPrompt()}
            >
              {trying ? (
                <BusyLabel>{t("settings:ai.automation.trying")}</BusyLabel>
              ) : (
                t("settings:ai.automation.try")
              )}
            </button>
            <span className="text-[10.5px] text-ink-faint">
              {t("settings:ai.automation.tryHint")}
            </span>
          </div>

          {plan && (
            <div className="co-fade-in rounded-xl border border-hairline bg-bg0 p-3.5">
              <div className="flex items-start gap-2.5">
                <span
                  className="mt-1 size-2 shrink-0 rounded-full"
                  style={{
                    background: plan.supported ? "var(--ok)" : "var(--danger)",
                  }}
                />
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-semibold text-ink">
                    {plan.supported
                      ? t("settings:ai.automation.validated", {
                          name: plan.name,
                        })
                      : t("settings:ai.automation.notDoable")}
                  </div>
                  {plan.summary && (
                    <p className="mt-0.5 text-[11.5px] leading-relaxed text-ink-faint">
                      {plan.summary}
                    </p>
                  )}
                </div>
              </div>

              {plan.supported ? (
                <div className="mt-3 flex flex-col gap-2.5 border-t border-hairline pt-3">
                  <div>
                    <div className="text-[10.5px] font-semibold tracking-wide text-ink-faint uppercase">
                      {t("settings:ai.automation.understoodWhen")}
                    </div>
                    <p className="mt-1 text-[12px] leading-relaxed text-ink-muted">
                      {plan.instruction}
                    </p>
                  </div>
                  <div>
                    <div className="text-[10.5px] font-semibold tracking-wide text-ink-faint uppercase">
                      {t("settings:ai.automation.understoodActions")}
                    </div>
                    <div className="mt-1.5 flex flex-col gap-1.5">
                      {plan.actions.map((action, index) => (
                        <div
                          key={`${action.kind}-${index}`}
                          className="flex items-center gap-2 text-[12px] text-ink-muted"
                        >
                          <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-bg2 text-[10px] font-semibold text-ink-faint">
                            {index + 1}
                          </span>
                          <span>{describeAction(action)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              ) : (
                <ul className="mt-3 flex list-disc flex-col gap-1 border-t border-hairline pt-3 pl-5 text-[11.5px] leading-relaxed text-danger">
                  {plan.issues.map((issue, index) => (
                    <li key={`${issue}-${index}`}>{issue}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div className="mt-1 flex items-center gap-2 border-t border-hairline pt-3">
            <button
              type="button"
              className={primaryBtnCls}
              disabled={!valid}
              onClick={() => {
                const exists = settings.aiAutomationRules.some(
                  (r) => r.id === draft.id,
                );
                commitRules(
                  exists
                    ? settings.aiAutomationRules.map((r) =>
                        r.id === draft.id ? draft : r,
                      )
                    : [...settings.aiAutomationRules, draft],
                );
                closeEditor();
              }}
            >
              {t("settings:ai.automation.save")}
            </button>
            <button type="button" className={ghostBtnCls} onClick={closeEditor}>
              {t("settings:ai.automation.cancel")}
            </button>
            {!plan?.supported && (
              <span className="ml-auto text-[10.5px] text-ink-faint">
                {t("settings:ai.automation.saveAfterTry")}
              </span>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2.5">
      {settings.aiAutomationRules.map((rule) => (
        <div
          key={rule.id}
          className="rounded-xl border border-hairline bg-bg1 px-3.5 py-3"
        >
          <div className="flex items-start gap-3">
            <Toggle
              label={rule.name}
              checked={rule.enabled}
              onChange={(enabled) =>
                commitRules(
                  settings.aiAutomationRules.map((r) =>
                    r.id === rule.id ? { ...r, enabled } : r,
                  ),
                )
              }
            />
            <button
              type="button"
              className="min-w-0 flex-1 text-left"
              onClick={() => openRule(rule)}
            >
              <span className="block truncate text-[13.5px] font-medium text-ink">
                {rule.name}
              </span>
              <span className="mt-0.5 block line-clamp-2 text-[11.5px] leading-relaxed text-ink-faint">
                {rule.sourcePrompt || rule.instruction}
              </span>
            </button>
            <button
              type="button"
              className={ghostBtnCls}
              onClick={() => openRule(rule)}
            >
              {t("settings:ai.automation.edit")}
            </button>
            <ConfirmButton
              label={t("settings:ai.automation.delete")}
              confirmLabel={t("settings:ai.automation.reallyDelete")}
              onConfirm={() =>
                commitRules(
                  settings.aiAutomationRules.filter((r) => r.id !== rule.id),
                )
              }
            />
          </div>
          <div className="mt-2.5 flex flex-wrap gap-1.5 pl-[52px]">
            {rule.actions.map((action, index) => (
              <span
                key={`${action.kind}-${index}`}
                className="max-w-full truncate rounded-full border border-hairline bg-bg0 px-2 py-0.5 text-[10.5px] text-ink-muted"
              >
                {describeAction(action)}
              </span>
            ))}
          </div>
        </div>
      ))}
      {settings.aiAutomationRules.length === 0 && (
        <div className="rounded-xl border border-dashed border-hairline bg-bg1 px-4 py-5 text-center">
          <div className="text-[12.5px] font-medium text-ink-muted">
            {t("settings:ai.automation.emptyTitle")}
          </div>
          <p className="mx-auto mt-1 max-w-md text-[11.5px] leading-relaxed text-ink-faint">
            {t("settings:ai.automation.emptyHint")}
          </p>
        </div>
      )}
      <button
        type="button"
        className={`${primaryBtnCls} mt-0.5 self-start`}
        onClick={() =>
          setDraft({
            id: `automation-${Date.now().toString(36)}`,
            name: "",
            sourcePrompt: "",
            instruction: "",
            enabled: true,
            actions: [],
          })
        }
      >
        {t("settings:ai.automation.add")}
      </button>
    </div>
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
  const { data: models } = useAiModels(settings.aiBaseUrl);

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
    } catch (err) {
      pushToast({
        kind: "error",
        message: errorMessage(err),
      });
    } finally {
      setSavingKey(false);
    }
  };

  const commitField = (patch: Partial<Settings>) => {
    const key = Object.keys(patch)[0] as keyof Settings;
    if (patch[key] === settings[key]) return;
    void updateSettings(patch);
  };

  return (
    <section className="flex flex-col gap-4">
      {page === "models" ? (
        <>
          <SectionLabel>{t("settings:section.ai")}</SectionLabel>
          <SettingRow
            label={t("settings:ai.statusLabel")}
            hint={t("settings:ai.statusHint")}
          >
            <span className="flex items-center gap-2 text-[12.5px] text-ink-muted">
              <span
                className="size-2 rounded-full"
                style={{
                  background: status?.configured ? "var(--ok)" : "var(--bg4)",
                }}
              />
              {status
                ? status.configured
                  ? t("settings:ai.configured", { model: status.model })
                  : t("settings:ai.notConfigured")
                : t("settings:ai.loading")}
            </span>
          </SettingRow>
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
              <button
                className={primaryBtnCls}
                disabled={savingKey}
                onClick={() => void saveKey()}
              >
                {t("settings:ai.save")}
              </button>
            </div>
          </SettingRow>
          <SettingRow
            label={t("settings:ai.providerLabel")}
            hint={t("settings:ai.providerHint")}
          >
            <Select
              value={
                forceCustom
                  ? "custom"
                  : (AI_PROVIDER_PRESETS.find(
                      (p) => p.baseUrl === settings.aiBaseUrl,
                    )?.id ?? "custom")
              }
              onChange={(e) => {
                if (e.target.value === "custom") {
                  // Keep whatever URL is set and hand focus to the field below.
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
              {AI_PROVIDER_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
              <option value="custom">{t("settings:ai.customProvider")}</option>
            </Select>
          </SettingRow>
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
                : t("settings:ai.modelHintEmpty")
            }
          >
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              onBlur={() => commitField({ aiModel: model.trim() })}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitField({ aiModel: model.trim() });
              }}
              placeholder={t("settings:ai.modelPlaceholder")}
              spellCheck={false}
              list="ai-model-options"
              className={`${inputCls} !w-[280px]`}
            />
            <datalist id="ai-model-options">
              {(models ?? []).map((id) => (
                <option key={id} value={id} />
              ))}
            </datalist>
          </SettingRow>

          <SectionLabel>{t("settings:ai.tiersSection")}</SectionLabel>
          <p className="-mt-1 text-[12px] leading-relaxed text-ink-faint">
            {t("settings:ai.tiersIntro")}
          </p>
          <TierModelField
            label={t("settings:ai.tier.instant")}
            hint={t("settings:ai.tierInstantHint")}
            value={settings.aiModelInstant}
            placeholder={t("settings:ai.tierFallback")}
            onCommit={(v) => commitField({ aiModelInstant: v })}
          />
          <TierModelField
            label={t("settings:ai.tier.cheap")}
            hint={t("settings:ai.tierCheapHint")}
            value={settings.aiModelCheap}
            placeholder={t("settings:ai.tierFallback")}
            onCommit={(v) => commitField({ aiModelCheap: v })}
          />
          <TierModelField
            label={t("settings:ai.tier.intelligent")}
            hint={t("settings:ai.tierIntelligentHint")}
            value={settings.aiModelIntelligent}
            placeholder={t("settings:ai.tierFallback")}
            onCommit={(v) => commitField({ aiModelIntelligent: v })}
          />

          <SectionLabel>{t("settings:ai.routingSection")}</SectionLabel>
          <p className="-mt-1 text-[12px] leading-relaxed text-ink-faint">
            {t("settings:ai.routingIntro")}
          </p>
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
        </>
      ) : (
        <>
          <SectionLabel>{t("settings:ai.categorizeSection")}</SectionLabel>
          <p className="-mt-1 text-[12px] leading-relaxed text-ink-faint">
            {t("settings:ai.categorizeIntro")}
          </p>
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
          {settings.aiCategorize && (
            <>
              <AiAutomationsEditor settings={settings} />
              <details className="group rounded-xl border border-hairline bg-bg1">
                <summary className="flex cursor-pointer list-none items-center justify-between px-3.5 py-3 text-[12.5px] font-medium text-ink-muted">
                  <span>{t("settings:ai.categoryPromptLabel")}</span>
                  <svg
                    className="transition-transform group-open:rotate-180"
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.2"
                  >
                    <path d="M6 9l6 6 6-6" />
                  </svg>
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
                    className={`${inputCls} w-full resize-y !text-[12px] leading-relaxed`}
                  />
                  <p className="text-[11.5px] text-ink-faint">
                    {t("settings:ai.categoryPromptHint")}
                  </p>
                </div>
              </details>
              <ScenarioRouteRow
                label={t("settings:ai.routeCategorize")}
                hint={t("settings:ai.routeCategorizeHint")}
                value={settings.aiTierCategorize}
                onChange={(v) => commitField({ aiTierCategorize: v })}
                tierLabel={(tier) => t(`settings:ai.tier.${tier}`)}
              />
            </>
          )}
          <SettingRow
            label={t("settings:ai.resortLabel")}
            hint={t("settings:ai.resortHint")}
          >
            <button
              className={`${primaryBtnCls}${resorting ? " co-btn-busy" : ""}`}
              disabled={resorting}
              onClick={() => void resort()}
            >
              {resorting ? (
                <BusyLabel>{t("settings:ai.resorting")}</BusyLabel>
              ) : (
                t("settings:ai.resort")
              )}
            </button>
          </SettingRow>
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

  const on = settings.embeddingBackend === "local";
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
        message: `Re-indexing ${n} messages…`,
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
    <section className="flex flex-col gap-4">
      <SectionLabel>{t("settings:section.ragSearch")}</SectionLabel>
      <SettingRow
        label="Semantic search"
        hint="Runs a small model on-device to find mail by meaning, not just keywords. Fully offline."
      >
        <Segmented
          value={settings.embeddingBackend}
          options={[
            { value: "local", label: "On (local)" },
            { value: "off", label: "Off" },
          ]}
          onChange={(embeddingBackend) =>
            void updateSettings({
              embeddingBackend: embeddingBackend as "local" | "off",
            })
          }
        />
      </SettingRow>
      {on && (
        <>
          <SettingRow
            label="Model"
            hint="Larger models are more accurate but slower to index."
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
            label="Index"
            hint={
              status
                ? status.ready
                  ? `${status.embedded.toLocaleString()} / ${status.total.toLocaleString()} messages indexed${status.pending ? ` · ${status.pending.toLocaleString()} queued` : ""}`
                  : "Loading model…"
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
              <button
                className={ghostBtnCls}
                disabled={reindexing}
                onClick={() => void reindex()}
              >
                {reindexing ? <BusyLabel>Rebuilding…</BusyLabel> : "Rebuild"}
              </button>
            </div>
          </SettingRow>
        </>
      )}
    </section>
  );
}

/** Writing voice: learn a style profile from sent mail and draft in it. */
function VoiceSection({ settings }: { settings: Settings }) {
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
          message: "Learned your writing voice",
          durationMs: 2500,
        });
      },
      onError: (e) => pushToast({ kind: "error", message: errorMessage(e) }),
    });
  };

  return (
    <section className="flex flex-col gap-4">
      <SectionLabel>Writing voice</SectionLabel>
      <SettingRow
        label="Draft in my voice"
        hint="AI drafts imitate how you write, learned from your sent mail and similar past replies."
      >
        <Toggle
          label="Draft in my voice"
          checked={settings.voiceDrafting}
          onChange={(voiceDrafting) => void updateSettings({ voiceDrafting })}
        />
      </SettingRow>
      <SettingRow
        label="Voice profile"
        hint={
          learned
            ? `Learned ${new Date(settings.voiceLearnedAt).toLocaleDateString(i18n.language)}`
            : "Not learned yet - needs some sent mail."
        }
      >
        <button
          className={`${primaryBtnCls}${learn.isPending ? " co-btn-busy" : ""}`}
          disabled={learn.isPending}
          onClick={runLearn}
        >
          {learn.isPending ? (
            <BusyLabel>Learning…</BusyLabel>
          ) : learned ? (
            "Re-learn my voice"
          ) : (
            "Learn my voice"
          )}
        </button>
      </SettingRow>
      {(learned || profile) && (
        <textarea
          value={profile}
          onChange={(e) => setProfile(e.target.value)}
          onBlur={() => {
            if (profile !== settings.voiceProfile)
              void updateSettings({ voiceProfile: profile });
          }}
          rows={5}
          spellCheck={false}
          placeholder="Your writing-style profile"
          className={`${inputCls} w-full resize-y font-mono !text-[12px] leading-relaxed`}
        />
      )}
    </section>
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
    <details className="rounded-lg border border-hairline bg-bg0 px-3.5 py-2.5">
      <summary className="cursor-pointer text-[12.5px] font-medium text-ink-muted select-none">
        {t("settings:oauth.guide.title")}
      </summary>
      <div className="mt-3 flex flex-col gap-4 text-[12.5px] leading-relaxed text-ink-muted">
        {providers.map((p) => (
          <div key={p.key}>
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <span className="font-semibold text-ink">{p.title}</span>
              <button className={ghostBtnCls} onClick={() => open(p.url)}>
                {p.linkLabel}
              </button>
            </div>
            <ol className="flex list-decimal flex-col gap-1 pl-5">
              {p.steps.map((k) => (
                <li key={k}>{t(`settings:oauth.guide.${k}`)}</li>
              ))}
            </ol>
            {p.note && (
              <p className="mt-2 rounded-md bg-bg2 px-2.5 py-1.5 text-[11.5px] text-ink-faint">
                {p.note}
              </p>
            )}
          </div>
        ))}
        <div className="flex items-center justify-between gap-2 border-t border-hairline pt-3">
          <span className="text-[11.5px] text-ink-faint">
            {t("settings:oauth.guide.docsHint")}
          </span>
          <button className={ghostBtnCls} onClick={() => open(OAUTH_DOCS_URL)}>
            {t("settings:oauth.guide.viewDocs")}
          </button>
        </div>
      </div>
    </details>
  );
}

function OAuthSection({ settings }: { settings: Settings }) {
  const { t } = useTranslation();
  return (
    <section className="flex flex-col gap-4">
      <SectionLabel>{t("settings:section.oauthApps")}</SectionLabel>
      <p className="text-[12.5px] leading-relaxed text-ink-faint">
        <Trans
          i18nKey="settings:oauth.description"
          components={{ b: <b />, code: <code /> }}
        />
      </p>
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
    </section>
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
    <section className="flex flex-col gap-4">
      <div>
        <SectionLabel>{t("settings:section.sync")}</SectionLabel>
        <p className="text-[12.5px] leading-relaxed text-ink-faint">
          {t("settings:sync.intro")}
        </p>
      </div>

      {(accounts ?? []).length === 0 && (
        <p className="rounded-lg border border-hairline bg-bg0 px-3 py-4 text-[12.5px] text-ink-faint">
          {t("settings:sync.noAccounts")}
        </p>
      )}

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
          <div
            key={account.id}
            className="rounded-xl border border-hairline bg-bg0/50 p-4"
          >
            <div className="flex items-center gap-2.5">
              <span
                className="size-2 shrink-0 rounded-full"
                style={{ background: SYNC_DOT[status.state] }}
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13.5px] font-medium text-ink">
                  {account.email}
                </div>
                <div className="text-[11.5px] text-ink-faint">
                  {t(`settings:accounts.provider.${account.provider}`)} ·{" "}
                  {t(`common:syncState.${status.state}`)}
                </div>
              </div>
              {status.state === "needs_reauth" &&
              account.provider !== "imap" ? (
                <button
                  type="button"
                  className={primaryBtnCls}
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
                    : t("settings:sync.reauth")}
                </button>
              ) : (
                <button
                  type="button"
                  className={primaryBtnCls}
                  disabled={
                    busyAccountId != null || status.foregroundPhase === "inbox"
                  }
                  aria-label={t("settings:sync.syncNowAccount", {
                    email: account.email,
                  })}
                  onClick={() => void syncNow(account.id, account.email)}
                >
                  {busy || status.foregroundPhase === "inbox"
                    ? t("settings:sync.syncingNow")
                    : t("settings:sync.syncNow")}
                </button>
              )}
            </div>

            <div className="mt-4 grid grid-cols-[110px_minmax(0,1fr)] gap-x-4 gap-y-3 border-t border-hairline pt-3 text-[12.5px]">
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
                  <div className="mt-1.5 text-[11.5px] text-ink-faint">
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
    </section>
  );
}

/** Rich signatures, many per account, with Gmail-style new/reply defaults. */
function SignaturesSection({ settings }: { settings: Settings }) {
  const { t } = useTranslation();
  const { data: accounts } = useAccounts();
  if ((accounts ?? []).length === 0) return null;
  return (
    <section className="flex flex-col gap-6">
      <SectionLabel>{t("settings:signature.section")}</SectionLabel>
      {(accounts ?? []).map((a) => (
        <AccountSignatures
          key={a.id}
          accountId={a.id}
          email={a.email}
          displayName={a.displayName ?? ""}
          settings={settings}
        />
      ))}
    </section>
  );
}

/** Persist a mutation of the signature list + defaults as a whole-object write. */
function writeSignatures(
  list: Signature[],
  defaults: Record<string, { newId?: string | null; replyId?: string | null }>,
) {
  void updateSettings({ signatureList: list, signatureDefaults: defaults });
}

function AccountSignatures({
  accountId,
  email,
  displayName,
  settings,
}: {
  accountId: number;
  email: string;
  displayName: string;
  settings: Settings;
}) {
  const { t } = useTranslation();
  const key = String(accountId);
  const sigs = settings.signatureList.filter((s) => s.accountId === accountId);
  const defs = settings.signatureDefaults[key] ?? {};

  const addSignature = () => {
    const sig: Signature = {
      id: crypto.randomUUID(),
      accountId,
      name: t("settings:signature.newName"),
      html: "",
    };
    writeSignatures(
      [...settings.signatureList, sig],
      settings.signatureDefaults,
    );
  };

  const deleteSignature = (id: string) => {
    const list = settings.signatureList.filter((s) => s.id !== id);
    // Drop the id from this account's defaults if it pointed at the removed sig.
    const cur = settings.signatureDefaults[key] ?? {};
    const next = {
      ...settings.signatureDefaults,
      [key]: {
        newId: cur.newId === id ? null : cur.newId,
        replyId: cur.replyId === id ? null : cur.replyId,
      },
    };
    writeSignatures(list, next);
  };

  const setDefault = (field: "newId" | "replyId", id: string) => {
    const cur = settings.signatureDefaults[key] ?? {};
    writeSignatures(settings.signatureList, {
      ...settings.signatureDefaults,
      [key]: { ...cur, [field]: id || null },
    });
  };

  // Convenience switch over the per-mode defaults: on = default both new and
  // reply to a signature (keeping any specific picks already made), off = none.
  const autoAdd = Boolean(defs.newId || defs.replyId);
  const setAutoAdd = (enabled: boolean) => {
    const cur = settings.signatureDefaults[key] ?? {};
    const fallback = sigs[0]?.id ?? null;
    writeSignatures(settings.signatureList, {
      ...settings.signatureDefaults,
      [key]: enabled
        ? { newId: cur.newId ?? fallback, replyId: cur.replyId ?? fallback }
        : { newId: null, replyId: null },
    });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 text-[12px] font-medium tracking-wide text-ink-muted">
        <span
          className="size-1.5 shrink-0 rounded-full bg-accent/60"
          aria-hidden="true"
        />
        {email}
      </div>

      {sigs.length === 0 ? (
        <p className="rounded-lg border border-dashed border-hairline px-3 py-4 text-center text-[12.5px] text-ink-faint">
          {t("settings:signature.empty")}
        </p>
      ) : (
        <div className="flex flex-col gap-2.5">
          {sigs.map((sig) => (
            <SignatureEditor
              key={sig.id}
              sig={sig}
              settings={settings}
              email={email}
              displayName={displayName}
              onDelete={deleteSignature}
            />
          ))}
        </div>
      )}

      <div>
        <button type="button" className={ghostBtnCls} onClick={addSignature}>
          {t("settings:signature.add")}
        </button>
      </div>

      {sigs.length > 0 && (
        <div className="flex flex-col gap-2 border-t border-hairline pt-3">
          <SettingRow
            label={t("settings:signature.autoAdd")}
            hint={t("settings:signature.autoAddHint")}
          >
            <Toggle
              label={t("settings:signature.autoAdd")}
              checked={autoAdd}
              onChange={setAutoAdd}
            />
          </SettingRow>
          {autoAdd && (
            <>
              <DefaultSelect
                label={t("settings:signature.forNew")}
                value={defs.newId ?? ""}
                sigs={sigs}
                onChange={(id) => setDefault("newId", id)}
              />
              <DefaultSelect
                label={t("settings:signature.forReply")}
                value={defs.replyId ?? ""}
                sigs={sigs}
                onChange={(id) => setDefault("replyId", id)}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}

function DefaultSelect({
  label,
  value,
  sigs,
  onChange,
}: {
  label: string;
  value: string;
  sigs: Signature[];
  onChange: (id: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <SettingRow label={label}>
      <Select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="!w-[240px]"
      >
        <option value="">{t("settings:signature.none")}</option>
        {sigs.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </Select>
    </SettingRow>
  );
}

function SignatureEditor({
  sig,
  settings,
  email,
  displayName,
  onDelete,
}: {
  sig: Signature;
  settings: Settings;
  email: string;
  displayName: string;
  onDelete: (id: string) => void;
}) {
  const { t } = useTranslation();
  const pushToast = useUi((s) => s.pushToast);
  const [name, setName] = useState(sig.name);
  const [html, setHtml] = useState(sig.html);
  const [generating, setGenerating] = useState(false);
  useEffect(() => setName(sig.name), [sig.name]);
  useEffect(() => setHtml(sig.html), [sig.html]);

  // Commit a field back to the shared list on blur (mirrors the old textarea).
  const commit = (patch: Partial<Signature>) => {
    const list = settings.signatureList.map((s) =>
      s.id === sig.id ? { ...s, ...patch } : s,
    );
    writeSignatures(list, settings.signatureDefaults);
  };

  // One-click AI: build a clean signature from the account name/email and drop
  // it into the editor (persisted immediately so it survives without a blur).
  const generate = async () => {
    setGenerating(true);
    try {
      const text = await call("ai_signature", {
        name: displayName || email,
        email,
      });
      const nextHtml = textToHtml(text.trim());
      setHtml(nextHtml);
      commit({ html: nextHtml });
    } catch (err) {
      pushToast({ kind: "error", message: errorMessage(err) });
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="overflow-hidden rounded-lg border border-hairline bg-bg0 focus-within:border-accent/50">
      {/* Header strip: the name reads as an editable title, delete sits opposite. */}
      <div className="flex items-center gap-2 border-b border-hairline bg-bg1/40 py-1.5 pr-2 pl-3">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() =>
            name.trim() && name !== sig.name && commit({ name: name.trim() })
          }
          placeholder={t("settings:signature.newName")}
          className="min-w-0 flex-1 bg-transparent text-[13px] font-medium text-ink outline-none placeholder:text-ink-faint"
        />
        <button
          type="button"
          onClick={() => void generate()}
          disabled={generating}
          title={t("settings:signature.aiHint")}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-[12px] font-medium text-accent transition-colors hover:bg-accent/10 disabled:opacity-50"
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden="true"
          >
            <path d="M12 2l1.9 4.9L19 8.8l-4.1 1.9L12 16l-1.9-5.3L6 8.8l5.1-1.9zM19 14l.9 2.4 2.4.9-2.4.9-.9 2.4-.9-2.4-2.4-.9 2.4-.9z" />
          </svg>
          {generating
            ? t("settings:signature.aiGenerating")
            : t("settings:signature.ai")}
        </button>
        <ConfirmButton
          label={t("settings:signature.delete")}
          confirmLabel={t("settings:signature.deleteConfirm")}
          onConfirm={() => onDelete(sig.id)}
        />
      </div>
      {/* Editor body: toolbar + contenteditable share the card, no inner border. */}
      <div className="px-3 pb-1">
        <RichBody
          value={html}
          onChange={setHtml}
          onBlur={() => html !== sig.html && commit({ html })}
          placeholder={t("settings:signature.placeholder")}
          minHeightClass="min-h-[72px]"
        />
      </div>
    </div>
  );
}

function AccountsSection() {
  const { t } = useTranslation();
  const { data: accounts } = useAccounts();
  const { data: settings } = useSettings();
  const accountThemes = settings?.accountThemes ?? {};
  const pushToast = useUi((s) => s.pushToast);
  const set = useUi((s) => s.set);
  const [oauthBusy, setOauthBusy] = useState<Provider | null>(null);

  const removeAccount = async (accountId: number, email: string) => {
    try {
      await call("remove_account", { accountId });
      pushToast({
        kind: "info",
        message: t("settings:accounts.removed", { email }),
      });
    } catch (err) {
      pushToast({
        kind: "error",
        message: t("settings:accounts.removeFailed", {
          detail: errorMessage(err),
        }),
      });
    } finally {
      void queryClient.invalidateQueries({ queryKey: ["accounts"] });
      void queryClient.invalidateQueries({ queryKey: ["threads"] });
      void queryClient.invalidateQueries({ queryKey: ["unreadCounts"] });
    }
  };

  const oauth = async (provider: "gmail" | "microsoft") => {
    setOauthBusy(provider);
    try {
      await call("start_oauth", { provider });
      await queryClient.invalidateQueries({ queryKey: ["accounts"] });
      pushToast({ kind: "info", message: t("settings:accounts.connected") });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : t("errors:oauthFailed");
      if (!message.includes("sign-in cancelled")) {
        pushToast(
          message.includes("no OAuth app configured")
            ? {
                kind: "info",
                message: t("settings:accounts.configureOauthFirst"),
                durationMs: 6000,
              }
            : { kind: "error", message },
        );
      }
    } finally {
      setOauthBusy(null);
    }
  };

  const cancelOauth = () => {
    void call("cancel_oauth", {}).catch(() => {});
  };

  const [reauthId, setReauthId] = useState<number | null>(null);
  const reauth = async (accountId: number, email: string) => {
    if (reauthId === accountId) {
      cancelOauth();
      return;
    }
    setReauthId(accountId);
    try {
      await call("reauth_account", { accountId });
      await queryClient.invalidateQueries({ queryKey: ["accounts"] });
      pushToast({
        kind: "info",
        message: t("settings:sync.reauthDone", { email }),
      });
    } catch (err) {
      const message = errorMessage(err);
      if (!message.includes("sign-in cancelled")) {
        pushToast({
          kind: "error",
          message: t("settings:sync.reauthFailed", { email, detail: message }),
        });
      }
    } finally {
      setReauthId(null);
    }
  };

  return (
    <section>
      <SectionLabel>{t("settings:section.accounts")}</SectionLabel>
      <div className="flex flex-col gap-1.5">
        {(accounts ?? []).map((a) => (
          <div
            key={a.id}
            className="flex items-center gap-2.5 rounded-lg border border-hairline bg-bg0 px-3 py-2"
          >
            <span
              className="size-2 shrink-0 rounded-full"
              style={{ background: SYNC_DOT[a.syncState] }}
              title={t(`common:syncState.${a.syncState}`)}
            />
            <span className="min-w-0 flex-1 truncate">
              <span className="text-[13px] text-ink">{a.email}</span>
              {a.displayName && (
                <span className="ml-2 text-[11.5px] text-ink-faint">
                  {a.displayName}
                </span>
              )}
            </span>
            <Select
              className="!w-auto !py-1 !pr-8 !text-[12.5px]"
              value={accountThemes[String(a.id)] ?? "system"}
              title={t("settings:accounts.themeHint")}
              onChange={(e) =>
                void updateSettings({
                  accountThemes: {
                    ...accountThemes,
                    [String(a.id)]: e.target.value as Settings["theme"],
                  },
                })
              }
            >
              <option value="system">
                {t("settings:accounts.themeInherit")}
              </option>
              <option value="snow">{t("settings:theme.snow")}</option>
              <option value="carbon">{t("settings:theme.carbon")}</option>
              <option value="holiday">{t("settings:theme.holiday")}</option>
            </Select>
            <span className="rounded bg-bg2 px-1.5 py-px text-[10.5px] font-semibold tracking-wide text-ink-faint uppercase">
              {t(`settings:accounts.provider.${a.provider}`)}
            </span>
            {a.syncState === "needs_reauth" && a.provider !== "imap" && (
              <button
                type="button"
                className={ghostBtnCls}
                disabled={reauthId != null && reauthId !== a.id}
                onClick={() => void reauth(a.id, a.email)}
              >
                {reauthId === a.id
                  ? t("settings:sync.reauthWaiting")
                  : t("settings:sync.reauth")}
              </button>
            )}
            <ConfirmButton
              label={t("settings:accounts.remove")}
              confirmLabel={t("settings:accounts.reallyRemove")}
              onConfirm={() => void removeAccount(a.id, a.email)}
            />
          </div>
        ))}
        {(accounts ?? []).length === 0 && (
          <p className="py-1 text-[12.5px] text-ink-faint">
            {t("settings:accounts.empty")}
          </p>
        )}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          className={ghostBtnCls}
          onClick={() => set({ addAccountOpen: true })}
        >
          {t("settings:accounts.addImap")}
        </button>
        <button
          className={ghostBtnCls}
          disabled={oauthBusy != null && oauthBusy !== "gmail"}
          onClick={() =>
            oauthBusy === "gmail" ? cancelOauth() : void oauth("gmail")
          }
        >
          {oauthBusy === "gmail"
            ? t("settings:accounts.cancelWaiting", {
                waiting: t("settings:accounts.waitingGoogle"),
              })
            : t("settings:accounts.signInGoogle")}
        </button>
        <button
          className={ghostBtnCls}
          disabled={oauthBusy != null && oauthBusy !== "microsoft"}
          onClick={() =>
            oauthBusy === "microsoft" ? cancelOauth() : void oauth("microsoft")
          }
        >
          {oauthBusy === "microsoft"
            ? t("settings:accounts.cancelWaiting", {
                waiting: t("settings:accounts.waitingMicrosoft"),
              })
            : t("settings:accounts.signInMicrosoft")}
        </button>
      </div>
    </section>
  );
}
