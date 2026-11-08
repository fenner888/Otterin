import { z } from 'zod';

import { opaqueIdSchema } from './schemas';

export const CONNECTOR_IPC_VERSION = 1 as const;
export const MAXIMUM_CONNECTOR_IPC_LINE_BYTES = 16_384;

export const connectorCommandSchema = z.discriminatedUnion('type', [
  z.object({ version: z.literal(CONNECTOR_IPC_VERSION), type: z.literal('regenerate') }).strict(),
  z
    .object({
      version: z.literal(CONNECTOR_IPC_VERSION),
      type: z.literal('approve'),
      pairingId: opaqueIdSchema,
      allowSessionContent: z.boolean(),
    })
    .strict(),
  z
    .object({
      version: z.literal(CONNECTOR_IPC_VERSION),
      type: z.literal('update_device'),
      deviceId: opaqueIdSchema,
      allowSessionContent: z.boolean(),
      allowSessionPrompt: z.boolean(),
      allowSessionCreate: z.boolean(),
    })
    .strict(),
  z
    .object({
      version: z.literal(CONNECTOR_IPC_VERSION),
      type: z.literal('revoke_device'),
      deviceId: opaqueIdSchema,
    })
    .strict(),
  z
    .object({
      version: z.literal(CONNECTOR_IPC_VERSION),
      type: z.literal('deny'),
      pairingId: opaqueIdSchema,
    })
    .strict(),
  z.object({ version: z.literal(CONNECTOR_IPC_VERSION), type: z.literal('shutdown') }).strict(),
  z.object({ version: z.literal(CONNECTOR_IPC_VERSION), type: z.literal('reset') }).strict(),
]);

const connectorErrorCodeSchema = z.enum([
  'bridge_start_failed',
  'command_invalid',
  'pairing_expired',
  'pairing_failed',
  'uninstall_failed',
  'tailscale_unavailable',
  'unsupported_platform',
]);

export const connectorEventSchema = z.discriminatedUnion('type', [
  z
    .object({
      version: z.literal(CONNECTOR_IPC_VERSION),
      type: z.literal('pairing_offer'),
      payload: z.string().min(1).max(4_096),
      expiresAt: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      version: z.literal(CONNECTOR_IPC_VERSION),
      type: z.literal('reset_complete'),
    })
    .strict(),
  z
    .object({
      version: z.literal(CONNECTOR_IPC_VERSION),
      type: z.literal('ready'),
      transport: z.enum(['tailscale_vpn', 'local_network']),
      sessionDiscoveryEnabled: z.boolean(),
      cliDetected: z.boolean(),
    })
    .strict(),
  z
    .object({
      version: z.literal(CONNECTOR_IPC_VERSION),
      type: z.literal('pairing_review'),
      pairingId: opaqueIdSchema,
      deviceName: z.string().min(1).max(80),
      // Truncated device-key SAS; optional so events emitted before patch 5
      // still validate and older Connectors simply ignore the field.
      deviceKeyFingerprint: z
        .string()
        .min(8)
        .max(43)
        .regex(/^[A-Za-z0-9_-]+$/)
        .optional(),
      expiresAt: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      version: z.literal(CONNECTOR_IPC_VERSION),
      type: z.literal('pairing_diagnostic'),
      route: z.enum(['protected_request', 'pairing_submit', 'pairing_status']),
      phase: z.enum(['metadata', 'body', 'handler']),
      status: z.union([
        z.literal(200),
        z.literal(202),
        z.literal(400),
        z.literal(404),
        z.literal(409),
        z.literal(413),
        z.literal(415),
        z.literal(429),
        z.literal(503),
      ]),
    })
    .strict(),
  z
    .object({
      version: z.literal(CONNECTOR_IPC_VERSION),
      type: z.literal('pairing_complete'),
      access: z.enum(['metadata_only', 'read_only_content']),
    })
    .strict(),
  z
    .object({
      version: z.literal(CONNECTOR_IPC_VERSION),
      type: z.literal('devices'),
      devices: z
        .array(
          z
            .object({
              deviceId: opaqueIdSchema,
              deviceName: z.string().min(1).max(80),
              pairedAt: z.number().int().nonnegative(),
              status: z.enum(['active', 'revoked']),
              allowSessionContent: z.boolean(),
              allowSessionPrompt: z.boolean(),
              allowSessionCreate: z.boolean(),
            })
            .strict(),
        )
        .max(100),
    })
    .strict(),
  z
    .object({
      version: z.literal(CONNECTOR_IPC_VERSION),
      type: z.literal('error'),
      code: connectorErrorCodeSchema,
    })
    .strict(),
]);

export type ConnectorCommand = z.infer<typeof connectorCommandSchema>;
export type ConnectorEvent = z.infer<typeof connectorEventSchema>;

export function encodeConnectorEvent(input: ConnectorEvent): string {
  const event = connectorEventSchema.parse(input);
  const encoded = `${JSON.stringify(event)}\n`;
  if (Buffer.byteLength(encoded, 'utf8') > MAXIMUM_CONNECTOR_IPC_LINE_BYTES) {
    throw new Error('Connector IPC event exceeded the line limit');
  }
  return encoded;
}

export function parseConnectorCommand(input: string): ConnectorCommand {
  if (Buffer.byteLength(input, 'utf8') > MAXIMUM_CONNECTOR_IPC_LINE_BYTES) {
    throw new Error('Connector IPC command exceeded the line limit');
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(input);
  } catch {
    throw new Error('Connector IPC command is not valid JSON');
  }
  return connectorCommandSchema.parse(decoded);
}
