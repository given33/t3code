import { PluginHostManager } from "@t3tools/plugin-host";
import {
  AuthOrchestrationReadScope,
  AuthStandardClientScopes,
  type AuthSessionId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServer } from "effect/http";
import { ServerConfig } from "../config.ts";
import { SessionStore } from "../auth/SessionStore.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { ManagedPolicy } from "../policy/ManagedPolicy.ts";
import { allowsRemoteClients } from "../policy/managedLimits.ts";
import { loopbackUrlHostForAddress } from "../startupAccess.ts";

export function pluginOperation<A>(operation: () => Promise<A>) {
  return Effect.tryPromise({
    try: operation,
    catch: (cause) => ({
      _tag: "PluginOperationError" as const,
      message: cause instanceof Error ? cause.message : "Plugin operation failed",
    }),
  });
}
export class PluginHostService extends Context.Service<PluginHostService, PluginHostManager>()(
  "t3/plugins/PluginHostService",
) {}
export const layer = Layer.effect(
  PluginHostService,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const environmentId = yield* (yield* ServerEnvironmentIdentity).getEnvironmentId;
    const sessions = yield* SessionStore;
    const policy = yield* ManagedPolicy;
    const { address } = yield* HttpServer.HttpServer;
    const run = Effect.runPromiseWith(yield* Effect.context<never>());
    // Include in-flight issuance: unloading a plugin must revoke a session even if it was still being signed.
    const issued = new Map<string, Set<Promise<AuthSessionId>>>();
    const host = new PluginHostManager({
      t3BaseDir: config.baseDir,
      t3StateDir: config.stateDir,
      staticDir: config.staticDir,
      getServerInfo: () => ({
        localOrigin:
          typeof address === "object" && "port" in address
            ? `http://${loopbackUrlHostForAddress(address)}:${address.port}`
            : null,
        port: typeof address === "object" && "port" in address ? address.port : null,
        host: config.host,
        environmentId,
        staticDir: config.staticDir,
      }),
      async issueLocalSession(id, options) {
        if (!allowsRemoteClients(policy)) return null;
        const group = issued.get(id) ?? new Set<Promise<AuthSessionId>>();
        issued.set(id, group);
        const result = run(
          sessions.issue({
            subject: `local-plugin:${id}`,
            client: { label: options?.label ?? id, deviceType: "bot" },
            method: "browser-session-cookie",
            ttl: Duration.hours(1),
            scopes: options?.readOnly ? [AuthOrchestrationReadScope] : AuthStandardClientScopes,
          }),
        );
        const pending = result.then((value) => value.sessionId);
        group.add(pending);
        void pending.catch(() => group.delete(pending));
        const session = await result;
        return {
          cookieName: sessions.cookieName,
          cookieValue: session.token,
          token: session.token,
          expiresAt: DateTime.formatIso(session.expiresAt),
        };
      },
      async releaseSessions(id) {
        const group = issued.get(id);
        issued.delete(id);
        if (group)
          for (const result of await Promise.allSettled(group)) {
            if (result.status === "fulfilled") await run(sessions.revoke(result.value));
          }
      },
    });
    yield* Effect.addFinalizer(() => Effect.promise(() => host.disposeAll()));
    // HttpServer is already bound. A slow/broken plugin never delays route readiness.
    yield* pluginOperation(() => host.startAll()).pipe(
      Effect.catch((error) => Effect.logWarning("Plugin registry unavailable", error)),
      Effect.forkScoped,
    );
    return host;
  }),
);
