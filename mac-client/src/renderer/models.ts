/**
 * Model catalog helpers — port of src/lib/computer-model-catalog.ts for the
 * desktop renderer (family/variant grouping, display splitting).
 */
import type { ComputerModel } from './types';

export type { ComputerModel };

export interface ModelVariant {
  label: string;
  model: ComputerModel;
}

export interface ModelFamily {
  key: string;
  name: string;
  description?: string;
  badge?: 'new' | 'free_promo';
  recent: boolean;
  recommended: boolean;
  variants: ModelVariant[];
}

function normalizeEffort(value: string): string {
  if (value === 'No') return 'None';
  if (value === 'X-High') return 'XHigh';
  return value;
}

export function splitComputerModelName(name: string): { family: string; variant: string } {
  const thinking = name.match(/^(.*) (No|Low|Medium|High|XHigh|X-High|Max) Thinking( Fast)?$/);
  if (thinking) {
    return {
      family: thinking[1] ?? name,
      variant: `${normalizeEffort(thinking[2] ?? '')}${thinking[3] ? ' · Fast' : ''}`,
    };
  }

  const contextThinking = name.match(/^(.*?) (No Thinking|High|Max|Thinking) 1M$/);
  if (contextThinking) {
    return {
      family: contextThinking[1] ?? name,
      variant: `${contextThinking[2] === 'No Thinking' ? 'None' : contextThinking[2]} · 1M`,
    };
  }

  const contextOnly = name.match(/^(.*) 1M$/);
  if (contextOnly) return { family: contextOnly[1] ?? name, variant: '1M' };

  const thinkingOnly = name.match(/^(.*) Thinking$/);
  if (thinkingOnly) return { family: thinkingOnly[1] ?? name, variant: 'Thinking' };

  const speed = name.match(/^(SWE-[0-9]+(?:\.[0-9]+)?) (Fast|Lightning)$/);
  if (speed) return { family: speed[1] ?? name, variant: speed[2] ?? 'Fast' };

  const effort = name.match(/^(.*) (Minimal|Low|Medium|High|XHigh|X-High|Max)( Fast)?$/);
  if (effort) {
    return {
      family: effort[1] ?? name,
      variant: `${normalizeEffort(effort[2] ?? '')}${effort[3] ? ' · Fast' : ''}`,
    };
  }

  return { family: name, variant: 'Default' };
}

function familyBadge(models: ComputerModel[]): 'new' | 'free_promo' | undefined {
  if (models.some((model) => model.badge === 'free_promo')) return 'free_promo';
  if (models.some((model) => model.badge === 'new')) return 'new';
  return undefined;
}

export function groupComputerModels(models: ComputerModel[]): ModelFamily[] {
  const families = new Map<string, ModelFamily>();
  for (const model of models) {
    const presentation = splitComputerModelName(model.name);
    const existing = families.get(presentation.family);
    if (existing) {
      existing.variants.push({ label: presentation.variant, model });
      existing.recent ||= model.recent === true;
      existing.recommended ||= model.recommended === true;
      if (!existing.description && model.description) existing.description = model.description;
      existing.badge = familyBadge(existing.variants.map((variant) => variant.model));
      continue;
    }
    families.set(presentation.family, {
      key: presentation.family,
      name: presentation.family,
      ...(model.description ? { description: model.description } : {}),
      ...(model.badge ? { badge: model.badge } : {}),
      recent: model.recent === true,
      recommended: model.recommended === true,
      variants: [{ label: presentation.variant, model }],
    });
  }
  return [...families.values()];
}

export function familyForModelId(
  families: ModelFamily[],
  modelId: string | null | undefined,
): ModelFamily | undefined {
  if (!modelId) return families.find((family) => family.recommended);
  return families.find((family) => family.variants.some((variant) => variant.model.id === modelId));
}

export function preferredFamilyVariant(
  family: ModelFamily,
  currentModelId?: string | null,
): ModelVariant {
  return (
    family.variants.find((variant) => variant.model.id === currentModelId) ??
    family.variants.find((variant) => variant.model.recommended) ??
    family.variants.find((variant) => variant.model.recent) ??
    (family.variants[0] as ModelVariant)
  );
}

export function modelCostLabel(
  costTier: ComputerModel['costTier'],
  costSummary: string | undefined,
): string | null {
  if (costTier === 'free') return 'Free';
  if (costTier) return `${costTier[0]?.toUpperCase()}${costTier.slice(1)} cost`;
  if (costSummary) return 'Variable cost';
  return null;
}

export function costTierDots(costTier: ComputerModel['costTier']): number {
  switch (costTier) {
    case 'free':
      return 0;
    case 'low':
      return 1;
    case 'medium':
      return 2;
    case 'high':
      return 3;
    default:
      return 2;
  }
}

/**
 * De-dupe workspace display names: when N workspaces share a name, the later
 * ones get a " (2)", " (3)" suffix (stable input order).
 */
export function dedupeWorkspaceNames<T extends { name: string }>(workspaces: T[]): (T & {
  displayName: string;
})[] {
  const totals = new Map<string, number>();
  for (const workspace of workspaces) {
    totals.set(workspace.name, (totals.get(workspace.name) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  return workspaces.map((workspace) => {
    const count = seen.get(workspace.name) ?? 0;
    seen.set(workspace.name, count + 1);
    const needsSuffix = (totals.get(workspace.name) ?? 0) > 1 && count > 0;
    return { ...workspace, displayName: needsSuffix ? `${workspace.name} (${count + 1})` : workspace.name };
  });
}
