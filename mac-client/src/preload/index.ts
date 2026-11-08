import { contextBridge, ipcRenderer } from 'electron';

// Invoke-only bridge surface. Channel names are pinned; the main process
// re-validates every payload with zod and pins handlers to this window's
// top frame (src/main/ipc.ts owns the authoritative channel table — keep
// these in sync).
const CHANNELS = [
  'pair:capture',
  'pair:import',
  'pair:preview',
  'pair:submit',
  'pair:cancel',
  'computers:list',
  'computers:disconnect',
  'bridge:health',
  'bridge:features',
  'bridge:version',
  'bridge:platform',
  'bridge:presentation',
  'session:list',
  'session:load',
  'session:activity',
  'session:prompt',
  'session:cancel',
  'session:elicitation',
  'session:elicitation:respond',
  'session:permission',
  'session:permission:respond',
  'session:createOptions',
  'session:create',
  'device:revoke',
  'scheduler:snapshot',
  'scheduler:setSession',
  'scheduler:pollNow',
  'app:openConnector',
  'app:openDevin',
] as const;

export type OtterinChannel = (typeof CHANNELS)[number];

contextBridge.exposeInMainWorld('otterin', {
  invoke: (channel: OtterinChannel, payload?: unknown) => {
    if (!CHANNELS.includes(channel)) {
      return Promise.reject(new Error(`unknown channel: ${channel}`));
    }
    return ipcRenderer.invoke(channel, payload);
  },
});
