// Exercise actual HTTP sockets, including Node's Fetch response and cookie behavior.
import { fetch } from "undici";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthSettingsWriteScope,
  ProviderInstanceId,
  ProviderDriverKind,
  ProjectId,
  ThreadId,
  EventId,
  CommandId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as PluginHttp from "./http.ts";

import * as Replay from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Receipts from "../orchestration-v2/CommandReceiptStore.ts";
import * as Projects from "../orchestration-v2/ProjectStore.ts";
import { planProjectCommand } from "../orchestration-v2/ProjectCommands.ts";
import * as Registry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import type * as Adapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Settings from "../serverSettings.ts";
const selection = { instanceId: ProviderInstanceId.make("codex"), model: "test-model" };
const runtime = Replay.layerWithRegistry(
  { name: "plugin-handoff" },
  Registry.layerFromAdapters([
    {
      instanceId: selection.instanceId,
      driver: ProviderDriverKind.make("codex"),
      getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
      openSession: () => Effect.die("This test does not start external providers"),
    } as Adapter.ProviderAdapterV2["Service"],
  ]),
  { databaseLayer: SqlitePersistence.layerMemory, runEffectWorker: false },
);
// Verify through both upstream authentication entry points, not by decoding plugin tokens or returning them over HTTP.
const probe = HttpRouter.add(
  "GET",
  "/session-probe",
  Effect.gen(function* () {
    const req = yield* HttpServerRequest.HttpServerRequest;
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const http = yield* auth.authenticateHttpRequest(req);
    const ws = yield* auth.authenticateWebSocketUpgrade(req, "rpc");
    return HttpServerResponse.jsonUnsafe({
      sameSession: http.sessionId === ws.sessionId,
      scopes: http.scopes,
    });
  }).pipe(Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 401 }))),
);
const testLayer = (restricted = false) =>
  HttpRouter.serve(Layer.mergeAll(PluginHttp.layer, probe), {
    disableListenLog: true,
    disableLogger: true,
  }).pipe(
    Layer.provideMerge(Threads.layer.pipe(Layer.provide(runtime), Layer.provide(Receipts.layer))),
    Layer.provideMerge(Projects.layer),
    Layer.provideMerge(Settings.layerTest({ defaultModelSelection: selection })),
    Layer.provideMerge(EnvironmentAuth.layer),
    Layer.provideMerge(
      ManagedPolicy.layerTest(
        restricted
          ? { schemaVersion: 1, organization: "Test", limits: { clients: ["desktop"] } }
          : undefined,
      ),
    ),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(ServerEnvironment.layerIdentity),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "plugin-http-" })),
    Layer.provideMerge(NodeHttpServer.layerTest),
    Layer.provideMerge(NodeCrypto.layer),
    Layer.provideMerge(NodeServices.layer),
  );
it.live(
  "protects management and extension routes and issues revocable, scoped HTTP/WS sessions",
  () =>
    Effect.gen(function* () {
      const services = yield* Layer.build(testLayer());
      const origin = HttpServer.formatAddress(Context.get(services, HttpServer.HttpServer).address);
      const auth = Context.get(services, EnvironmentAuth.EnvironmentAuth);
      const fs = Context.get(services, FileSystem.FileSystem);
      const path = Context.get(services, Path.Path);
      const spec = path.join(
        Context.get(services, ServerConfig.ServerConfig).baseDir,
        "test-package",
      );
      yield* fs.makeDirectory(spec, { recursive: true });
      yield* fs.writeFileString(
        path.join(spec, "package.json"),
        JSON.stringify({
          name: "fixture",
          t3code: { plugin: { id: "fixture", name: "Probe", entry: "./host.mjs", version: "1" } },
        }),
      );
      yield* fs.writeFileString(
        path.join(spec, "host.mjs"),
        `export async function apply(ctx, config){
    const session = await ctx.issueLocalSession({readOnly:true});
    ctx.registerHttpHandler(async(req, subPath)=>{
      if (subPath === '/native') { const [op,arg] = await req.json(); return Response.json(await ctx.orchestration[op](arg)); }
      const {localOrigin,port,environmentId}=ctx.getServerInfo();
      const opts={headers:{cookie:session.cookieName+'='+session.cookieValue}};
      const inspect=await fetch(new URL('/session-probe',localOrigin),opts);
      const admin=await fetch(new URL('/api/plugins',localOrigin),opts);
      return Response.json({subPath,config,port,environmentId,probe:await inspect.json(),admin:admin.status}, {headers:{'content-security-policy':"default-src 'none'"}});
    });
  }`,
      );
      const projectId = ProjectId.make("test-project");
      const event = Result.getOrThrow(
        planProjectCommand({
          command: {
            type: "project.create",
            commandId: CommandId.make("create-project"),
            projectId,
            title: "Fixture",
            workspaceRoot: spec,
          },
          state: { project: undefined, workspaceOwner: undefined },
          eventId: EventId.make("project-event"),
          now: yield* DateTime.now,
        }),
      );
      yield* Context.get(services, Projects.ProjectStoreV2).apply({ ...event, sequence: 1 });
      const admin = yield* auth.issueSession();
      const limited = yield* auth.issueSession({ scopes: [AuthSettingsWriteScope] });
      const nativeThreadId = yield* Effect.promise(async () => {
        function call(url: string, method = "GET", token?: string, body?: unknown) {
          return fetch(new URL(url, origin), {
            method,
            headers: {
              ...(token ? { authorization: `Bearer ${token}` } : {}),
              ...(body === undefined ? {} : { "content-type": "application/json" }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
        }
        const root = "/api/plugins",
          plugin = root + "/fixture",
          ext = "/api/plugin-ext/fixture";
        for (const [method, url] of [
          ["GET", root],
          ["POST", root + "/install"],
          ["POST", plugin + "/enable"],
          ["POST", plugin + "/disable"],
          ["PUT", plugin + "/config"],
          ["DELETE", plugin],
          ["GET", ext],
          ["POST", ext + "/panel"],
        ] as const) {
          expect((await call(url, method)).status).toBe(401);
          expect((await call(url, method, limited.token)).status).toBe(403);
        }
        expect((await call(root + "/install", "POST", admin.token)).status).toBe(415);
        expect((await call(root + "/install", "POST", admin.token, { spec: 42 })).status).toBe(400);
        expect(await (await call(root, "GET", admin.token)).json()).toEqual([]);
        expect(
          (await call(root + "/install", "POST", admin.token, { spec, enable: false })).status,
        ).toBe(201);
        expect(
          (await call(plugin + "/config", "PUT", admin.token, { config: { test: true } })).status,
        ).toBe(204);
        expect((await call(plugin + "/enable", "POST", admin.token)).status).toBe(204);
        expect(await (await call(root, "GET", admin.token)).json()).toMatchObject([
          { id: "fixture", status: "active", config: { test: true } },
        ]);
        const result = await call(ext + "/panel", "GET", admin.token);
        expect(result.status).toBe(200);
        expect(result.headers.get("content-security-policy")).toBe(
          "default-src 'none'; frame-ancestors 'self'",
        );
        expect(await result.json()).toMatchObject({
          subPath: "/panel",
          config: { test: true },
          port: Number(new URL(origin).port),
          environmentId: expect.any(String),
          probe: { sameSession: true, scopes: ["orchestration:read"] },
          admin: 403,
        });
        const native = async (op: string, arg: unknown) => {
          const res = await call(ext + "/native", "POST", admin.token, [op, arg]);
          expect(res.status).toBe(200);
          return res.json();
        };
        expect(await native("getThreadSnapshot", "absent")).toBeNull();
        const input = {
          handoffId: "first",
          workspacePath: spec,
          title: "Relay",
          prompt: "Review checkpoint",
        };
        const continuation = async () => {
          const v = await native("continueThreadTurn", input);
          if (
            !v ||
            typeof v !== "object" ||
            !("threadId" in v) ||
            typeof v.threadId !== "string" ||
            !("environmentId" in v) ||
            !("route" in v) ||
            !("dispatched" in v)
          )
            throw Error("Invalid continuation response");
          return { ...v, threadId: v.threadId };
        };
        const [a, b] = await Promise.all([continuation(), continuation()]);
        expect(a.threadId).toBe(b.threadId);
        expect(a.route).toBe(`/${a.environmentId}/${a.threadId}`);
        expect([a.dispatched, b.dispatched].sort()).toEqual([false, true]);
        expect(await native("getThreadSnapshot", a.threadId)).toMatchObject({
          title: "Relay",
          projectId,
          isRunning: true,
        });
        expect(await native("interruptActiveTurn", a.threadId)).toMatchObject({
          interrupted: true,
        });
        expect(await native("interruptActiveTurn", a.threadId)).toEqual({
          interrupted: false,
          activeRunId: null,
        });
        const follow = { ...input, handoffId: "second", threadId: a.threadId };
        expect(await native("continueThreadTurn", follow)).toMatchObject({
          created: false,
          dispatched: true,
          route: a.route,
        });
        expect(await native("continueThreadTurn", follow)).toMatchObject({
          dispatched: false,
          route: a.route,
        });
        expect((await call(ext, "POST", admin.token)).status).toBe(200);
        expect((await call(plugin + "/disable", "POST", admin.token)).status).toBe(204);
        expect((await call(ext + "/panel", "GET", admin.token)).status).toBe(404);
        expect((await call(plugin, "DELETE", admin.token)).status).toBe(204);
        expect(await (await call(root, "GET", admin.token)).json()).toEqual([]);
        return ThreadId.make(a.threadId);
      });
      expect(
        yield* Context.get(services, Threads.ThreadManagementService).getRunCount(nativeThreadId),
      ).toBe(2);
      expect((yield* auth.listSessions()).some((s) => s.subject === "local-plugin:fixture")).toBe(
        false,
      );
    }).pipe(Effect.scoped),
);

it.live(
  "managed local-only policy denies all native worker operations, even for an installed worker",
  () =>
    Effect.gen(function* () {
      const services = yield* Layer.build(testLayer(true));
      const fs = Context.get(services, FileSystem.FileSystem),
        path = Context.get(services, Path.Path);
      const base = Context.get(services, ServerConfig.ServerConfig).baseDir,
        source = path.join(base, "policy-plugin");
      yield* fs.makeDirectory(source, { recursive: true });
      yield* fs.writeFileString(
        path.join(source, "package.json"),
        JSON.stringify({
          name: "policy-fixture",
          t3code: {
            plugin: {
              id: "policy-fixture",
              name: "Policy probe",
              version: "1",
              entry: "./host.mjs",
            },
          },
        }),
      );
      yield* fs.writeFileString(
        path.join(source, "host.mjs"),
        `export function apply(ctx) {ctx.registerHttpHandler(async () => {
    const outcomes = await Promise.allSettled([ctx.orchestration.getThreadSnapshot("absent"),ctx.orchestration.interruptActiveTurn("absent"),ctx.orchestration.continueThreadTurn({handoffId:"blocked",threadId:"absent",prompt:"Read"})]);
    return Response.json(outcomes.map(o=>o.status));
  });}`,
      );
      const admin = yield* Context.get(services, EnvironmentAuth.EnvironmentAuth).issueSession();
      const origin = HttpServer.formatAddress(Context.get(services, HttpServer.HttpServer).address);
      const headers = {
        authorization: `Bearer ${admin.token}`,
        "content-type": "application/json",
      };
      yield* Effect.promise(async () => {
        expect(
          (
            await fetch(origin + "/api/plugins/install", {
              method: "POST",
              headers,
              body: JSON.stringify({ spec: source }),
            })
          ).status,
        ).toBe(201);
        const r = await fetch(origin + "/api/plugin-ext/policy-fixture/", { headers });
        expect(r.status).toBe(200);
        expect(await r.json()).toEqual(["rejected", "rejected", "rejected"]);
      });
    }).pipe(Effect.scoped),
);
