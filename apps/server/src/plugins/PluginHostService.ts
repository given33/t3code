import { PluginHostManager, type PluginOrchestration } from "@t3tools/plugin-host";
import {
  AuthOrchestrationReadScope,
  AuthStandardClientScopes,
  CommandId,
  MessageId,
  ThreadId,
  type AuthSessionId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import { HttpServer } from "effect/http";
import { ServerConfig } from "../config.ts";
import { SessionStore } from "../auth/SessionStore.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { ManagedPolicy } from "../policy/ManagedPolicy.ts";
import { allowsRemoteClients } from "../policy/managedLimits.ts";
import { loopbackUrlHostForAddress } from "../startupAccess.ts";

import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import * as Projects from "../orchestration-v2/ProjectStore.ts";
import * as Receipts from "../orchestration-v2/CommandReceiptStore.ts";
import { ServerSettingsService } from "../serverSettings.ts";

function identifier(value: string) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value))
    throw new Error("Invalid identifier");
  return value;
}
const unknownGuard =
  "TOOL_OUTCOME_UNKNOWN: verify prior state before retrying any write/deploy command";

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
    const threads = yield* ThreadManagementService;
    const projects = yield* Projects.ProjectStoreV2;
    const receipts = yield* Receipts.CommandReceiptStoreV2;
    const settings = yield* ServerSettingsService;
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
      orchestration(id): PluginOrchestration {
        const authorize = () => {
          if (!allowsRemoteClients(policy)) throw new Error("Managed policy denies remote clients");
        };
        return {
          async getThreadSnapshot(value) {
            authorize();
            const shell = await run(threads.getThreadShell(ThreadId.make(identifier(value))));
            if (!shell) return null;
            const project = Option.getOrThrow(await run(projects.get(shell.projectId)));
            return {
              threadId: shell.id,
              projectId: shell.projectId,
              workspacePath: shell.worktreePath ?? project.workspaceRoot,
              title: shell.title,
              activeRunId: shell.activeRunId,
              isRunning:
                shell.activeRunId !== null ||
                shell.status === "queued" ||
                (shell.pendingBackgroundTasks?.length ?? 0) > 0,
              latestTurnSummary: shell.latestVisibleMessage?.text.slice(0, 4096) ?? "",
              unknownSideEffects:
                shell.activeRunId !== null ||
                (shell.pendingBackgroundTasks?.length ?? 0) > 0 ||
                !["idle", "completed"].includes(shell.status),
              modelSelection: shell.modelSelection,
              updatedAt: DateTime.formatIso(shell.updatedAt),
            };
          },
          async interruptActiveTurn(value, reason) {
            authorize();
            const threadId = ThreadId.make(identifier(value));
            const shell = await run(threads.getThreadShell(threadId));
            const runId = shell?.activeRunId;
            if (!runId) return { interrupted: false, activeRunId: null };
            await run(
              threads.dispatch({
                type: "run.interrupt",
                threadId,
                runId,
                holdQueue: true,
                commandId: CommandId.make(`plugin:${id}:interrupt:${runId}`),
                ...(typeof reason === "string" ? { reason: reason.slice(0, 256) } : {}),
              }),
            );
            // A durable request is not a provider acknowledgement. Fail closed on timeout or a successor run.
            const confirmed = await run(
              Effect.gen(function* () {
                while (true) {
                  const after = yield* threads.getThreadShell(threadId);
                  if (!after || after.activeRunId !== runId)
                    return (
                      after?.activeRunId === null &&
                      after.latestRunId === runId &&
                      after.status === "interrupted"
                    );
                  yield* Effect.sleep("50 millis");
                }
              }).pipe(Effect.timeoutOption("2 seconds")),
            );
            return { interrupted: Option.getOrElse(confirmed, () => false), activeRunId: runId };
          },
          async continueThreadTurn(input) {
            authorize();
            const key = Buffer.from(
              await crypto.subtle.digest(
                "SHA-256",
                new TextEncoder().encode(`${id}:${identifier(input.handoffId)}`),
              ),
            ).toString("hex");
            const commandId = CommandId.make(`plugin:handoff:${key}`);
            const messageId = MessageId.make(`handoff:${key}`);
            if (
              typeof input.prompt !== "string" ||
              !input.prompt.trim() ||
              input.prompt.length > 16384
            )
              throw new Error("Invalid continuation");
            const receipt = Option.getOrNull(await run(receipts.getByCommandId(commandId)));
            const result = (
              threadId: string,
              projectId: string,
              created: boolean,
              dispatched: boolean,
            ) => ({
              ok: true as const,
              threadId,
              projectId,
              environmentId,
              route: `/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`,
              created,
              dispatched,
            });
            if (receipt) {
              const shell = await run(threads.getThreadShell(receipt.threadId));
              if (receipt.status !== "accepted" || !shell)
                throw new Error("Previous handoff unavailable");
              return result(
                shell.id,
                shell.projectId,
                receipt.commandType === "thread.create",
                false,
              );
            }
            const shell = input.threadId
              ? await run(threads.getThreadShell(ThreadId.make(identifier(input.threadId))))
              : null;
            const path =
              input.workspacePath === undefined
                ? undefined
                : normalizeProjectPathForComparison(input.workspacePath);
            const matches = (await run(projects.list())).filter(
              (p) =>
                !p.archivedAt &&
                (shell
                  ? p.projectId === shell.projectId
                  : input.projectId !== undefined || path !== undefined) &&
                (input.projectId === undefined || p.projectId === input.projectId) &&
                (path === undefined ||
                  normalizeProjectPathForComparison(shell?.worktreePath ?? p.workspaceRoot) ===
                    path),
            );
            if (matches.length !== 1 || shell?.archivedAt)
              throw new Error("No unique active target project");
            const project = matches[0]!;
            const text =
              input.unknownSideEffects && !input.prompt.startsWith(unknownGuard + "\n")
                ? unknownGuard + "\n" + input.prompt
                : input.prompt;
            const message = { messageId, text, attachments: [] };
            const threadId = shell?.id ?? ThreadId.make(`handoff-${key}`);
            const common = {
              commandId,
              threadId,
              createdBy: "user" as const,
              creationSource: "mobile" as const,
            };
            const selection =
              shell?.modelSelection ??
              resolveProjectSettings(await run(settings.getSettings), project.projectId, project)
                .settings.defaultModelSelection;
            if (!selection) throw new Error("Target project has no default model");
            if (!shell)
              await run(
                threads.assertProviderInstanceEnabled({
                  commandId,
                  projectId: project.projectId,
                  instanceId: selection.instanceId,
                }),
              );
            // For a new thread its first message and the command receipt commit together.
            const accepted = await run(
              threads.dispatch(
                shell
                  ? {
                      ...common,
                      ...message,
                      type: "message.dispatch",
                      dispatchMode: { type: "queue_after_active" },
                      modelSelection: selection,
                    }
                  : {
                      ...common,
                      type: "thread.create",
                      projectId: project.projectId,
                      title: input.title?.trim().slice(0, 256) || "Handoff",
                      modelSelection: selection,
                      runtimeMode: "approval-required",
                      interactionMode: "default",
                      branch: null,
                      worktreePath: null,
                      initialMessage: message,
                    },
              ),
            );
            return result(threadId, project.projectId, !shell, !accepted.replayed);
          },
        };
      },
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
).pipe(Layer.provide(Projects.layer), Layer.provide(Receipts.layer));
