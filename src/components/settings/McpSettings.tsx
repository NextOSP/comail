// Settings > AI clients (MCP): the local MCP server that lets Claude Code,
// Claude Desktop, Cursor, VS Code, Codex, ChatGPT, ... use the mailbox, plus
// one-click "Add to <app>" for each client.

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { call } from "../../ipc/commands";
import { errorMessage } from "../../ipc/errors";
import { onEvent } from "../../ipc/events";
import type { McpClientInfo, Settings } from "../../ipc/types";
import { queryClient } from "../../queries/client";
import { useUi } from "../../stores/ui";
import {
  Button,
  ConfirmButton,
  inputCls,
  SettingRow,
  SettingsGroup,
  Toggle,
} from "./panelKit";
import { CLIENT_LOGOS } from "./mcpLogos";
import { updateSettings } from "./SettingsPanel";

function useMcpStatus() {
  return useQuery({
    queryKey: ["mcpStatus"],
    queryFn: () => call("mcp_status", {}),
    refetchInterval: 10_000,
  });
}

async function copyText(text: string) {
  await navigator.clipboard.writeText(text);
}

export function McpSection({ settings }: { settings: Settings }) {
  const { t } = useTranslation();
  const pushToast = useUi((s) => s.pushToast);
  const { data: status } = useMcpStatus();
  const { data: token } = useQuery({
    queryKey: ["mcpToken"],
    queryFn: () => call("mcp_get_token", {}),
    enabled: settings.mcpEnabled,
    staleTime: Infinity,
  });
  const [reveal, setReveal] = useState(false);
  const [port, setPort] = useState(String(settings.mcpPort));

  useEffect(() => setPort(String(settings.mcpPort)), [settings.mcpPort]);

  // The server restarts on save; refresh its status once the save lands.
  const save = async (patch: Partial<Settings>) => {
    await updateSettings(patch);
    void queryClient.invalidateQueries({ queryKey: ["mcpStatus"] });
    if (patch.mcpEnabled) void queryClient.invalidateQueries({ queryKey: ["mcpToken"] });
  };

  const commitPort = () => {
    const n = Number(port);
    if (!Number.isInteger(n) || n < 1024 || n > 65535) {
      pushToast({ kind: "error", message: t("settings:mcp.portInvalid") });
      setPort(String(settings.mcpPort));
      return;
    }
    if (n !== settings.mcpPort) void save({ mcpPort: n });
  };

  const copy = async (text: string, what: string) => {
    try {
      await copyText(text);
      pushToast({ kind: "info", message: t("settings:mcp.copied", { what }), durationMs: 2000 });
    } catch (err) {
      pushToast({ kind: "error", message: errorMessage(err) });
    }
  };

  const regenerate = async () => {
    try {
      await call("mcp_regenerate_token", {});
      void queryClient.invalidateQueries({ queryKey: ["mcpToken"] });
      void queryClient.invalidateQueries({ queryKey: ["mcpStatus"] });
      pushToast({ kind: "info", message: t("settings:mcp.tokenRegenerated") });
    } catch (err) {
      pushToast({ kind: "error", message: errorMessage(err) });
    }
  };

  const running = settings.mcpEnabled && status?.running;
  const url = status?.url ?? `http://127.0.0.1:${settings.mcpPort}/mcp`;

  return (
    <>
      <SettingsGroup title={t("settings:mcp.serverGroup")}>
        <SettingRow label={t("settings:mcp.enable")} hint={t("settings:mcp.enableHint")}>
          <Toggle
            label={t("settings:mcp.enable")}
            checked={settings.mcpEnabled}
            onChange={(mcpEnabled) => void save({ mcpEnabled })}
          />
        </SettingRow>
        {settings.mcpEnabled && (
          <>
            <SettingRow
              label={t("settings:mcp.status")}
              hint={status?.error ?? undefined}
            >
              <span className="flex items-center gap-2 text-sm">
                <span
                  className={`inline-block h-2 w-2 rounded-full ${
                    running ? "bg-accent" : status?.error ? "bg-danger" : "bg-bg4"
                  }`}
                />
                <span className={status?.error ? "text-danger" : "text-ink-muted"}>
                  {running
                    ? t("settings:mcp.running", { count: status?.clientCount ?? 0 })
                    : status?.error
                      ? t("settings:mcp.failed")
                      : t("settings:mcp.starting")}
                </span>
              </span>
            </SettingRow>
            <SettingRow label={t("settings:mcp.url")} hint={t("settings:mcp.urlHint")}>
              <div className="flex items-center gap-2">
                <code className="rounded bg-bg2 px-2 py-1 font-mono text-xs text-ink">{url}</code>
                <Button size="sm" icon="copy" onClick={() => void copy(url, t("settings:mcp.url"))}>
                  {t("settings:mcp.copy")}
                </Button>
              </div>
            </SettingRow>
            <SettingRow label={t("settings:mcp.port")} hint={t("settings:mcp.portHint")}>
              <input
                className={`${inputCls} w-24 text-right font-mono`}
                inputMode="numeric"
                aria-label={t("settings:mcp.port")}
                value={port}
                onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))}
                onBlur={commitPort}
                onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
              />
            </SettingRow>
            <SettingRow label={t("settings:mcp.token")} hint={t("settings:mcp.tokenHint")}>
              <div className="flex items-center gap-2">
                <code className="max-w-[180px] truncate rounded bg-bg2 px-2 py-1 font-mono text-xs text-ink">
                  {token ? (reveal ? token : "•".repeat(16)) : "…"}
                </code>
                <Button size="sm" onClick={() => setReveal((r) => !r)}>
                  {reveal ? t("settings:mcp.hide") : t("settings:mcp.show")}
                </Button>
                <Button
                  size="sm"
                  icon="copy"
                  disabled={!token}
                  onClick={() => token && void copy(token, t("settings:mcp.token"))}
                >
                  {t("settings:mcp.copy")}
                </Button>
                <ConfirmButton
                  label={t("settings:mcp.regenerate")}
                  confirmLabel={t("settings:mcp.regenerateConfirm")}
                  onConfirm={() => void regenerate()}
                />
              </div>
            </SettingRow>
          </>
        )}
      </SettingsGroup>

      {settings.mcpEnabled && (
        <>
          <SettingsGroup
            title={t("settings:mcp.permissionsGroup")}
            description={t("settings:mcp.permissionsIntro")}
          >
            <SettingRow label={t("settings:mcp.allowRead")} hint={t("settings:mcp.allowReadHint")}>
              <span className="text-xs text-ink-faint">{t("settings:mcp.alwaysOn")}</span>
            </SettingRow>
            <SettingRow label={t("settings:mcp.allowDrafts")} hint={t("settings:mcp.allowDraftsHint")}>
              <Toggle
                label={t("settings:mcp.allowDrafts")}
                checked={settings.mcpAllowDrafts}
                onChange={(mcpAllowDrafts) => void save({ mcpAllowDrafts })}
              />
            </SettingRow>
            <SettingRow label={t("settings:mcp.allowActions")} hint={t("settings:mcp.allowActionsHint")}>
              <Toggle
                label={t("settings:mcp.allowActions")}
                checked={settings.mcpAllowActions}
                onChange={(mcpAllowActions) => void save({ mcpAllowActions })}
              />
            </SettingRow>
            <SettingRow
              label={t("settings:mcp.allowPermanentDelete")}
              hint={t("settings:mcp.allowPermanentDeleteHint")}
            >
              <Toggle
                label={t("settings:mcp.allowPermanentDelete")}
                checked={settings.mcpAllowPermanentDelete}
                disabled={!settings.mcpAllowActions}
                onChange={(mcpAllowPermanentDelete) => void save({ mcpAllowPermanentDelete })}
              />
            </SettingRow>
            <SettingRow label={t("settings:mcp.allowSend")} hint={t("settings:mcp.allowSendHint")}>
              <Toggle
                label={t("settings:mcp.allowSend")}
                checked={settings.mcpAllowSend}
                onChange={(mcpAllowSend) => void save({ mcpAllowSend })}
              />
            </SettingRow>
          </SettingsGroup>

          <RulesGroup settings={settings} />
          <ClientsGroup />
          <ActivityGroup />
        </>
      )}
    </>
  );
}

/** The user's own rules for AI apps, sent with comail's built-in guidance
 *  when an app connects. */
function RulesGroup({ settings }: { settings: Settings }) {
  const { t } = useTranslation();
  const [text, setText] = useState(settings.mcpInstructions);
  useEffect(() => setText(settings.mcpInstructions), [settings.mcpInstructions]);
  const commit = () => {
    if (text !== settings.mcpInstructions) void updateSettings({ mcpInstructions: text });
  };
  return (
    <SettingsGroup title={t("settings:mcp.rulesGroup")} description={t("settings:mcp.rulesIntro")}>
      <div className="flex flex-col gap-2">
        <textarea
          className={`${inputCls} min-h-28 w-full resize-y py-2 leading-relaxed`}
          aria-label={t("settings:mcp.rulesGroup")}
          placeholder={t("settings:mcp.rulesPlaceholder")}
          value={text}
          maxLength={4000}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
        />
        <p className="text-xs text-ink-faint">{t("settings:mcp.rulesHint")}</p>
      </div>
    </SettingsGroup>
  );
}

function ClientsGroup() {
  const { t } = useTranslation();
  const [showAll, setShowAll] = useState(false);
  const { data: clients } = useQuery({
    queryKey: ["mcpClients"],
    queryFn: () => call("mcp_list_clients", {}),
    staleTime: 30_000,
  });
  const installed = (clients ?? []).filter((c) => c.detected);
  const others = (clients ?? []).filter((c) => !c.detected);
  // Nothing detected: the full list is the only list, so show it.
  const othersOpen = showAll || installed.length === 0;
  return (
    <>
      {installed.length > 0 && (
        <SettingsGroup
          title={t("settings:mcp.onThisComputer")}
          description={t("settings:mcp.clientsIntro")}
        >
          {installed.map((c) => (
            <ClientRow key={c.id} client={c} />
          ))}
        </SettingsGroup>
      )}
      {others.length > 0 && (
        <SettingsGroup
          title={t("settings:mcp.otherApps")}
          description={installed.length === 0 ? t("settings:mcp.clientsIntro") : undefined}
          actions={
            installed.length > 0 && (
              <Button size="sm" variant="ghost" onClick={() => setShowAll((v) => !v)}>
                {othersOpen
                  ? t("settings:mcp.hideMore")
                  : t("settings:mcp.showMore", { count: others.length })}
              </Button>
            )
          }
        >
          {othersOpen ? (
            others.map((c) => <ClientRow key={c.id} client={c} />)
          ) : (
            <button
              type="button"
              className="flex w-full items-center gap-2 text-left text-sm text-ink-muted hover:text-ink"
              onClick={() => setShowAll(true)}
            >
              <span className="flex -space-x-1.5">
                {others.slice(0, 6).map((c) => (
                  <ClientLogo key={c.id} id={c.id} name={c.name} small />
                ))}
              </span>
              <span className="truncate">{others.map((c) => c.name).join(", ")}</span>
            </button>
          )}
        </SettingsGroup>
      )}
    </>
  );
}

/** The client's brand mark on a neutral tile; a letter tile when we have no mark. */
function ClientLogo({ id, name, small = false }: { id: string; name: string; small?: boolean }) {
  const logo = CLIENT_LOGOS[id];
  return (
    <span
      aria-hidden="true"
      className={`inline-flex shrink-0 items-center justify-center rounded-control border border-hairline bg-bg2 text-ink ${
        small ? "size-6 p-1 text-2xs ring-2 ring-bg1" : "size-8 p-1.5 text-sm"
      }`}
    >
      {logo ? (
        <span
          className="block size-full"
          style={logo.color ? { color: logo.color } : undefined}
          // Static markup bundled in mcpLogos.ts, never user or remote data.
          dangerouslySetInnerHTML={{ __html: logo.svg }}
        />
      ) : (
        <span className="font-semibold text-ink-muted">{name.charAt(0).toUpperCase()}</span>
      )}
    </span>
  );
}

function ClientRow({ client }: { client: McpClientInfo }) {
  const { t } = useTranslation();
  const pushToast = useUi((s) => s.pushToast);
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState(false);
  const [snippet, setSnippet] = useState<string | null>(null);

  const loadSnippet = async () => {
    const s = await call("mcp_client_snippet", { id: client.id });
    setSnippet(s);
    return s;
  };

  const copySnippet = async () => {
    try {
      await copyText(snippet ?? (await call("mcp_client_snippet", { id: client.id })));
      pushToast({
        kind: "info",
        message: t("settings:mcp.copied", { what: client.name }),
        durationMs: 2000,
      });
    } catch (err) {
      pushToast({ kind: "error", message: errorMessage(err) });
    }
  };

  const install = async () => {
    if (client.method === "copy") {
      await copySnippet();
      // ChatGPT's steps are worth reading, not just pasting.
      if (client.id === "chatgpt" && snippet === null) void loadSnippet().catch(() => {});
      return;
    }
    setBusy(true);
    try {
      const r = await call("mcp_install_client", { id: client.id });
      setAdded(true);
      pushToast({ kind: "info", message: r.message, durationMs: 5000 });
    } catch (err) {
      // Couldn't add it automatically: open the config so it can be pasted.
      pushToast({ kind: "error", message: errorMessage(err), durationMs: 6000 });
      if (snippet === null) void loadSnippet().catch(() => {});
    } finally {
      setBusy(false);
    }
  };

  const toggleConfig = () =>
    snippet === null
      ? void loadSnippet().catch((err) =>
          pushToast({ kind: "error", message: errorMessage(err) }),
        )
      : setSnippet(null);

  const hint =
    client.id === "chatgpt"
      ? t("settings:mcp.method.tunnel")
      : client.method === "write" && client.configPath
        ? client.configPath
        : t(`settings:mcp.method.${client.method}`);

  const actionLabel = added
    ? t("settings:mcp.added")
    : client.method === "deeplink"
      ? t("settings:mcp.open")
      : client.method === "copy"
        ? t("settings:mcp.copy")
        : t("settings:mcp.add");

  return (
    <div>
      <div className="flex items-center gap-3">
        <ClientLogo id={client.id} name={client.name} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-base text-ink">{client.name}</div>
          <div
            className={`truncate text-xs text-ink-faint ${
              client.method === "write" && client.configPath && client.id !== "chatgpt"
                ? "font-mono"
                : ""
            }`}
            title={hint}
          >
            {hint}
          </div>
        </div>
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={snippet !== null}
          onClick={toggleConfig}
        >
          {t("settings:mcp.config")} {snippet === null ? "▾" : "▴"}
        </Button>
        <Button
          size="sm"
          className="min-w-[72px] justify-center"
          variant={client.detected && client.method !== "copy" && !added ? "primary" : "secondary"}
          icon={client.method === "copy" ? "copy" : undefined}
          busy={busy}
          onClick={() => void install()}
        >
          {actionLabel}
        </Button>
      </div>
      {snippet !== null && (
        <div className="relative mt-3 ml-11">
          <pre className="max-h-64 overflow-auto rounded-control border border-hairline bg-bg2 p-3 pr-20 font-mono text-2xs leading-relaxed whitespace-pre-wrap break-all text-ink">
            {snippet}
          </pre>
          <Button
            size="sm"
            icon="copy"
            className="absolute top-2 right-2"
            onClick={() => void copySnippet()}
          >
            {t("settings:mcp.copy")}
          </Button>
        </div>
      )}
    </div>
  );
}

function ActivityGroup() {
  const { t, i18n } = useTranslation();
  const { data: calls } = useQuery({
    queryKey: ["mcpActivity"],
    queryFn: () => call("mcp_activity", {}),
  });
  useEffect(
    () =>
      onEvent("mcp:activity", () => {
        void queryClient.invalidateQueries({ queryKey: ["mcpActivity"] });
        void queryClient.invalidateQueries({ queryKey: ["mcpStatus"] });
      }),
    [],
  );
  const time = new Intl.DateTimeFormat(i18n.language, { timeStyle: "medium" });
  const recent = (calls ?? []).slice(0, 25);
  return (
    <SettingsGroup title={t("settings:mcp.activityGroup")}>
      {recent.length === 0 ? (
        <div className="text-sm text-ink-faint">{t("settings:mcp.activityEmpty")}</div>
      ) : (
        recent.map((c, i) => (
          <div key={`${c.at}-${i}`} className="flex items-center justify-between gap-4 text-sm">
            <div className="min-w-0 truncate">
              <span className="font-mono text-ink">{c.tool}</span>
              <span className="ml-2 text-ink-faint">{c.client}</span>
              {c.error && <span className="ml-2 text-danger">{c.error}</span>}
            </div>
            <span className={`shrink-0 text-xs ${c.ok ? "text-ink-faint" : "text-danger"}`}>
              {time.format(c.at)}
            </span>
          </div>
        ))
      )}
    </SettingsGroup>
  );
}
