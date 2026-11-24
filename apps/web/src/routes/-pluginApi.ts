import { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import { executeConnectedEnvironmentHttpRequest } from "@t3tools/client-runtime/state/environmentHttpAuth";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpClient, type HttpClientError, HttpClientRequest } from "effect/http";
import { AtomRegistry } from "effect/reactivity";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";

type Method = "GET" | "POST" | "DELETE" | "PUT";
export type PluginApi = (
  suffix?: string,
  method?: Method,
  body?: unknown,
  signal?: AbortSignal,
) => Promise<unknown>;

/** Use the selected environment's connection (including bearer and DPoP renewal), never the renderer's default host. */
export function pluginApi(environmentId: EnvironmentId): PluginApi {
  return async (suffix = "", method = "GET", body, signal) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const path = `/api/plugins${suffix}`;
    const atom = connectionAtomRuntime.atom(
      Effect.flatMap(EnvironmentRegistry.EnvironmentRegistry, (registry) =>
        registry.run(
          environmentId,
          Effect.suspend(() => {
            let endpoint: URL;
            return executeConnectedEnvironmentHttpRequest<
              "auth",
              { status: number; content: string },
              HttpClientError.HttpClientError,
              HttpClient.HttpClient
            >({
              group: "auth",
              method,
              timeoutMs: 60000,
              requestInit: { redirect: "error" },
              // Use the resolved host of the contract's session URL, including any route change on authorization refresh.
              url: (urls) => (endpoint = new URL(path, urls.session())).href,
              request: Effect.fn("plugins.http")(function* ({ headers }) {
                const client = yield* HttpClient.HttpClient;
                let request = HttpClientRequest.make(method)(endpoint, { headers: { ...headers } });
                if (payload !== undefined)
                  request = HttpClientRequest.bodyText(request, payload, "application/json");
                const response = yield* client.execute(request);
                const content = yield* response.text;
                return { status: response.status, content };
              }),
              isUnauthorizedResponse: (response) => response.status === 401,
            });
          }),
        ),
      ),
    );
    const response = await Effect.runPromise(
      AtomRegistry.getResult(appAtomRegistry, atom, { suspendOnWaiting: true }),
      signal ? { signal } : {},
    );
    if (response.status < 200 || response.status >= 300) {
      let detail;
      try {
        detail = JSON.parse(response.content).error;
      } catch {
        /* May be an upstream proxy or pre-plugin server. */
      }
      throw new Error(detail ?? `HTTP ${response.status}`);
    }
    return response.content ? JSON.parse(response.content) : null;
  };
}
