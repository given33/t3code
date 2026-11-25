import { useAtomValue, useAtomRefresh } from "@effect/atom-react";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import { Atom, AsyncResult } from "effect/reactivity";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useGT } from "gt-react";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";
import { usePreparedConnection } from "../state/session";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { Switch } from "../components/ui/switch";

import { pluginApi, type PluginApi } from "./-pluginApi";
interface Plugin {
  id: string;
  name: string;
  version: string;
  description: string;
  enabled: boolean;
  status: string;
  error?: string;
  config: Record<string, unknown>;
  panel?: { title: string; uiPath: string };
}
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
function PluginCard({
  p,
  busy,
  run,
  api,
  canEmbed,
}: {
  p: Plugin;
  busy: boolean;
  api: PluginApi;
  canEmbed: boolean;
  run: (fn: () => Promise<void>) => void;
}) {
  const gt = useGT();
  const [config, setConfig] = useState(() => JSON.stringify(p.config, null, 2));
  const [panel, setPanel] = useState(false);
  const [remove, setRemove] = useState(false);
  const id = `/${encodeURIComponent(p.id)}`;
  return (
    <article className="space-y-3 rounded-lg border border-border p-4">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h3 className="font-medium">
            {p.name} <span className="rounded bg-muted px-2 py-1 text-xs">{p.status}</span>
          </h3>
          <code className="text-xs text-muted-foreground">
            {p.id} · {p.version}
          </code>
        </div>
        <Switch
          checked={p.enabled}
          aria-label={gt("Enable {name}", { name: p.name })}
          disabled={busy}
          onCheckedChange={(enabled) =>
            run(async () => {
              await api(`${id}/${enabled ? "enable" : "disable"}`, "POST");
              setPanel(false);
            })
          }
        />
      </header>
      {p.description && <p className="text-sm text-muted-foreground">{p.description}</p>}
      {p.error && (
        <p className="break-words text-sm text-destructive" role="alert">
          {p.error}
        </p>
      )}
      <details>
        <summary className="cursor-pointer text-sm">{gt("JSON configuration")}</summary>
        <Textarea
          className="my-2"
          aria-label={gt("JSON configuration")}
          value={config}
          onChange={(event) => setConfig(event.target.value)}
        />
        <Button
          disabled={busy}
          onClick={() =>
            run(async () => {
              const value: unknown = JSON.parse(config);
              if (value === null || typeof value !== "object" || Array.isArray(value))
                throw new Error(gt("Enter a JSON object."));
              await api(`${id}/config`, "PUT", { config: value });
            })
          }
        >
          {gt("Save configuration")}
        </Button>
      </details>
      <div className="flex flex-wrap gap-2">
        {p.panel && p.status === "active" && !canEmbed && (
          <p className="text-sm text-muted-foreground">
            {gt("Open this environment in its own authenticated web interface to view the panel.")}
          </p>
        )}
        {canEmbed && p.panel && p.status === "active" && (
          <Button variant="outline" aria-expanded={panel} onClick={() => setPanel(!panel)}>
            {panel ? gt("Close panel") : gt("Open panel")}
          </Button>
        )}
        {remove ? (
          <>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await api(id, "DELETE");
                })
              }
            >
              {gt("Confirm uninstall")}
            </Button>
            <Button variant="outline" onClick={() => setRemove(false)}>
              {gt("Cancel")}
            </Button>
          </>
        ) : (
          <Button variant="outline" disabled={busy} onClick={() => setRemove(true)}>
            {gt("Uninstall")}
          </Button>
        )}
      </div>
      {canEmbed && panel && p.status === "active" && p.panel && (
        // A trusted plugin panel needs scripts and the same authenticated origin. This is not a security sandbox.
        <iframe
          className="h-96 w-full rounded-md border"
          title={p.panel.title}
          src={`/api/plugin-ext${id}${p.panel.uiPath}`}
          // oxlint-disable-next-line react/iframe-missing-sandbox -- Trusted panel needs cookie authentication; no top navigation or popup permission.
          sandbox="allow-scripts allow-same-origin allow-forms"
          referrerPolicy="no-referrer"
        />
      )}
    </article>
  );
}
const pluginList = Atom.family((api: PluginApi) =>
  Atom.make(
    Effect.tryPromise({
      try: async (signal) => (await api("", "GET", undefined, signal)) as Plugin[],
      catch: message,
    }),
  ).pipe(Atom.refreshOnWindowFocus),
);
export function PluginSettings({ api, canEmbed }: { api: PluginApi; canEmbed: boolean }) {
  const gt = useGT();
  const list = pluginList(api);
  const result = useAtomValue(list);
  const refresh = useAtomRefresh(list);
  const plugins = AsyncResult.getOrElse(result, () => null);
  const [operationError, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [spec, setSpec] = useState("");
  const error =
    operationError || (AsyncResult.isFailure(result) ? message(Cause.squash(result.cause)) : "");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Keep a refresh timer only while the host is activating a plugin.
  useEffect(() => {
    if (!plugins?.some((p) => p.status === "starting")) return;
    const timer = setTimeout(refresh, 1000);
    return () => clearTimeout(timer);
  }, [plugins, refresh]);
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      refresh();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="mx-auto max-w-3xl space-y-4 p-4 sm:p-8">
      <h2 className="text-lg font-semibold">{gt("Plugins")}</h2>
      <p className="text-sm text-muted-foreground">
        {gt(
          "Install only plugins you trust. Plugins run on the server with access to its files and sessions.",
        )}
      </p>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await api("/install", "POST", { spec: spec.trim() });
            setSpec("");
          });
        }}
      >
        <Input
          className="min-w-36 flex-1"
          aria-label={gt("Plugin directory or .tgz path on the server")}
          placeholder={gt("Plugin directory or .tgz path on the server")}
          value={spec}
          onChange={(e) => setSpec(e.target.value)}
        />
        <Button type="submit" disabled={busy || !spec.trim()}>
          {gt("Install plugin")}
        </Button>
      </form>
      {error && (
        <p role="alert" className="break-words text-sm text-destructive">
          {error}
        </p>
      )}
      {plugins === null ? (
        !error && <p>{gt("Loading…")}</p>
      ) : plugins.length === 0 ? (
        <p className="text-sm text-muted-foreground">{gt("No plugins installed.")}</p>
      ) : (
        plugins.map((p) => (
          <PluginCard key={p.id} p={p} api={api} canEmbed={canEmbed} run={run} busy={busy} />
        ))
      )}
    </section>
  );
}
function PluginsRoute() {
  const gt = useGT();
  const { environment } = useSettingsScope();
  const connection = usePreparedConnection(environment?.environmentId ?? null);
  const id = environment?.environmentId;
  const api = id ? pluginApi(id) : null;
  if (!api || connection._tag === "None")
    return (
      <p className="p-8 text-sm text-muted-foreground">
        {gt("Connect an environment to manage its plugins.")}
      </p>
    );
  const canEmbed =
    new URL(connection.value.httpBaseUrl).origin === window.location.origin &&
    !connection.value.httpAuthorization;
  return <PluginSettings key={id} api={api} canEmbed={canEmbed} />;
}
export const Route = createFileRoute("/_chat/settings/plugins")({ component: PluginsRoute });
