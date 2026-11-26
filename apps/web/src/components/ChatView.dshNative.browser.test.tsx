import { createMemoryHistory } from "@tanstack/react-router";
import {
  ORCHESTRATION_V2_WS_METHODS,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  type OrchestrationV2GetTurnItemInput,
  type OrchestrationV2ProviderThread,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import projected from "../../test/fixtures/dsh-native/projected.json";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
import "~/components/ChatView";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  answerRpc,
  dispatchedCommands,
  emitThreadEvent,
  installFakeEnvironment,
  threadWithHistory,
  turnItemBase,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { render } from "../../test/render";

vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

const displayName = "deepseek-v4.1-flash";
const model = {
  instanceId: ProviderInstanceId.make("dsh"),
  model: '["pixel","deepseek-v4.1-flash-1017"]',
};
const driver = ProviderDriverKind.make("dsh");
const commands = ["compact", "feedback", "goal", "permission", "plan"];
const skills = ["diagnose-windows-sandbox-acl", "reverse-engineer-anything"];
const provider = {
  instanceId: model.instanceId,
  driver,
  displayName: "DeepSeek Harness",
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-03-17T19:12:28.000Z",
  reportsContextWindow: true,
  supportedRuntimeModes: ["approval-required", "full-access"],
  models: [
    { slug: "default", name: "Harness default", isCustom: false, capabilities: null },
    {
      slug: model.model,
      name: displayName,
      subProvider: "pixel",
      isCustom: false,
      capabilities: null,
    },
  ],
  subProviders: [{ name: "pixel" }],
  slashCommands: commands.map((name) => ({ name })),
  skills: skills.map((name) => ({
    name,
    enabled: true,
    scope: "agent",
    path: `acp://skill/${name}`,
  })),
};

function dshThread(name: string, selection = model) {
  const thread = threadWithHistory(`thread-dsh-${name}`, 1, selection);
  const at = DateTime.makeUnsafe(provider.checkedAt);
  const providerThread: OrchestrationV2ProviderThread = {
    id: ProviderThreadId.make(`${thread.id}-provider`),
    driver,
    providerInstanceId: model.instanceId,
    providerSessionId: null,
    appThreadId: thread.id,
    ownerNodeId: null,
    nativeThreadRef: { driver, nativeId: `${thread.id}-native`, strength: "strong" },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: 1,
    lastRunOrdinal: 1,
    handoffIds: [],
    forkedFrom: null,
    pendingBackgroundTasks: [],
    contextUsage: null,
    nativeMetadata: null,
    goal: null,
    createdAt: at,
    updatedAt: at,
  };
  return { ...thread, providerThreads: [providerThread] as const };
}

// The app retains its shell subscription across mounts; every test route must exist in that shell.
const threads = {
  model: dshThread("model", { ...model, model: "default" }),
  commands: dshThread("commands"),
  permissions: dshThread("permissions"),
  plan: dshThread("plan"),
  tools: dshThread("tools"),
  usage: dshThread("usage"),
};

async function openThread(thread: ReturnType<typeof dshThread>) {
  await using scope = new AsyncDisposableStack();
  const { innerWidth, innerHeight } = window;
  scope.defer(() => page.viewport(innerWidth, innerHeight));
  await page.viewport(1440, 900);
  scope.use(
    installFakeEnvironment(Object.values(threads), {
      providers: [provider],
      providerInstances: { [model.instanceId]: { driver, enabled: true } },
      acceptCommands: true,
    }),
  );
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
    threadDetailsItems: { context: true },
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  // AppRoot brings its own router.
  scope.use(await render(<AppRoot router={router} />, { router: false }));
  await expect.element(page.getByText(`Answer 0 for ${thread.id}.`)).toBeVisible();
  return scope.move();
}

it("selects the pixel model by its DeepSeek Harness display name and sends the versioned slug", async () => {
  const thread = threads.model;
  await using _app = await openThread(thread);
  await page.getByRole("button", { name: "Harness default", exact: true }).click();
  await expect.element(page.getByRole("option", { name: /^pixel\b/ })).toBeVisible();
  await page.getByRole("option", { name: /^pixel\b/ }).click();
  const option = page.getByRole("option", { name: /deepseek-v4\.1-flash,? DeepSeek Harness/i });
  await expect.element(option).toBeVisible();
  await expect.element(option.getByText("pixel", { exact: true })).toBeVisible();
  await option.click();
  await expect
    .element(page.getByRole("button", { name: "deepseek-v4.1-flash", exact: true }))
    .toBeVisible();
  await vi.waitFor(() =>
    expect(dispatchedCommands()).toContainEqual(
      expect.objectContaining({
        type: "thread.model-selection.set",
        threadId: thread.id,
        modelSelection: {
          instanceId: model.instanceId,
          model: '["pixel","deepseek-v4.1-flash-1017"]',
        },
      }),
    ),
  );
});

it("offers five DSH slash commands and both ACP skills in the composer", async () => {
  await using _app = await openThread(threads.commands);
  const editor = page.getByTestId("composer-editor");
  await userEvent.type(editor, "/");
  const menu = page.getByRole("listbox", { name: "Commands" });
  for (const name of commands)
    await expect.element(menu.getByText(`/${name}`, { exact: true })).toBeVisible();
  await userEvent.keyboard("{Backspace}");
  await userEvent.type(editor, "$");
  const skillMenu = page.getByRole("listbox", { name: "Skills" });
  for (const name of skills)
    await expect
      .element(skillMenu.getByRole("option", { name: new RegExp(name, "i") }))
      .toBeVisible();
});

it("updates DSH permissions and dispatches the selected thread runtime mode", async () => {
  const thread = threads.permissions;
  await using _app = await openThread(thread);
  await page.getByRole("button", { name: displayName, exact: true }).click();
  await page.getByRole("button", { name: "Permissions: Full access" }).click();
  for (const name of ["Supervised", "Full access"])
    await expect.element(page.getByRole("menuitemradio", { name, exact: true })).toBeVisible();
  await expect.poll(() => page.getByRole("menuitemradio").elements().length).toBe(2);
  for (const name of ["Auto-accept edits", "Auto"])
    await expect
      .element(page.getByRole("menuitemradio", { name, exact: true }))
      .not.toBeInTheDocument();
  await expect
    .element(page.getByText(/read-only|workspace-write|danger-full-access/i))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByRole("menuitemradio", { name: "Full access", exact: true }))
    .toHaveAttribute("aria-checked", "true");
  await page.getByRole("menuitemradio", { name: "Supervised" }).click();
  await expect
    .element(page.getByRole("button", { name: "Permissions: Supervised" }).first())
    .toBeVisible();
  await userEvent.keyboard("{Escape}");
  await userEvent.type(page.getByTestId("composer-editor"), "Inspect this workspace{Enter}");
  await vi.waitFor(() =>
    expect(dispatchedCommands()).toContainEqual(
      expect.objectContaining({
        type: "thread.runtime-mode.set",
        threadId: thread.id,
        runtimeMode: "approval-required",
      }),
    ),
  );
});

const decodeItem = Schema.decodeUnknownSync(Schema.toType(OrchestrationV2TurnItem));

function wireItems(thread: ReturnType<typeof dshThread>, type: OrchestrationV2TurnItem["type"]) {
  return projected.items
    .filter((item) => item.type === type)
    .map((item) => {
      const base = turnItemBase(thread.id, thread.runs[0]!.id, item.id, item.ordinal);
      return decodeItem({
        ...base,
        ...item,
        providerThreadId: thread.providerThreads[0].id,
        completedAt: item.status === "completed" ? base.completedAt : null,
      });
    });
}

it("renders completed, running and pending steps from a DSH plan update", async () => {
  const thread = threads.plan;
  await using _app = await openThread(thread);
  const [plan] = wireItems(thread, "todo_list");
  await emitThreadEvent(thread.id, { type: "turn-item.updated", payload: plan! });
  await page.getByRole("button", { name: /Tasks 1\/3/ }).click();
  for (const step of ["\u2713 Create fixture", "\u25c9 Inspect fixture", "\u25cb Write report"])
    await expect.element(page.getByText(step, { exact: false })).toBeVisible();
});

it("updates the executing command and opens a located read and the native edit diff", async () => {
  const thread = threads.tools;
  await using _app = await openThread(thread);
  const emit = (payload: OrchestrationV2TurnItem) =>
    emitThreadEvent(thread.id, { type: "turn-item.updated", payload });
  const [start, end] = wireItems(thread, "command_execution");
  await emit(start!);
  const command = "Get-Content -LiteralPath acp-fixture.txt";
  await expect.element(page.getByText(/Running.*Ran command/)).toBeVisible();
  await emit(end!);
  await page.getByRole("button", { name: /^Worked for/ }).click();
  await page.getByRole("button", { name: /Ran command|Get-Content/ }).click();
  await expect.element(page.getByText(command, { exact: true }).first()).toBeVisible();
  await expect.element(page.getByText("offline pwsh verified", { exact: true })).toBeVisible();
  const [read, readDone] = wireItems(thread, "dynamic_tool");
  const [edit, editDone] = wireItems(thread, "file_change");
  using _detail = answerRpc(
    ORCHESTRATION_V2_WS_METHODS.getTurnItem,
    (input: OrchestrationV2GetTurnItemInput) =>
      Effect.succeed({
        item: input.threadId === thread.id && input.itemId === editDone!.id ? editDone : null,
      }),
  );
  for (const update of [read!, edit!, readDone!, editDone!]) await emit(update);
  await page.getByText(/Ran 1 command, changed 1 file/).click();
  await page.getByRole("button", { name: /Read.*acp-fixture/i }).click();
  await expect
    .element(page.getByText(/\/workspace\/render\/acp-fixture\.txt/).last())
    .toBeVisible();
  await page.getByRole("button", { name: /report\.txt/ }).click();
  await page.getByRole("button", { name: "Open diff" }).click();
  const toggle = page.getByRole("button", { name: /^(Expand|Collapse) report\.txt$/ });
  await expect.element(toggle, { timeout: 4500 }).toBeVisible();
  if (toggle.element().getAttribute("aria-expanded") === "false") await toggle.click();
  await expect.element(page.getByText("Projection verified", { exact: true })).toBeVisible();
});

it("shows context used and capacity after DSH reports usage", async () => {
  const thread = threads.usage;
  await using _app = await openThread(thread);
  const row = page.getByLabelText("Context: 25% used");
  await expect.element(row).not.toBeInTheDocument();
  await emitThreadEvent(thread.id, {
    type: "provider-thread.updated",
    payload: { ...thread.providerThreads[0], contextUsage: projected.contextUsage },
  });
  await expect.element(row).toBeVisible();
  await expect.element(row.getByText("32k / 128k", { exact: true })).toBeVisible();
});
