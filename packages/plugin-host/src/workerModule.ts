// A standalone ES module, embedded so the bundled CLI does not need a worker file on disk.
// Workers isolate crashes and blocked event loops, not permissions: install only trusted code.
export const workerModule = new URL(
  `data:text/javascript,${encodeURIComponent(`
import { parentPort as port, workerData } from 'node:worker_threads';
const { context, info, entry, config } = workerData;
const handlers = new Set(), cleanups = new Set();
const register = (set, fn) => { set.add(fn); return () => set.delete(fn); };
const ctx = { ...context, getServerInfo: () => ({...info}),
  logger: Object.fromEntries(['info','warn','error'].map(level => [level, (...args) => console[level]('[' + context.pluginId + ']', ...args)])),
  issueLocalSession: (options) => new Promise((resolve, reject) => {
    const { port1, port2 } = new MessageChannel();
    port1.once('message', ({session, error}) => { port1.close(); if (error) reject(new Error(error)); else resolve(session); });
    port.postMessage({ session: true, options, port: port2 }, [port2]);
  }),
  registerHttpHandler: (fn) => register(handlers, fn), onShutdown: (fn) => register(cleanups, fn)
};
port.on('message', async ({id, op, input}) => {
  try {
    if (op === 'start') {
      const module = await import(entry);
      const apply = module.apply ?? module.default?.apply;
      if (typeof apply !== 'function') throw new Error('Missing apply(ctx, config)');
      const result = await apply(ctx, config);
      if (typeof result === 'function') cleanups.add(result);
      else if (result?.dispose) cleanups.add(() => result.dispose());
    } else if (op === 'stop') {
      handlers.clear();
      const failures = [];
      for (const fn of [...cleanups].reverse()) { try { await fn(); } catch (error) { failures.push(String(error)); } }
      cleanups.clear();
      if (failures.length) throw new Error(failures.join('; '));
    } else {
      const request = new Request(input.url, {method: input.method, headers: input.headers, body: input.body, duplex: 'half'});
      let response;
      for (const handler of handlers) {
        response = await handler(request, input.subPath);
        if (response.status !== 404) break;
      }
      response ??= new Response(null, {status: 404});
      const {body, status, statusText} = response;
      port.postMessage({id, value: {body, status, statusText, headers: [...response.headers]}}, body ? [body] : []);
      return;
    }
    port.postMessage({id});
  } catch (error) { port.postMessage({id, error: error instanceof Error ? error.message : String(error)}); }
});
`)}`,
);
