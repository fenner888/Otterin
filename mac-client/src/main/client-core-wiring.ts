// The ONE integration seam between the Electron main process and
// client-core (PLAN §2).
//
// What is real here today:
//   - initializeClientCorePorts() registers the three macOS port adapters
//     (crypto.node / transport.node / secrets.mac) against
//     client-core/src/ports.ts — that file exists and this wiring is final.
//   - protocolFromClientCore() adapts the client-core protocol module shape
//     into the ipc-facing ClientCoreProtocol, including the method-table
//     additions PLAN §3.4 needs (platform + device.revoke) and the Mac
//     pairing defaults (deviceName "Otterin (Mac)").
//
// What is a merge seam:
//   - client-core/src/{computerPairing,computerBridge,pairedComputers}.ts
//     are being produced by a sibling slice with names identical to
//     src/auth/* . Until they exist this file cannot import them, so
//     `protocol` stays unregistered and ipc returns
//     { ok:false, code:'client_core_unavailable' }.
//
// ==== INTEGRATION ====
// Once the copied modules exist, add at the top of this file:
//   import { pairComputerFromQrPayload } from '../../../client-core/src/computerPairing';
//   import {
//     disconnectComputer,
//     getComputerBridgePlatform,
//     getComputerBridgePresentation,
//     openComputerBridge,
//     removeComputerFromThisIPhone,
//   } from '../../../client-core/src/computerBridge';
//   import { loadPairedComputerSummaries } from '../../../client-core/src/pairedComputers';
// then inside initializeClientCorePorts() (or app boot) call:
//   registerClientCoreProtocol(protocolFromClientCore({
//     pairComputerFromQrPayload,
//     openComputerBridge,
//     disconnectComputer,
//     removeComputerFromThisIPhone,
//     loadPairedComputerSummaries,
//     getComputerBridgePresentation,
//     getComputerBridgePlatform,
//   }));
// and delete this comment.

import {
  registerBridgeTransport,
  registerDeviceCrypto,
  registerSecretStore,
} from '../../../client-core/src/ports';

import type { BridgeConnection } from './bridge-client';
import { nodeDeviceCrypto } from './crypto.node';
import { macSecretBlobStore } from './secrets.mac';
import { nodeBridgeTransport } from './transport.node';

/** Device name this client submits at pairing (PLAN §13). */
export const PAIRING_DEVICE_NAME = 'Otterin (Mac)';

/** Display-name fallback for a paired computer when the offer omits one. */
const DEFAULT_COMPUTER_NAME = 'Otterin Connector';

/**
 * Structural view of the client-core protocol module surface the main
 * process consumes. Signatures are widened to Promise<unknown> so the real
 * typed functions are structurally assignable — the adapter projects the
 * connection onto BridgeConnection (which adds platform + revoke).
 */
export interface ClientCoreBridgeModule {
  pairComputerFromQrPayload(
    payload: string,
    options: {
      computerName: string;
      useConnectorComputerName?: boolean;
      deviceName?: string;
      signal?: AbortSignal;
      onStatus?: (status: string) => void;
    },
  ): Promise<unknown>;
  openComputerBridge(bridgeId: string): Promise<Omit<BridgeConnection, 'getPlatform' | 'revokeDevice'>>;
  /** device.revoke on the bridge, then removes the credential + key locally. */
  disconnectComputer(bridgeId: string): Promise<void>;
  /** Removes the credential + key locally without calling device.revoke. */
  removeComputerFromThisIPhone(bridgeId: string): Promise<void>;
  loadPairedComputerSummaries(): Promise<unknown>;
  getComputerBridgePresentation(bridgeId: string): Promise<unknown>;
  getComputerBridgePlatform(bridgeId: string): Promise<unknown>;
}

/** The ipc-facing protocol contract (renderer never sees raw credentials). */
export interface ClientCoreProtocol {
  pairFromQrPayload(payload: string, signal?: AbortSignal): Promise<unknown>;
  loadPairedComputerSummaries(): Promise<unknown>;
  openBridge(bridgeId: string): Promise<BridgeConnection>;
  disconnectComputer(bridgeId: string): Promise<void>;
  removeComputerLocally(bridgeId: string): Promise<void>;
  getPresentation(bridgeId: string): Promise<unknown>;
}

export class ClientCoreUnavailableError extends Error {
  readonly code = 'client_core_unavailable';
  constructor() {
    super('The local pairing protocol is not wired into this build yet');
    this.name = 'ClientCoreUnavailableError';
  }
}

let protocol: ClientCoreProtocol | null = null;

export function registerClientCoreProtocol(impl: ClientCoreProtocol): void {
  protocol = impl;
}

export function requireClientCoreProtocol(): ClientCoreProtocol {
  if (!protocol) {
    throw new ClientCoreUnavailableError();
  }
  return protocol;
}

/**
 * Adapts the client-core module functions into ClientCoreProtocol. This is
 * real, typechecked code — the only thing the merge adds is the import of
 * the module itself (see INTEGRATION above).
 */
export function protocolFromClientCore(mod: ClientCoreBridgeModule): ClientCoreProtocol {
  return {
    pairFromQrPayload: (payload, signal) =>
      mod.pairComputerFromQrPayload(payload, {
        computerName: DEFAULT_COMPUTER_NAME,
        useConnectorComputerName: true,
        deviceName: PAIRING_DEVICE_NAME,
        ...(signal ? { signal } : {}),
      }),
    loadPairedComputerSummaries: () => mod.loadPairedComputerSummaries(),
    openBridge: async (bridgeId) => {
      const connection = await mod.openComputerBridge(bridgeId);
      return {
        ...connection,
        getPlatform: () => mod.getComputerBridgePlatform(bridgeId),
        revokeDevice: () => mod.disconnectComputer(bridgeId),
      };
    },
    disconnectComputer: (bridgeId) => mod.disconnectComputer(bridgeId),
    removeComputerLocally: (bridgeId) => mod.removeComputerFromThisIPhone(bridgeId),
    getPresentation: (bridgeId) => mod.getComputerBridgePresentation(bridgeId),
  };
}

/**
 * Registers the macOS port adapters with client-core. Safe to call before
 * the first window exists: registration only stores references; the
 * safeStorage store itself stays inert until initSecrets() runs (which
 * must happen after the first BrowserWindow is ready — Electron #34614).
 */
export function initializeClientCorePorts(): void {
  registerDeviceCrypto(nodeDeviceCrypto);
  registerBridgeTransport(nodeBridgeTransport);
  registerSecretStore(macSecretBlobStore);
}
