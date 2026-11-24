export interface Panel {
  title: string;
  uiPath: string;
  description?: string;
}
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  entry: string;
  description: string;
  panel?: Panel;
}
export type Config = Record<string, unknown>;
export interface PluginRecord extends Omit<PluginManifest, "entry"> {
  packageName: string;
  source: string;
  installPath: string;
  linked: boolean;
  enabled: boolean;
  config: Config;
  installedAt: string;
  updatedAt: string;
}
export interface PluginView extends PluginRecord {
  status: "active" | "disabled" | "error" | "starting";
  error?: string;
}
export interface ServerInfo {
  localOrigin: string | null;
  port: number | null;
  host: string | undefined;
  environmentId: string | null;
  staticDir: string | undefined;
}
export interface SessionOptions {
  label?: string;
  readOnly?: boolean;
}
export interface LocalSession {
  cookieName: string;
  cookieValue: string;
  token: string;
  expiresAt?: string;
}
export type Cleanup = () => void | Promise<void>;
export interface PluginHostContext {
  pluginId: string;
  stateDir: string;
  t3StateDir: string;
  t3BaseDir: string;
  staticDir: string | undefined;
  logger: Pick<Console, "info" | "warn" | "error">;
  getServerInfo(): ServerInfo;
  issueLocalSession(options?: SessionOptions): Promise<LocalSession | null>;
  registerHttpHandler(
    handler: (request: Request, subPath: string) => Response | Promise<Response>,
  ): () => void;
  onShutdown(fn: Cleanup): () => void;
}
export interface InstallOptions {
  spec: string;
  enable?: boolean;
  link?: boolean;
  config?: Config;
}
