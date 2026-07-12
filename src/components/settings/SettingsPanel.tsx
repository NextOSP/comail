import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import i18n, { setLanguage, SUPPORTED_LANGUAGES, SYSTEM_LANGUAGE } from "../../i18n";
import { call } from "../../ipc/commands";
import { errorMessage } from "../../ipc/errors";
import { appVersion, checkForUpdate, installUpdate } from "../../ipc/updater";
import type { Provider, Settings, SyncState } from "../../ipc/types";
import { queryClient } from "../../queries/client";
import {
  useAccounts,
  useAiModels,
  useAiStatus,
  useEmbeddingStatus,
  useLearnVoice,
  useSettings,
} from "../../queries/hooks";
import { commandScore } from "../../keyboard/commandScore";
import { useUi } from "../../stores/ui";
import { LabelsSection } from "./LabelsPanel";
import { SnippetsSection } from "./SnippetsPanel";
import { SplitInboxSection } from "./SplitsPanel";
import {
  ConfirmButton,
  ghostBtnCls,
  inputCls,
  PanelShell,
  PanelTab,
  primaryBtnCls,
  SectionLabel,
  Segmented,
  SettingRow,
  Toggle,
} from "./panelKit";

type SettingsTab = "general" | "splits" | "snippets" | "labels" | "ai" | "accounts";

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
  googleClientId: "",
  googleClientSecret: "",
  msClientId: "",
  msClientSecret: "",
  embeddingBackend: "local",
  embeddingModel: "bge-small-en-v1.5",
  voiceDrafting: false,
  voiceProfile: "",
  voiceLearnedAt: 0,
  notificationsEnabled: true,
  autoAdvance: true,
  autoLabelsEnabled: true,
  signatures: {},
};

/** Optimistic settings write: cache first, backend follows, rollback on error. */
async function updateSettings(patch: Partial<Settings>) {
  const cur = queryClient.getQueryData<Settings>(["settings"]) ?? DEFAULT_SETTINGS;
  const next: Settings = { ...cur, ...patch };
  queryClient.setQueryData(["settings"], next);
  if (patch.theme) useUi.getState().set({ theme: patch.theme });
  try {
    await call("set_settings", { settings: next });
  } catch (err) {
    useUi.getState().pushToast({
      kind: "error",
      message: i18n.t("settings:toast.settingsSaveFailed", { detail: errorMessage(err) }),
    });
    void queryClient.invalidateQueries({ queryKey: ["settings"] });
  }
}

export function SettingsPanel() {
  const { t } = useTranslation();
  const open = useUi((s) => s.panel === "settings");
  const requestedTab = useUi((s) => s.settingsTab);
  const set = useUi((s) => s.set);
  const { data: settings } = useSettings();
  const [tab, setTab] = useState<SettingsTab>("general");
  const [query, setQuery] = useState("");

  const TAB_KEYS: SettingsTab[] = ["general", "splits", "snippets", "labels", "ai", "accounts"];

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

  // Jump to a tab and drop out of search mode.
  const goTab = (next: SettingsTab) => {
    setTab(next);
    setQuery("");
  };

  const TAB_LABELS: Record<SettingsTab, string> = {
    general: t("settings:section.preferences"),
    splits: t("settings:section.splitInbox"),
    snippets: t("settings:section.snippets"),
    labels: t("settings:section.labels"),
    ai: t("settings:section.ai"),
    accounts: t("settings:section.accounts"),
  };

  // Flat index of every setting, so search can jump straight to its tab.
  // `label` is localized (matches localized queries); `keywords` add English synonyms.
  const INDEX: { tab: SettingsTab; label: string; keywords: string }[] = [
    { tab: "general", label: t("settings:theme.label"), keywords: "appearance dark light snow carbon color" },
    { tab: "general", label: t("settings:language.label"), keywords: "locale translation" },
    { tab: "general", label: t("settings:undoSend.label"), keywords: "undo send delay cancel" },
    { tab: "general", label: t("settings:loadRemoteImages.label"), keywords: "images privacy tracking pixels remote" },
    { tab: "general", label: t("settings:notifications.label"), keywords: "notify alerts desktop" },
    { tab: "general", label: t("settings:autoAdvance.label"), keywords: "auto advance next thread cursor" },
    { tab: "splits", label: t("settings:autoLabels.label"), keywords: "auto labels categorize" },
    { tab: "splits", label: t("settings:section.splitInbox"), keywords: "split inbox tabs rules important other sender subject" },
    { tab: "snippets", label: t("settings:snippets.title"), keywords: "snippets templates canned responses shortcuts" },
    { tab: "labels", label: t("settings:labels.title"), keywords: "labels tags colors folders" },
    { tab: "ai", label: t("settings:section.ai"), keywords: "ai provider model api key openai anthropic openrouter" },
    { tab: "ai", label: "Semantic search", keywords: "semantic search embeddings vector meaning offline reindex" },
    { tab: "ai", label: "Writing voice", keywords: "voice draft style learn tone" },
    { tab: "accounts", label: t("settings:section.accounts"), keywords: "accounts add remove gmail microsoft imap oauth" },
    { tab: "accounts", label: t("settings:signature.section"), keywords: "signature sign-off footer" },
    { tab: "accounts", label: t("settings:section.oauthApps"), keywords: "oauth client id secret google microsoft app credentials" },
    { tab: "general", label: t("settings:about.section"), keywords: "about version update upgrade release check" },
  ];

  const q = query.trim();
  const results =
    q === ""
      ? []
      : INDEX.map((e) => ({ e, score: commandScore(`${e.label} ${e.keywords}`, q) }))
          .filter((r) => r.score > 0)
          .sort((a, b) => b.score - a.score)
          .map((r) => r.e);

  const tabs = (
    <>
      {TAB_KEYS.map((k) => (
        <PanelTab key={k} active={tab === k && q === ""} onClick={() => goTab(k)}>
          {TAB_LABELS[k]}
        </PanelTab>
      ))}
    </>
  );

  const search = (
    <input
      className={`${inputCls} !w-[220px] !py-1.5`}
      placeholder={t("settings:search.placeholder")}
      value={query}
      onChange={(e) => setQuery(e.target.value)}
      spellCheck={false}
      aria-label={t("settings:search.placeholder")}
    />
  );

  if (q !== "") {
    return (
      <PanelShell title={t("settings:title")} onClose={() => set({ panel: null })} tabs={tabs} search={search} width={640}>
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
    <PanelShell title={t("settings:title")} onClose={() => set({ panel: null })} tabs={tabs} search={search} width={640}>
      <div className="flex flex-col gap-7">
        {tab === "general" && (
          <section className="flex flex-col gap-4">
            <SettingRow label={t("settings:theme.label")} hint={t("settings:theme.hint")}>
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
            <SettingRow label={t("settings:language.label")} hint={t("settings:language.hint")}>
              <select
                value={s.language}
                onChange={(e) => {
                  setLanguage(e.target.value);
                  void updateSettings({ language: e.target.value });
                }}
                className={`${inputCls} !w-[200px]`}
              >
                <option value={SYSTEM_LANGUAGE}>{t("settings:language.system")}</option>
                {SUPPORTED_LANGUAGES.map((code) => (
                  <option key={code} value={code}>
                    {LANGUAGE_NAMES[code] ?? code}
                  </option>
                ))}
              </select>
            </SettingRow>
            <SettingRow label={t("settings:undoSend.label")} hint={t("settings:undoSend.hint")}>
              <Segmented
                value={s.undoSendSeconds}
                options={[5, 10, 20, 30].map((n) => ({
                  value: n,
                  label: t("settings:undoSend.seconds", { n }),
                }))}
                onChange={(undoSendSeconds) => void updateSettings({ undoSendSeconds })}
              />
            </SettingRow>
            <SettingRow
              label={t("settings:loadRemoteImages.label")}
              hint={t("settings:loadRemoteImages.hint")}
            >
              <Toggle
                label={t("settings:loadRemoteImages.label")}
                checked={s.loadRemoteImages}
                onChange={(loadRemoteImages) => void updateSettings({ loadRemoteImages })}
              />
            </SettingRow>
            <SettingRow
              label={t("settings:notifications.label")}
              hint={t("settings:notifications.hint")}
            >
              <Toggle
                label={t("settings:notifications.label")}
                checked={s.notificationsEnabled}
                onChange={(notificationsEnabled) => void updateSettings({ notificationsEnabled })}
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
            <AboutSection />
          </section>
        )}

        {tab === "splits" && (
          <>
            <SettingRow
              label={t("settings:autoLabels.label")}
              hint={t("settings:autoLabels.hint")}
            >
              <Toggle
                label={t("settings:autoLabels.label")}
                checked={s.autoLabelsEnabled}
                onChange={(autoLabelsEnabled) => void updateSettings({ autoLabelsEnabled })}
              />
            </SettingRow>
            <SplitInboxSection />
          </>
        )}

        {tab === "snippets" && <SnippetsSection />}

        {tab === "labels" && <LabelsSection />}

        {tab === "ai" && (
          <>
            <AiSection settings={s} />
            <SemanticSearchSection settings={s} />
            <VoiceSection settings={s} />
          </>
        )}

        {tab === "accounts" && (
          <>
            <AccountsSection />
            <SignaturesSection settings={s} />
            <OAuthSection settings={s} />
          </>
        )}
      </div>
    </PanelShell>
  );
}

/** Known OpenAI-compatible providers; picking one fills the base URL. */
const AI_PROVIDER_PRESETS: { id: string; label: string; baseUrl: string; defaultModel?: string }[] = [
  { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", defaultModel: "openai/gpt-4o-mini" },
  { id: "anthropic", label: "Anthropic (Claude)", baseUrl: "https://api.anthropic.com/v1", defaultModel: "claude-sonnet-4-5" },
  { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", defaultModel: "gpt-4o-mini" },
  { id: "lmstudio", label: "LM Studio (local)", baseUrl: "http://localhost:1234/v1" },
  { id: "ollama", label: "Ollama (local)", baseUrl: "http://localhost:11434/v1" },
  { id: "minimax", label: "MiniMax", baseUrl: "https://api.minimax.io/v1", defaultModel: "MiniMax-M2" },
  { id: "kimi", label: "Kimi (Moonshot)", baseUrl: "https://api.moonshot.ai/v1", defaultModel: "kimi-k2-turbo-preview" },
  { id: "zai", label: "Z.ai (GLM)", baseUrl: "https://api.z.ai/api/paas/v4", defaultModel: "glm-4.6" },
];

/** Version readout plus a manual "check for updates" against GitHub Releases. */
function AboutSection() {
  const { t } = useTranslation();
  const pushToast = useUi((s) => s.pushToast);
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
          message: t("settings:about.updateAvailable", { version: update.version }),
          actionLabel: t("settings:about.restartInstall"),
          onAction: () => void installUpdate(update),
          durationMs: 30000,
        });
      } else {
        pushToast({ kind: "info", message: t("settings:about.upToDate"), durationMs: 3000 });
      }
    } catch (err) {
      pushToast({ kind: "error", message: errorMessage(err) });
    } finally {
      setChecking(false);
    }
  }

  return (
    <section className="mt-3 flex flex-col gap-4 border-t border-hairline pt-5">
      <SectionLabel>{t("settings:about.section")}</SectionLabel>
      <SettingRow label={t("settings:about.version")} hint={t("settings:about.versionHint")}>
        <div className="flex items-center gap-3">
          <span className="text-[13px] tabular-nums text-ink-muted">{version || "…"}</span>
          <button className={ghostBtnCls} onClick={() => void onCheck()} disabled={checking}>
            {checking ? t("settings:about.checking") : t("settings:about.checkUpdates")}
          </button>
        </div>
      </SettingRow>
    </section>
  );
}

function AiSection({ settings }: { settings: Settings }) {
  const { t } = useTranslation();
  const { data: status } = useAiStatus();
  const pushToast = useUi((s) => s.pushToast);
  const [apiKey, setApiKey] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const [baseUrl, setBaseUrl] = useState(settings.aiBaseUrl);
  const [model, setModel] = useState(settings.aiModel);
  const [forceCustom, setForceCustom] = useState(false);
  const baseUrlRef = useRef<HTMLInputElement>(null);
  const { data: models } = useAiModels(settings.aiBaseUrl);

  // Follow external settings refreshes (initial load, other writers).
  useEffect(() => setBaseUrl(settings.aiBaseUrl), [settings.aiBaseUrl]);
  useEffect(() => setModel(settings.aiModel), [settings.aiModel]);

  const saveKey = async () => {
    setSavingKey(true);
    try {
      await call("set_ai_key", { apiKey: apiKey.trim() });
      pushToast({
        kind: "info",
        message: apiKey.trim() ? t("settings:ai.keySaved") : t("settings:ai.keyCleared"),
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
      <SectionLabel>{t("settings:section.ai")}</SectionLabel>
      <SettingRow
        label={t("settings:ai.statusLabel")}
        hint={t("settings:ai.statusHint")}
      >
        <span className="flex items-center gap-2 text-[12.5px] text-ink-muted">
          <span
            className="size-2 rounded-full"
            style={{ background: status?.configured ? "var(--ok)" : "var(--bg4)" }}
          />
          {status
            ? status.configured
              ? t("settings:ai.configured", { model: status.model })
              : t("settings:ai.notConfigured")
            : t("settings:ai.loading")}
        </span>
      </SettingRow>
      <SettingRow label={t("settings:ai.apiKeyLabel")} hint={t("settings:ai.apiKeyHint")}>
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
          <button className={primaryBtnCls} disabled={savingKey} onClick={() => void saveKey()}>
            {t("settings:ai.save")}
          </button>
        </div>
      </SettingRow>
      <SettingRow label={t("settings:ai.providerLabel")} hint={t("settings:ai.providerHint")}>
        <select
          value={
            forceCustom
              ? "custom"
              : (AI_PROVIDER_PRESETS.find((p) => p.baseUrl === settings.aiBaseUrl)?.id ?? "custom")
          }
          onChange={(e) => {
            if (e.target.value === "custom") {
              // Keep whatever URL is set and hand focus to the field below.
              setForceCustom(true);
              baseUrlRef.current?.focus();
              baseUrlRef.current?.select();
              return;
            }
            const preset = AI_PROVIDER_PRESETS.find((p) => p.id === e.target.value);
            if (!preset) return;
            setForceCustom(false);
            void updateSettings({
              aiBaseUrl: preset.baseUrl,
              ...(preset.defaultModel ? { aiModel: preset.defaultModel } : {}),
            });
          }}
          className={`${inputCls} !w-[280px]`}
        >
          {AI_PROVIDER_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
          <option value="custom">{t("settings:ai.customProvider")}</option>
        </select>
      </SettingRow>
      <SettingRow label={t("settings:ai.baseUrlLabel")} hint={t("settings:ai.baseUrlHint")}>
        <input
          ref={baseUrlRef}
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          onBlur={() => commitField({ aiBaseUrl: baseUrl.trim() })}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitField({ aiBaseUrl: baseUrl.trim() });
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
    </section>
  );
}

/** Local embedding models mirrored from the Rust `embed::registry`. */
const EMBEDDING_MODELS: { id: string; label: string }[] = [
  { id: "bge-small-en-v1.5", label: "BGE Small (384d · fast · bundled)" },
  { id: "all-MiniLM-L6-v2", label: "MiniLM L6 (384d · fast)" },
  { id: "bge-base-en-v1.5", label: "BGE Base (768d · higher quality)" },
];

/** Semantic search: local embedding backend, model picker, index progress. */
function SemanticSearchSection({ settings }: { settings: Settings }) {
  const { data: status } = useEmbeddingStatus();
  const pushToast = useUi((s) => s.pushToast);
  const [reindexing, setReindexing] = useState(false);

  const on = settings.embeddingBackend === "local";
  const pct =
    status && status.total > 0 ? Math.round((status.embedded / status.total) * 100) : 0;

  const reindex = async () => {
    setReindexing(true);
    try {
      const n = await call("semantic_reindex", {});
      pushToast({ kind: "info", message: `Re-indexing ${n} messages…`, durationMs: 2500 });
      void queryClient.invalidateQueries({ queryKey: ["embeddingStatus"] });
    } catch (err) {
      pushToast({ kind: "error", message: errorMessage(err) });
    } finally {
      setReindexing(false);
    }
  };

  return (
    <section className="flex flex-col gap-4">
      <SectionLabel>Semantic search</SectionLabel>
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
            void updateSettings({ embeddingBackend: embeddingBackend as "local" | "off" })
          }
        />
      </SettingRow>
      {on && (
        <>
          <SettingRow label="Model" hint="Larger models are more accurate but slower to index.">
            <select
              value={settings.embeddingModel}
              onChange={(e) => void updateSettings({ embeddingModel: e.target.value })}
              className={`${inputCls} !w-[280px]`}
            >
              {EMBEDDING_MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
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
                  className="h-full rounded-full bg-[var(--accent)] transition-[width]"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <button className={ghostBtnCls} disabled={reindexing} onClick={() => void reindex()}>
                Rebuild
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
        pushToast({ kind: "info", message: "Learned your writing voice", durationMs: 2500 });
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
        <button className={primaryBtnCls} disabled={learn.isPending} onClick={runLearn}>
          {learn.isPending ? "Learning…" : learned ? "Re-learn my voice" : "Learn my voice"}
        </button>
      </SettingRow>
      {(learned || profile) && (
        <textarea
          value={profile}
          onChange={(e) => setProfile(e.target.value)}
          onBlur={() => {
            if (profile !== settings.voiceProfile) void updateSettings({ voiceProfile: profile });
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
  field: "googleClientId" | "googleClientSecret" | "msClientId" | "msClientSecret";
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
      steps: ["g1", "g2", "g3", "g4", "g5", "g6"],
    },
    {
      key: "ms",
      title: t("settings:oauth.guide.msTitle"),
      linkLabel: t("settings:oauth.guide.openMs"),
      url: "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
      steps: ["m1", "m2", "m3", "m4", "m5"],
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
          </div>
        ))}
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
        <Trans i18nKey="settings:oauth.description" components={{ b: <b />, code: <code /> }} />
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

/** Per-account signature, appended to new mail (stored in settings.signatures). */
function SignaturesSection({ settings }: { settings: Settings }) {
  const { t } = useTranslation();
  const { data: accounts } = useAccounts();
  if ((accounts ?? []).length === 0) return null;
  return (
    <section className="flex flex-col gap-4">
      <SectionLabel>{t("settings:signature.section")}</SectionLabel>
      {(accounts ?? []).map((a) => (
        <SignatureField key={a.id} accountId={a.id} email={a.email} settings={settings} />
      ))}
    </section>
  );
}

function SignatureField({
  accountId,
  email,
  settings,
}: {
  accountId: number;
  email: string;
  settings: Settings;
}) {
  const { t } = useTranslation();
  const saved = settings.signatures[String(accountId)] ?? "";
  const [value, setValue] = useState(saved);
  useEffect(() => setValue(saved), [saved]);

  const commit = () => {
    if (value === saved) return;
    const signatures = { ...settings.signatures };
    if (value.trim()) signatures[String(accountId)] = value;
    else delete signatures[String(accountId)];
    void updateSettings({ signatures });
  };

  return (
    <SettingRow label={email} hint={t("settings:signature.hint")}>
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        placeholder={t("settings:signature.placeholder")}
        rows={3}
        spellCheck={false}
        className={`${inputCls} !h-auto !w-[320px] resize-y py-1.5 leading-relaxed`}
      />
    </SettingRow>
  );
}

function AccountsSection() {
  const { t } = useTranslation();
  const { data: accounts } = useAccounts();
  const pushToast = useUi((s) => s.pushToast);
  const set = useUi((s) => s.set);
  const [oauthBusy, setOauthBusy] = useState<Provider | null>(null);

  const removeAccount = async (accountId: number, email: string) => {
    try {
      await call("remove_account", { accountId });
      pushToast({ kind: "info", message: t("settings:accounts.removed", { email }) });
    } catch (err) {
      pushToast({
        kind: "error",
        message: t("settings:accounts.removeFailed", { detail: errorMessage(err) }),
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
      const message = err instanceof Error ? err.message : t("errors:oauthFailed");
      pushToast(
        message.includes("no OAuth app configured")
          ? {
              kind: "info",
              message: t("settings:accounts.configureOauthFirst"),
              durationMs: 6000,
            }
          : { kind: "error", message },
      );
    } finally {
      setOauthBusy(null);
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
                <span className="ml-2 text-[11.5px] text-ink-faint">{a.displayName}</span>
              )}
            </span>
            <span className="rounded bg-bg2 px-1.5 py-px text-[10.5px] font-semibold tracking-wide text-ink-faint uppercase">
              {t(`settings:accounts.provider.${a.provider}`)}
            </span>
            <ConfirmButton
              label={t("settings:accounts.remove")}
              confirmLabel={t("settings:accounts.reallyRemove")}
              onConfirm={() => void removeAccount(a.id, a.email)}
            />
          </div>
        ))}
        {(accounts ?? []).length === 0 && (
          <p className="py-1 text-[12.5px] text-ink-faint">{t("settings:accounts.empty")}</p>
        )}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <button className={ghostBtnCls} onClick={() => set({ addAccountOpen: true })}>
          {t("settings:accounts.addImap")}
        </button>
        <button
          className={ghostBtnCls}
          disabled={oauthBusy != null}
          onClick={() => void oauth("gmail")}
        >
          {oauthBusy === "gmail"
            ? t("settings:accounts.waitingGoogle")
            : t("settings:accounts.signInGoogle")}
        </button>
        <button
          className={ghostBtnCls}
          disabled={oauthBusy != null}
          onClick={() => void oauth("microsoft")}
        >
          {oauthBusy === "microsoft"
            ? t("settings:accounts.waitingMicrosoft")
            : t("settings:accounts.signInMicrosoft")}
        </button>
      </div>
    </section>
  );
}
