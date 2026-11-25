import { defineConfig } from "vite-plus";
export default defineConfig({
  pack: {
    entry: ["src/index.ts"],
    format: "esm",
    outExtensions: () => ({ js: ".js" }),
    target: "esnext",
    dts: false,
  },
});
