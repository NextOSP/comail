import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { call } from "../../ipc/commands";
import { errorMessage } from "../../ipc/errors";
import type {
  DecisionEndpoint,
  DecisionProvider,
  DecisionTestResult,
  Settings,
} from "../../ipc/types";
import { queryClient } from "../../queries/client";
import { useAiStatus } from "../../queries/hooks";
import { useUi } from "../../stores/ui";
import {
  Button,
  IconButton,
  inputCls,
  Segmented,
  Select,
  SettingRow,
  SettingsGroup,
  Toggle,
} from "./panelKit";

type Provider = Exclude<DecisionProvider, "off">;

/** Known decision models per provider, offered as suggestions. */
const MODEL_SUGGESTIONS: Record<Provider, string[]> = {
  openrouter: [
    "typesafe/jev-1.14",
    "~typesafe/jev-latest",
    "typesafe/jev-1.13",
    "openai/gpt-6-luna-decisions",
    "liquid/d1",
  ],
  openai: ["gpt-6-luna"],
  custom: [],
};

function defaultModel(ep: DecisionEndpoint): string {
  return ep.provider === "openai" ||
    (ep.provider === "custom" && ep.format === "openai")
    ? "gpt-6-luna"
    : "typesafe/jev-1.14";
}

/** Primary (flat settings fields) + backups, as one ordered list. */
function chainOf(s: Settings): DecisionEndpoint[] {
  const primary: DecisionEndpoint[] =
    s.decisionProvider === "off"
      ? []
      : [
          {
            provider: s.decisionProvider,
            model: s.decisionModel,
            baseUrl: s.decisionBaseUrl,
            format: s.decisionFormat,
          },
        ];
  return [...primary, ...s.decisionBackups];
}

/** Settings patch storing `chain` back into the primary fields + backups. */
function chainPatch(chain: DecisionEndpoint[]): Partial<Settings> {
  const [first, ...rest] = chain;
  return first
    ? {
        decisionProvider: first.provider,
        decisionModel: first.model,
        decisionBaseUrl: first.baseUrl,
        decisionFormat: first.format === "openai" ? "openai" : "openrouter",
        decisionBackups: rest,
      }
    : { decisionProvider: "off", decisionBackups: [] };
}

/** Decision models (TypeSafe Jev, OpenAI Decisions API, ...) for categories,
 *  rule and split AI checks: an ordered provider chain, where they're used,
 *  the chat-model fallback, and a reachability test. */
export function DecisionSettings({
  settings,
  update,
}: {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
}) {
  const { t } = useTranslation();
  const { data: status } = useAiStatus();
  const [results, setResults] = useState<DecisionTestResult[] | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const chain = chainOf(settings);

  // Results describe the old chain once anything changes.
  const chainKey = JSON.stringify(chain);
  useEffect(() => {
    setResults(null);
    setTestError(null);
  }, [chainKey]);

  const commit = (patch: Partial<Settings>) => {
    update(patch);
    void queryClient.invalidateQueries({ queryKey: ["aiStatus"] });
  };
  const setChain = (next: DecisionEndpoint[]) => commit(chainPatch(next));
  const setAt = (i: number, ep: DecisionEndpoint) =>
    setChain(chain.map((x, j) => (j === i ? ep : x)));
  const move = (i: number, by: number) => {
    const next = [...chain];
    const [ep] = next.splice(i, 1);
    next.splice(i + by, 0, ep);
    setChain(next);
  };
  const add = () => {
    // Suggest the provider not used yet: a backup on another network helps
    // most when one is down.
    const used = new Set(chain.map((e) => e.provider));
    const provider: Provider = !used.has("openrouter")
      ? "openrouter"
      : !used.has("openai")
        ? "openai"
        : "custom";
    setChain([...chain, { provider, model: "", baseUrl: "", format: "openrouter" }]);
  };

  const runTest = async () => {
    setTesting(true);
    setTestError(null);
    try {
      setResults(await call("test_decision_provider", {}));
    } catch (err) {
      setResults(null);
      setTestError(errorMessage(err));
    } finally {
      setTesting(false);
    }
  };

  // What answers once decision models are exhausted.
  const onDevice = settings.aiBaseUrl.trim().toLowerCase().startsWith("apple:");
  const chatName = !status?.configured
    ? null
    : onDevice
      ? t("settings:decision.onDevice")
      : status.model;

  return (
    <SettingsGroup
      title={t("settings:decision.section")}
      description={t("settings:decision.intro")}
    >
      <div className="flex flex-col gap-2.5 px-4 py-3.5">
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="text-base font-medium text-ink">
              {t("settings:decision.chainLabel")}
            </div>
            <p className="mt-0.5 text-xs text-ink-faint">
              {t("settings:decision.chainHint")}
            </p>
          </div>
          <Button size="sm" icon="plus" onClick={add}>
            {chain.length === 0
              ? t("settings:decision.addProvider")
              : t("settings:decision.addBackup")}
          </Button>
        </div>
        {chain.length === 0 && (
          <p className="rounded-card border border-dashed border-hairline px-3 py-2.5 text-xs text-ink-faint">
            {t("settings:decision.chainEmpty")}
          </p>
        )}
        {chain.map((ep, i) => (
          <EndpointRow
            key={i}
            index={i}
            ep={ep}
            count={chain.length}
            result={results?.[i]}
            onChange={(next) => setAt(i, next)}
            onRemove={() => setChain(chain.filter((_, j) => j !== i))}
            onMove={(by) => move(i, by)}
          />
        ))}
        {chain.length > 0 && (
          <div className="flex items-center gap-2">
            <Button size="sm" busy={testing} onClick={() => void runTest()}>
              {t("settings:decision.testAll")}
            </Button>
            {testError && (
              <span className="text-xs text-danger" role="status">
                {testError}
              </span>
            )}
          </div>
        )}
      </div>

      <SettingRow
        label={t("settings:decision.useForLabel")}
        hint={t("settings:decision.useForHint")}
      >
        <div className="flex flex-col items-end gap-1.5">
          {(
            [
              ["decisionUseCategories", "categories"],
              ["decisionUseRules", "rules"],
              ["decisionUseSplits", "splits"],
            ] as const
          ).map(([key, name]) => (
            <span key={key} className="flex items-center gap-2 text-sm text-ink-muted">
              {t(`settings:decision.useFor.${name}`)}
              <Toggle
                label={t(`settings:decision.useFor.${name}`)}
                checked={settings[key]}
                onChange={(on) => commit({ [key]: on })}
              />
            </span>
          ))}
        </div>
      </SettingRow>

      <SettingRow
        label={t("settings:decision.chatFallbackLabel")}
        hint={
          chatName
            ? t("settings:decision.chatFallbackHint", { model: chatName })
            : t("settings:decision.chatFallbackNone")
        }
      >
        <Toggle
          label={t("settings:decision.chatFallbackLabel")}
          checked={settings.decisionChatFallback}
          onChange={(decisionChatFallback) => commit({ decisionChatFallback })}
        />
      </SettingRow>

      <SettingRow
        label={t("settings:decision.confidenceLabel")}
        hint={t("settings:decision.confidenceHint")}
      >
        <ConfidenceSlider
          value={settings.decisionMinConfidence}
          onChange={(decisionMinConfidence) => commit({ decisionMinConfidence })}
        />
      </SettingRow>

      <SettingRow
        label={t("settings:decision.noAiLabel")}
        hint={t("settings:decision.noAiHint")}
      >
        <span className="text-xs text-ink-faint">
          {chain.length === 0 && !chatName
            ? t("settings:decision.noAiActive")
            : t("settings:decision.noAiStandby")}
        </span>
      </SettingRow>
    </SettingsGroup>
  );
}

/** 50–95% slider; also used for per-rule overrides. */
export function ConfidenceSlider({
  value,
  onChange,
  label,
}: {
  value: number;
  onChange: (v: number) => void;
  label?: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2.5">
      <input
        type="range"
        min={0.5}
        max={0.95}
        step={0.05}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={label ?? t("settings:decision.confidenceLabel")}
        className="w-[160px] accent-[var(--accent)]"
      />
      <span className="w-10 text-sm text-ink-muted tabular-nums">
        {Math.round(value * 100)}%
      </span>
    </div>
  );
}

function EndpointRow({
  index,
  ep,
  count,
  result,
  onChange,
  onRemove,
  onMove,
}: {
  index: number;
  ep: DecisionEndpoint;
  count: number;
  result?: DecisionTestResult;
  onChange: (ep: DecisionEndpoint) => void;
  onRemove: () => void;
  onMove: (by: number) => void;
}) {
  const { t } = useTranslation();
  const pushToast = useUi((s) => s.pushToast);
  const [model, setModel] = useState(ep.model);
  const [baseUrl, setBaseUrl] = useState(ep.baseUrl);
  const [apiKey, setApiKey] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  useEffect(() => setModel(ep.model), [ep.model]);
  useEffect(() => setBaseUrl(ep.baseUrl), [ep.baseUrl]);

  const saveKey = async () => {
    setSavingKey(true);
    try {
      await call("set_decision_key", { provider: ep.provider, apiKey: apiKey.trim() });
      pushToast({
        kind: "info",
        message: apiKey.trim()
          ? t("settings:decision.keySaved")
          : t("settings:decision.keyCleared"),
        durationMs: 2500,
      });
      setApiKey("");
      void queryClient.invalidateQueries({ queryKey: ["aiStatus"] });
    } catch (err) {
      pushToast({ kind: "error", message: errorMessage(err) });
    } finally {
      setSavingKey(false);
    }
  };

  const listId = `decision-models-${index}`;
  return (
    <div className="rounded-card border border-hairline bg-bg0 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-bg2 px-2 py-0.5 text-2xs font-semibold text-ink-faint">
          {index === 0
            ? t("settings:decision.primary")
            : t("settings:decision.backupN", { n: index })}
        </span>
        <Select
          aria-label={t("settings:decision.providerLabel")}
          value={ep.provider}
          onChange={(e) =>
            onChange({ ...ep, provider: e.target.value as Provider, model: "" })
          }
        >
          <option value="openrouter">{t("settings:decision.provider.openrouter")}</option>
          <option value="openai">{t("settings:decision.provider.openai")}</option>
          <option value="custom">{t("settings:decision.provider.custom")}</option>
        </Select>
        <span className="ml-auto flex items-center gap-1">
          <IconButton
            icon="chevronUp"
            size="xs"
            label={t("settings:decision.moveUp")}
            disabled={index === 0}
            onClick={() => onMove(-1)}
          />
          <IconButton
            icon="chevronDown"
            size="xs"
            label={t("settings:decision.moveDown")}
            disabled={index === count - 1}
            onClick={() => onMove(1)}
          />
          <IconButton
            icon="close"
            size="xs"
            label={t("settings:decision.remove")}
            onClick={onRemove}
          />
        </span>
      </div>
      <div className="mt-2.5 grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2">
        {ep.provider === "custom" && (
          <>
            <span className="text-xs text-ink-faint">{t("settings:decision.urlLabel")}</span>
            <input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              onBlur={() => baseUrl.trim() !== ep.baseUrl && onChange({ ...ep, baseUrl: baseUrl.trim() })}
              placeholder="https://…/v1/decisions"
              spellCheck={false}
              className={inputCls}
            />
            <span className="text-xs text-ink-faint">{t("settings:decision.formatLabel")}</span>
            <div>
              <Segmented<"openrouter" | "openai">
                value={ep.format === "openai" ? "openai" : "openrouter"}
                options={[
                  { value: "openrouter", label: t("settings:decision.format.openrouter") },
                  { value: "openai", label: t("settings:decision.format.openai") },
                ]}
                onChange={(format) => onChange({ ...ep, format })}
              />
            </div>
          </>
        )}
        <span className="text-xs text-ink-faint">{t("settings:decision.modelLabel")}</span>
        <input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          onBlur={() => model.trim() !== ep.model && onChange({ ...ep, model: model.trim() })}
          placeholder={defaultModel(ep)}
          spellCheck={false}
          list={listId}
          className={inputCls}
        />
        <datalist id={listId}>
          {MODEL_SUGGESTIONS[ep.provider].map((id) => (
            <option key={id} value={id} />
          ))}
        </datalist>
        <span className="text-xs text-ink-faint">{t("settings:decision.keyLabel")}</span>
        <div className="flex items-center gap-2">
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void saveKey();
            }}
            placeholder={
              ep.provider === "openai"
                ? t("settings:decision.keyPlaceholderOpenai")
                : t("settings:decision.keyPlaceholder")
            }
            autoComplete="off"
            className={inputCls}
          />
          <Button size="sm" busy={savingKey} onClick={() => void saveKey()}>
            {t("settings:ai.save")}
          </Button>
        </div>
      </div>
      {result && (
        <p
          className={`mt-2 text-xs ${result.ok ? "text-ink-faint" : "text-danger"}`}
          role="status"
        >
          <span
            className="mr-1.5 inline-block size-2 rounded-full align-middle"
            style={{ background: result.ok ? "var(--ok)" : "var(--danger)" }}
          />
          {result.ok
            ? t("settings:decision.testOk", {
                model: result.model,
                ms: result.latencyMs,
                pct: Math.round(result.probability * 100),
              })
            : t("settings:decision.testFailedOne", { detail: result.error })}
        </p>
      )}
    </div>
  );
}
