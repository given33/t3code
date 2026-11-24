import { AuthStandardClientScopes } from "@t3tools/contracts";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  HttpIncomingMessage,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse as Response,
} from "effect/http";
import { EnvironmentAuth, isServerAuthCredentialError } from "../auth/EnvironmentAuth.ts";
import { PluginHostService, pluginOperation, layer as hostLayer } from "./PluginHostService.ts";

const json = (value: unknown, status = 200) =>
  Response.jsonUnsafe(value, { status, headers: { "cache-control": "no-store" } });
const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const routes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const host = yield* PluginHostService;
    const auth = yield* EnvironmentAuth;
    const handle = Effect.fn("plugins.handle")(
      function* (
        action: "list" | "install" | "enable" | "disable" | "config" | "remove" | "extension",
      ) {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const session = yield* auth.authenticateHttpRequest(request);
        // Installing code, or accessing a pairing panel, can confer all ordinary client scopes.
        // A settings-only client must not be able to promote itself via a host plugin.
        if (!AuthStandardClientScopes.every((scope) => session.scopes.includes(scope)))
          return json({ error: "Plugin administration requires full client permissions" }, 403);
        const params = yield* HttpRouter.params;
        const id = params.id ?? "";
        if (action === "extension") {
          const web = yield* HttpServerRequest.toWeb(request);
          const path = new URL(web.url).pathname;
          const response = yield* pluginOperation(() =>
            host.dispatchExtensionHttp(id, web, path.slice(`/api/plugin-ext/${id}`.length) || "/"),
          );
          // Preserve stricter plugin CSP directives; replace only its framing policy.
          const csp = (response.headers.get("content-security-policy") ?? "")
            .split(";")
            .filter((v) => v.trim() && !/^\s*frame-ancestors(?:\s|$)/i.test(v));
          return Response.setHeaders(Response.fromWeb(response), {
            "content-security-policy": [...csp, "frame-ancestors 'self'"].join("; "),
            "x-frame-options": "SAMEORIGIN",
            "cache-control": "no-store",
          });
        }
        if (action === "list") return json(yield* pluginOperation(() => host.listPlugins()));
        if (action === "install" || action === "config") {
          if (request.headers["content-type"]?.split(";")[0]?.trim() !== "application/json")
            return json({ error: "Expected application/json" }, 415);
          const body = yield* request.json.pipe(
            Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(1024 * 1024)),
          );
          if (!record(body)) return json({ error: "Expected a JSON object" }, 400);
          if (action === "config") {
            if (!record(body.config)) return json({ error: "Expected a config object" }, 400);
            const config = body.config;
            yield* pluginOperation(() => host.updatePluginConfig(id, config));
          } else {
            const { spec, enable, link, config } = body;
            if (
              typeof spec !== "string" ||
              (enable !== undefined && typeof enable !== "boolean") ||
              (link !== undefined && typeof link !== "boolean") ||
              (config !== undefined && !record(config))
            )
              return json({ error: "Invalid install options" }, 400);
            const installed = yield* pluginOperation(() =>
              host.installPlugin({
                spec,
                ...(enable === undefined ? {} : { enable }),
                ...(link === undefined ? {} : { link }),
                ...(config === undefined ? {} : { config }),
              }),
            );
            return json({ id: installed }, 201);
          }
        } else
          yield* pluginOperation(() =>
            action === "enable"
              ? host.enablePlugin(id)
              : action === "disable"
                ? host.disablePlugin(id)
                : host.removePlugin(id),
          );
        return Response.empty({ status: 204 });
      },
      Effect.catch((error) =>
        Effect.succeed(
          isServerAuthCredentialError(error)
            ? json({ error: "Unauthorized" }, 401)
            : error._tag === "PluginOperationError"
              ? json({ error: error.message }, 400)
              : error._tag === "HttpServerError"
                ? json({ error: "Invalid request" }, 400)
                : json({ error: "Internal error" }, 500),
        ),
      ),
    );
    yield* router.add("GET", "/api/plugins", handle("list"));
    yield* router.add("POST", "/api/plugins/install", handle("install"));
    yield* router.add("POST", "/api/plugins/:id/enable", handle("enable"));
    yield* router.add("POST", "/api/plugins/:id/disable", handle("disable"));
    yield* router.add("PUT", "/api/plugins/:id/config", handle("config"));
    yield* router.add("DELETE", "/api/plugins/:id", handle("remove"));
    yield* router.add("*", "/api/plugin-ext/:id", handle("extension"));
    yield* router.add("*", "/api/plugin-ext/:id/*", handle("extension"));
  }),
);
export const layer = routes.pipe(Layer.provide(hostLayer));
