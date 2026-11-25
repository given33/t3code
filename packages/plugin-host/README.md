# Local host plugins

Plugins are **trusted server-side code**, not browser extensions. Only install packages you would run as the server's OS user. Each enabled package has a separate Node worker for fault isolation; it is not a permissions sandbox. Installation does not run a package manager or install scripts. Bundle the dependencies your entry needs.

Run `t3 plugin add <directory-or-tgz>` or use **Settings → Plugins**. Use `--no-enable` to inspect an installation before activation. Directory installs copy by default. `--link` uses a development directory in place; disable and enable after editing code. `t3 plugin list|enable|disable|remove` uses the same registry as the running server. The CLI does not start plugin code. A running host observes registry changes.

In `package.json`, put the following object under `t3code.plugin`, or use it as `t3-plugin.json`:

```json
{
  "id": "example",
  "name": "Example",
  "version": "1.0.0",
  "entry": "./host.mjs",
  "panel": { "title": "Example", "uiPath": "/panel" }
}
```

```js
export function apply(ctx, config) {
  const unregister = ctx.registerHttpHandler((request, subPath) =>
    subPath === "/panel" && request.method === "GET"
      ? new Response(config.greeting ?? "Hello", { headers: { "content-type": "text/plain" } })
      : new Response(null, { status: 404 }),
  );
  return unregister;
}
```

`apply` may be async and may return a cleanup function or `{ dispose() }`. Handlers run in registration order; a 404 passes to the next handler. Paths are relative to `/api/plugin-ext/<id>`, with the original query on `request.url`. Keep panel links and requests inside that namespace. The host removes incoming credentials before dispatch. Same-origin cookie-authenticated Web clients can embed panels; bearer/DPoP clients can manage plugins without putting credentials in iframe URLs.

Use `ctx.stateDir` for persistent plugin data, `ctx.getServerInfo()` for the bound origin and port, and `ctx.onShutdown()` for cleanup. If a trusted local proxy requires a session, use `ctx.issueLocalSession({ readOnly: true })` unless it actually needs ordinary client permissions. The caller must keep the returned credentials server-side. Sessions expire and are revoked when the plugin is unloaded. A managed policy that disallows remote clients disables issuance. See [the context type](src/types.ts) for the full API.

Under the runtime state directory, `plugins/registry.json` holds configuration, `plugins/packages/<id>/` holds copied packages, and `plugins/state/<id>/` holds state. Removal drops the installed copy and registry entry but preserves state and never deletes a linked source. Directory copies and archives do not accept links; archives may contain a package directory or files at the root.

Trusted workers can use optional `ctx.orchestration` on a host that supports native handoff. `getThreadSnapshot(threadId)` reads a summary, `interruptActiveTurn(threadId, reason?)` requests a run-specific stop and confirms the terminal projection, and `continueThreadTurn(input)` uses a durable, per-plugin `handoffId` receipt. An interrupt returning `interrupted: false` with a non-null `activeRunId` **does not** confirm termination. A continuation requires an existing target thread or a uniquely identified active project with a default model. Its `route` names the real native thread; `dispatched: false` on replay means no additional turn was sent. Plugins must enforce their own endpoint authorization and read-only modes before invoking the API. All three operations are unavailable when managed policy disallows remote clients.
