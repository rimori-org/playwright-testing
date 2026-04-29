import { ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import { PluginProvider } from '@rimori/react-client';

declare global {
  interface Window {
    __RIMORI_HARNESS__?: { pluginId: string; remoteUrl: string };
  }
}

// @module-federation/vite registers the host under an internal-prefixed name.
// See INTERNAL_NAME_PREFIX in @module-federation/vite/lib/index.mjs.
const HOST_NAME = '__mfe_internal__rimori-scenario-host';

interface FederationHost {
  name: string;
  registerRemotes: (remotes: { name: string; entry: string; type: string }[], options: { force: boolean }) => void;
  loadRemote: <T = unknown>(id: string) => Promise<T>;
}

interface FederationGlobal {
  __FEDERATION__?: { __INSTANCES__?: FederationHost[] };
}

// The vite plugin's auto-init bootstrap calls `createInstance` from
// @module-federation/runtime, which registers the host on
// globalThis.__FEDERATION__.__INSTANCES__ but does NOT set the module-local
// `FederationInstance` used by the package's exported `registerRemotes` /
// `loadRemote` helpers. Calling those helpers directly therefore throws
// RUNTIME-009 ("Please call createInstance first."). We resolve the host
// instance from the global registry and call the methods on it instead.
async function getHostInstance(): Promise<FederationHost> {
  const start = Date.now();
  while (Date.now() - start < 5000) {
    const instances = (globalThis as unknown as FederationGlobal).__FEDERATION__?.__INSTANCES__ ?? [];
    const host = instances.find((inst) => inst?.name === HOST_NAME);
    if (host) return host;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(`[rimori-harness] Module Federation host '${HOST_NAME}' did not initialize within 5s`);
}

async function main() {
  const config = window.__RIMORI_HARNESS__;
  if (!config) throw new Error('[rimori-harness] Missing window.__RIMORI_HARNESS__ config.');

  const { pluginId, remoteUrl } = config;

  const host = await getHostInstance();
  host.registerRemotes([{ name: pluginId, entry: remoteUrl, type: 'module' }], { force: true });
  const mod = await host.loadRemote(`${pluginId}/MainPanel`);
  const Remote = ((mod as { default?: ComponentType }).default ?? mod) as ComponentType;

  createRoot(document.getElementById('root')!).render(
    <PluginProvider pluginId={pluginId}>
      <Remote />
    </PluginProvider>,
  );
}

void main().catch((err) => {
  console.error('[rimori-harness] fatal:', err);
  const root = document.getElementById('root');
  if (root) root.innerHTML = `<pre style="color:red;padding:1rem">${String(err?.message ?? err)}</pre>`;
});

export {};
