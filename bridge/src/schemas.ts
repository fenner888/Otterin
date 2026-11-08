import { z } from 'zod';

export const BRIDGE_PROTOCOL_VERSION = 2 as const;

export const transportSecuritySchema = z.enum(['tailscale_wireguard', 'pinned_tls']);
export type TransportSecurity = z.infer<typeof transportSecuritySchema>;

export const opaqueIdSchema = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

export const sessionIdSchema = z.string().min(1).max(512);
export const workspaceHandleSchema = z.string().regex(/^workspace_[A-Za-z0-9_-]{43}$/);
export const modelIdSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9._:+-]+$/);
export const interactionIdSchema = z.string().regex(/^interaction_[A-Za-z0-9_-]{43}$/);
export const permissionIdSchema = z.string().regex(/^permission_[A-Za-z0-9_-]{43}$/);
const cursorSchema = z.string().min(1).max(4096);
export const deviceNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine(
    (value) =>
      [...value].every((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint >= 32 && codePoint !== 127;
      }),
    'Device name contains control characters',
  );

export const bridgeMethodSchema = z.enum([
  'bridge.health',
  'bridge.features',
  'bridge.platform',
  'bridge.version',
  'device.revoke',
  'session.list',
  'session.load',
  'session.activity',
  'session.elicitation',
  'session.elicitation.respond',
  'session.permission',
  'session.permission.respond',
  'session.cancel',
  'session.prompt',
  'session.create_options',
  'session.create',
]);

export const bridgePermissionSchema = z.enum([
  'bridge:health',
  'session:metadata:read',
  'session:content:read',
  'session:prompt:send',
  'session:create',
]);
export const sessionPermissionDecisionSchema = z.enum([
  'allow_once',
  'allow_session',
  'reject_once',
]);
export type SessionPermissionDecision = z.infer<typeof sessionPermissionDecisionSchema>;

export const signedRequestEnvelopeSchema = z
  .object({
    protocolVersion: z.literal(BRIDGE_PROTOCOL_VERSION),
    bridgeId: opaqueIdSchema,
    deviceId: opaqueIdSchema,
    requestId: opaqueIdSchema,
    issuedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().positive(),
    nonce: z
      .string()
      .min(22)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/),
    method: bridgeMethodSchema,
    body: z.unknown(),
    signature: z
      .string()
      .min(80)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/),
  })
  .strict()
  .superRefine((value, context) => {
    if (!Object.prototype.hasOwnProperty.call(value, 'body')) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Request body is required' });
    }
  });

export const bridgeHealthBodySchema = z.object({}).strict();
export const bridgeFeaturesBodySchema = z
  .object({
    interaction: z.literal(true).optional(),
    presentation: z.literal(true).optional(),
  })
  .strict();
export const bridgePlatformBodySchema = z.object({}).strict();
export const bridgeVersionBodySchema = z.object({}).strict();
export const deviceRevokeBodySchema = z.object({}).strict();

export const sessionListBodySchema = z
  .object({
    cursor: cursorSchema.optional(),
    interaction: z.literal(true).optional(),
    ownership: z.boolean().optional(),
  })
  .strict();

export const sessionLoadBodySchema = z
  .object({
    sessionId: sessionIdSchema,
    interaction: z.literal(true).optional(),
    timestamps: z.literal(true).optional(),
    ownership: z.boolean().optional(),
  })
  .strict();

export const sessionActivityBodySchema = z
  .object({
    sessionId: sessionIdSchema,
    interaction: z.literal(true).optional(),
  })
  .strict();

export const sessionPermissionBodySchema = z
  .object({
    sessionId: sessionIdSchema,
  })
  .strict();

export const sessionPermissionResponseBodySchema = z
  .object({
    sessionId: sessionIdSchema,
    permissionId: permissionIdSchema,
    decision: sessionPermissionDecisionSchema,
  })
  .strict();

export const sessionElicitationBodySchema = z
  .object({
    sessionId: sessionIdSchema,
  })
  .strict();

const elicitationContentValueSchema = z.union([
  z.string().max(10_000),
  z.number().finite(),
  z.boolean(),
  z.array(z.string().max(500)).max(100),
]);

const elicitationContentSchema = z
  .record(elicitationContentValueSchema)
  .superRefine((value, context) => {
    const keys = Object.keys(value);
    if (keys.length > 16 || keys.some((key) => [...key].length > 160)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid elicitation content' });
    }
  });

export const sessionElicitationResponseBodySchema = z.union([
  z
    .object({
      sessionId: sessionIdSchema,
      interactionId: interactionIdSchema,
      action: z.literal('accept'),
      content: elicitationContentSchema,
    })
    .strict(),
  z
    .object({
      sessionId: sessionIdSchema,
      interactionId: interactionIdSchema,
      action: z.enum(['decline', 'cancel']),
    })
    .strict(),
]);

export const sessionPromptBodySchema = z
  .object({
    sessionId: sessionIdSchema,
    text: z.string().min(1).max(100_000),
    modelId: modelIdSchema.optional(),
    autoApprove: z.boolean().optional(),
  })
  .strict();

export const sessionCancelBodySchema = z
  .object({
    sessionId: sessionIdSchema,
  })
  .strict();

export const sessionCreateOptionsBodySchema = z
  .object({
    refresh: z.boolean().optional(),
  })
  .strict();

export const sessionCreateBodySchema = z
  .object({
    workspaceId: workspaceHandleSchema,
    modelId: modelIdSchema.nullable().optional(),
    text: z.string().trim().min(1).max(10_000),
    autoApprove: z.boolean().optional(),
  })
  .strict();

export const deviceRecordSchema = z
  .object({
    bridgeId: opaqueIdSchema,
    deviceId: opaqueIdSchema,
    deviceName: deviceNameSchema,
    publicKeySpki: z
      .string()
      .min(32)
      .max(1024)
      .regex(/^[A-Za-z0-9_-]+$/),
    status: z.enum(['active', 'revoked']),
    pairedAt: z.number().int().nonnegative(),
    permissions: z.array(bridgePermissionSchema).max(bridgePermissionSchema.options.length),
    allowedSessionIds: z.array(sessionIdSchema).max(10_000).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.permissions).size !== value.permissions.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Permissions must be unique' });
    }
    if (
      value.allowedSessionIds &&
      new Set(value.allowedSessionIds).size !== value.allowedSessionIds.length
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Session scopes must be unique' });
    }
  });

export const bodySchemas = {
  'bridge.health': bridgeHealthBodySchema,
  'bridge.features': bridgeFeaturesBodySchema,
  'bridge.platform': bridgePlatformBodySchema,
  'bridge.version': bridgeVersionBodySchema,
  'device.revoke': deviceRevokeBodySchema,
  'session.list': sessionListBodySchema,
  'session.load': sessionLoadBodySchema,
  'session.activity': sessionActivityBodySchema,
  'session.elicitation': sessionElicitationBodySchema,
  'session.elicitation.respond': sessionElicitationResponseBodySchema,
  'session.permission': sessionPermissionBodySchema,
  'session.permission.respond': sessionPermissionResponseBodySchema,
  'session.cancel': sessionCancelBodySchema,
  'session.prompt': sessionPromptBodySchema,
  'session.create_options': sessionCreateOptionsBodySchema,
  'session.create': sessionCreateBodySchema,
} as const;

export const permissionByMethod = {
  'bridge.health': 'bridge:health',
  'bridge.features': 'bridge:health',
  'bridge.platform': 'bridge:health',
  'bridge.version': 'bridge:health',
  'device.revoke': 'bridge:health',
  'session.list': 'session:metadata:read',
  'session.load': 'session:content:read',
  'session.activity': 'session:content:read',
  'session.elicitation': 'session:content:read',
  'session.elicitation.respond': 'session:prompt:send',
  'session.permission': 'session:content:read',
  'session.permission.respond': 'session:prompt:send',
  'session.cancel': 'session:prompt:send',
  'session.prompt': 'session:prompt:send',
  'session.create_options': 'session:metadata:read',
  'session.create': 'session:create',
} as const satisfies Record<BridgeMethod, BridgePermission>;

export type BridgeMethod = z.infer<typeof bridgeMethodSchema>;
export type BridgePermission = z.infer<typeof bridgePermissionSchema>;
export type SignedRequestEnvelope = z.infer<typeof signedRequestEnvelopeSchema>;
export type DeviceRecord = z.infer<typeof deviceRecordSchema>;
export type BridgeHealthBody = z.infer<typeof bridgeHealthBodySchema>;
export type BridgeFeaturesBody = z.infer<typeof bridgeFeaturesBodySchema>;
export type BridgePlatformBody = z.infer<typeof bridgePlatformBodySchema>;
export type BridgeVersionBody = z.infer<typeof bridgeVersionBodySchema>;
export type DeviceRevokeBody = z.infer<typeof deviceRevokeBodySchema>;
export type SessionListBody = z.infer<typeof sessionListBodySchema>;
export type SessionLoadBody = z.infer<typeof sessionLoadBodySchema>;
export type SessionActivityBody = z.infer<typeof sessionActivityBodySchema>;
export type SessionElicitationBody = z.infer<typeof sessionElicitationBodySchema>;
export type SessionElicitationResponseBody = z.infer<typeof sessionElicitationResponseBodySchema>;
export type SessionPermissionBody = z.infer<typeof sessionPermissionBodySchema>;
export type SessionPermissionResponseBody = z.infer<typeof sessionPermissionResponseBodySchema>;
export type SessionCancelBody = z.infer<typeof sessionCancelBodySchema>;
export type SessionPromptBody = z.infer<typeof sessionPromptBodySchema>;
export type SessionCreateOptionsBody = z.infer<typeof sessionCreateOptionsBodySchema>;
export type SessionCreateBody = z.infer<typeof sessionCreateBodySchema>;

export type BridgeBodyByMethod = {
  'bridge.health': BridgeHealthBody;
  'bridge.features': BridgeFeaturesBody;
  'bridge.platform': BridgePlatformBody;
  'bridge.version': BridgeVersionBody;
  'device.revoke': DeviceRevokeBody;
  'session.list': SessionListBody;
  'session.load': SessionLoadBody;
  'session.activity': SessionActivityBody;
  'session.elicitation': SessionElicitationBody;
  'session.elicitation.respond': SessionElicitationResponseBody;
  'session.permission': SessionPermissionBody;
  'session.permission.respond': SessionPermissionResponseBody;
  'session.cancel': SessionCancelBody;
  'session.prompt': SessionPromptBody;
  'session.create_options': SessionCreateOptionsBody;
  'session.create': SessionCreateBody;
};
