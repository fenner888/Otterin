import { contextBridge, ipcRenderer } from 'electron';

// Invoke-only bridge surface. Channel names are pinned; the main process
// re-validates every payload with zod.
const CHANNELS = [
  'pair:capture',
  'pair:submit',
  'computers:list',
  'computers:disconnect',
  'bridge:health',
  'bridge:features',
  'bridge:version',
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
