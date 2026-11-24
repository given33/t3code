import "~/index.css";
import { expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "../../test/render";
import { PluginSettings } from "./_chat.settings.plugins";
import type { PluginApi } from "./-pluginApi";

it("installs, opens a namespaced panel, validates and saves JSON, disables and uninstalls", async () => {
  let installed = false,
    enabled = true,
    config: unknown = {};
  const api: PluginApi = async (path = "", method = "GET", body) => {
    if (method === "GET")
      return installed
        ? [
            {
              id: "example",
              name: "Example",
              version: "1",
              description: "Test plugin",
              status: enabled ? "active" : "disabled",
              enabled,
              config,
              panel: { title: "Example panel", uiPath: "/panel" },
            },
          ]
        : [];
    if (path === "/install") {
      expect(body).toEqual({ spec: "example.tgz" });
      installed = true;
    } else if (path === "/example/config") config = (body as { config: unknown }).config;
    else if (path === "/example/disable") enabled = false;
    else if (method === "DELETE") installed = false;
    else throw new Error("Unexpected operation");
  };
  await using screen = await render(<PluginSettings api={api} canEmbed />);
  await expect.element(screen.getByText("No plugins installed.")).toBeVisible();
  await screen.getByLabelText("Plugin directory or .tgz path on the server").fill("example.tgz");
  await screen.getByRole("button", { name: "Install plugin" }).click();
  await screen.getByRole("button", { name: "Open panel" }).click();
  await expect
    .element(page.getByTitle("Example panel"))
    .toHaveAttribute("src", "/api/plugin-ext/example/panel");
  await screen.getByText("JSON configuration", { exact: true }).click();
  const editor = screen.getByRole("textbox", { name: "JSON configuration" });
  await editor.fill("[]");
  await screen.getByRole("button", { name: "Save configuration" }).click();
  await expect.element(screen.getByRole("alert")).toHaveTextContent("Enter a JSON object.");
  await editor.fill('{"theme":"dark"}');
  await screen.getByRole("button", { name: "Save configuration" }).click();
  await expect.poll(() => config).toEqual({ theme: "dark" });
  await screen.getByRole("switch", { name: "Enable Example" }).click();
  await expect.element(screen.getByText("disabled", { exact: true })).toBeVisible();
  await expect.element(page.getByTitle("Example panel")).not.toBeInTheDocument();
  await screen.getByRole("button", { name: "Uninstall", exact: true }).click();
  await screen.getByRole("button", { name: "Confirm uninstall" }).click();
  await expect.element(screen.getByText("No plugins installed.")).toBeVisible();
});
