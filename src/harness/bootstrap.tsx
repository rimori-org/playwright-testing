import { ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import { PluginProvider } from '@rimori/react-client';
import { registerRemotes, loadRemote } from '@module-federation/enhanced/runtime';

declare global {
  interface Window {
    __RIMORI_HARNESS__?: { pluginId: string; remoteUrl: string };
  }
}

async function main() {
  const config = window.__RIMORI_HARNESS__;
  if (!config) throw new Error('[rimori-harness] Missing window.__RIMORI_HARNESS__ config.');

  const { pluginId, remoteUrl } = config;

  // Same pattern as rimori-main's FederatedPluginRenderer
  registerRemotes([{ name: pluginId, entry: remoteUrl, type: 'module' }], { force: true });
  const mod = await loadRemote(`${pluginId}/MainPanel`);
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
