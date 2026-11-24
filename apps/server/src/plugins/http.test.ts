// Exercise actual HTTP sockets, including Node's Fetch response and cookie behavior.
import { fetch } from "undici";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { AuthSettingsWriteScope } from "@t3tools/contracts";
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
const testLayer = HttpRouter.serve(Layer.mergeAll(PluginHttp.layer, probe), {
  disableListenLog: true,
  disableLogger: true,
}).pipe(
  Layer.provideMerge(EnvironmentAuth.layer),
  Layer.provideMerge(ManagedPolicy.layerTest()),
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
      const services = yield* Layer.build(testLayer);
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
      const {localOrigin,port,environmentId}=ctx.getServerInfo();
      const opts={headers:{cookie:session.cookieName+'='+session.cookieValue}};
      const inspect=await fetch(new URL('/session-probe',localOrigin),opts);
      const admin=await fetch(new URL('/api/plugins',localOrigin),opts);
      return Response.json({subPath,config,port,environmentId,probe:await inspect.json(),admin:admin.status}, {headers:{'content-security-policy':"default-src 'none'"}});
    });
  }`,
      );
      const admin = yield* auth.issueSession();
      const limited = yield* auth.issueSession({ scopes: [AuthSettingsWriteScope] });
      yield* Effect.promise(async () => {
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
        expect((await call(ext, "POST", admin.token)).status).toBe(200);
        expect((await call(plugin + "/disable", "POST", admin.token)).status).toBe(204);
        expect((await call(ext + "/panel", "GET", admin.token)).status).toBe(404);
        expect((await call(plugin, "DELETE", admin.token)).status).toBe(204);
        expect(await (await call(root, "GET", admin.token)).json()).toEqual([]);
      });
      expect((yield* auth.listSessions()).some((s) => s.subject === "local-plugin:fixture")).toBe(
        false,
      );
    }).pipe(Effect.scoped),
);
