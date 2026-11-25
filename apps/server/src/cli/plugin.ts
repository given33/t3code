import { PluginRegistry } from "@t3tools/plugin-host";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { CliError, Argument, Command, Flag, GlobalFlag } from "effect/cli";
import { authLocationFlags, resolveCliAuthConfig, type CliAuthLocationFlags } from "./config.ts";

const operation = <A>(fn: () => Promise<A>) =>
  Effect.tryPromise({
    try: fn,
    catch: (cause) =>
      new CliError.UserError({
        cause,
        userMessage: cause instanceof Error ? cause.message : "Plugin operation failed",
      }),
  });
const registry = Effect.fn(function* (flags: CliAuthLocationFlags) {
  const config = yield* resolveCliAuthConfig(flags, yield* GlobalFlag.LogLevel, {
    quietLogs: true,
  });
  return new PluginRegistry(config.stateDir);
});
const list = Command.make("list", authLocationFlags).pipe(
  Command.withHandler(
    Effect.fn(function* (flags) {
      const store = yield* registry(flags);
      const rows = yield* operation(() => store.list());
      yield* Console.log(
        rows.length
          ? rows
              .map((p) => `${p.id}\t${p.version}\t${p.enabled ? "enabled" : "disabled"}`)
              .join("\n")
          : "No plugins installed.",
      );
    }),
  ),
);
const add = Command.make("add", {
  ...authLocationFlags,
  spec: Argument.String("spec"),
  noEnable: Flag.Boolean("no-enable").pipe(Flag.withDefault(false)),
  link: Flag.Boolean("link").pipe(Flag.withDefault(false)),
}).pipe(
  Command.withHandler(
    Effect.fn(function* (flags) {
      const store = yield* registry(flags);
      const row = yield* operation(() =>
        store.install({ spec: flags.spec, enable: !flags.noEnable, link: flags.link }),
      );
      yield* Console.log(row.id);
    }),
  ),
);
const change = (name: "enable" | "disable" | "remove") =>
  Command.make(name, { ...authLocationFlags, id: Argument.String("id") }).pipe(
    Command.withHandler(
      Effect.fn(function* (flags) {
        const store = yield* registry(flags);
        yield* operation(() =>
          store.update(flags.id, name === "remove" ? null : { enabled: name === "enable" }),
        );
      }),
    ),
  );
export const pluginCommand = Command.make("plugin").pipe(
  Command.withDescription("Manage trusted local host plugins."),
  Command.withSubcommands([list, add, change("enable"), change("disable"), change("remove")]),
);
