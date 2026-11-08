/**
 * Model picker — two-level popover: families (Recommended / Recent / All
 * Models, cost tiers, badges, search) then a variant list for the chosen
 * family. `catalogSource:'recent'` surfaces the staleness note + refresh
 * button. Port of ComputerModelPickerSheets.
 */
import { useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';

import {
  costTierDots,
  familyForModelId,
  groupComputerModels,
  modelCostLabel,
  preferredFamilyVariant,
  type ComputerModel,
  type ModelFamily,
} from '../models';
import { Icon } from './Icon';
import { Popover } from './Popover';

const COST_DOT_CLASSES = ['bg-finished', 'bg-chartAmber', 'bg-blocked'] as const;

function CostIndicator({ model }: { model: ComputerModel }) {
  const label = modelCostLabel(model.costTier, model.costSummary);
  if (!label) return null;
  if (model.costTier === 'free') {
    return <span className="text-[12px] font-medium text-brandText">Free</span>;
  }
  const active = model.costTier ? costTierDots(model.costTier) : 0;
  return (
    <span className="flex items-center" title={model.costSummary ?? label}>
      {COST_DOT_CLASSES.map((color, index) => (
        <span
          key={color}
          className={clsx(
            'ml-0.5 h-1.5 w-2 rounded-full',
            index < active ? color : 'bg-borderSubtle',
          )}
        />
      ))}
    </span>
  );
}

export function ModelPicker({
  open,
  onClose,
  anchor,
  models,
  selectedModelId,
  onSelect,
  catalogSource,
  onRefresh,
  refreshing,
  refreshError,
}: {
  open: boolean;
  onClose(): void;
  anchor: HTMLElement | null;
  models: ComputerModel[];
  selectedModelId: string | null;
  onSelect(modelId: string): void;
  catalogSource?: 'live' | 'recent';
  onRefresh?: () => void;
  refreshing?: boolean;
  refreshError?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [familyFocus, setFamilyFocus] = useState<string | null>(null);
  const families = useMemo(() => groupComputerModels(models), [models]);
  const selectedFamily = familyForModelId(families, selectedModelId);
  const recommended = families.find((family) => family.recommended);
  const recent = families.filter((family) => family.recent && family.key !== recommended?.key);
  const others = families.filter((family) => !family.recent && family.key !== recommended?.key);
  const normalizedQuery = query.trim().toLowerCase();
  const results = normalizedQuery
    ? families.filter(
        (family) =>
          family.name.toLowerCase().includes(normalizedQuery) ||
          family.description?.toLowerCase().includes(normalizedQuery) ||
          family.variants.some(
            (variant) =>
              variant.label.toLowerCase().includes(normalizedQuery) ||
              variant.model.name.toLowerCase().includes(normalizedQuery),
          ),
      )
    : [];
  const focused = familyFocus ? families.find((family) => family.key === familyFocus) : null;

  useEffect(() => {
    if (open) {
      setQuery('');
      setFamilyFocus(null);
    }
  }, [open]);

  function familyRow(family: ModelFamily) {
    const selected = family.key === selectedFamily?.key;
    const presented = preferredFamilyVariant(family, selectedModelId).model;
    const badge =
      family.badge === 'free_promo' ? 'Free promo' : family.badge === 'new' ? 'New' : null;
    const costLabel = modelCostLabel(presented.costTier, presented.costSummary);
    return (
      <button
        key={family.key}
        type="button"
        className={clsx(
          'flex w-full items-center px-3 py-2.5 text-left hover:bg-tintSecondary',
          selected && 'bg-tintSecondary',
        )}
        onClick={() => {
          if (family.variants.length === 1) {
            onSelect(presented.id);
            onClose();
          } else {
            setFamilyFocus(family.key);
          }
        }}
      >
        <span className="min-w-0 flex-1">
          <span className="flex items-center">
            <span className="truncate text-[14px] text-textHi">{family.name}</span>
            {badge && (
              <span
                className={clsx(
                  'ml-2 rounded-chip px-2 py-0.5 text-[11px] font-medium',
                  family.badge === 'free_promo' ? 'bg-tintGreen text-finished' : 'bg-tintBlue text-brandText',
                )}
              >
                {badge}
              </span>
            )}
          </span>
          {(family.description || costLabel) && (
            <span className="mt-0.5 block truncate text-[12px] text-textLow">
              {family.description ?? costLabel}
            </span>
          )}
        </span>
        <span className="ml-2 shrink-0">
          <CostIndicator model={presented} />
        </span>
        <span className="ml-2 w-5 shrink-0 text-textHi">
          {selected ? (
            <Icon name="check" size={16} />
          ) : family.variants.length > 1 ? (
            <Icon name="chevron-right" size={14} className="text-textLow" />
          ) : null}
        </span>
      </button>
    );
  }

  return (
    <Popover open={open} onClose={onClose} anchor={anchor} width={360} placement="above">
      <div className="flex max-h-[55vh] flex-col">
        <div className="flex items-center justify-between px-4 pb-2 pt-3">
          {focused ? (
            <button
              type="button"
              className="flex items-center text-[13px] text-textMid hover:text-textHi"
              onClick={() => setFamilyFocus(null)}
            >
              <Icon name="chevron-left" size={14} className="mr-1" />
              {focused.name}
            </button>
          ) : (
            <span className="text-[13px] font-medium text-textLow">Model</span>
          )}
          <span className="flex items-center">
            {onRefresh && (
              <button
                type="button"
                className="mr-1 rounded-full p-1.5 text-brandText hover:bg-tintSecondary disabled:opacity-50"
                onClick={onRefresh}
                disabled={refreshing}
                title="Refresh models from Devin"
              >
                <Icon name="refresh" size={15} className={refreshing ? 'animate-spin' : ''} />
              </button>
            )}
            <button
              type="button"
              className="rounded-full p-1.5 text-textLow hover:bg-tintSecondary"
              onClick={onClose}
              aria-label="Close model picker"
            >
              <Icon name="close" size={15} />
            </button>
          </span>
        </div>

        {focused ? (
          <div className="min-h-0 flex-1 overflow-y-auto pb-2">
            <div className="px-4 pb-1 text-[12px] text-textLow">Reasoning &amp; speed</div>
            {focused.variants.map((variant) => {
              const selected = variant.model.id === selectedModelId;
              const costLabel = modelCostLabel(variant.model.costTier, variant.model.costSummary);
              return (
                <button
                  key={variant.model.id}
                  type="button"
                  className="flex w-full items-center px-4 py-2.5 text-left hover:bg-tintSecondary"
                  onClick={() => {
                    onSelect(variant.model.id);
                    onClose();
                  }}
                >
                  <span className="w-6 shrink-0 text-textHi">
                    {selected && <Icon name="check" size={16} />}
                  </span>
                  <span className="flex-1 text-[14px] text-textHi">{variant.label}</span>
                  {costLabel && (
                    <span className="ml-2 shrink-0">
                      <CostIndicator model={variant.model} />
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        ) : (
          <>
            {models.length > 6 && (
              <div className="mx-4 mb-2 flex items-center rounded-input border border-borderSubtle bg-surface1 px-3">
                <Icon name="search" size={14} className="text-textLow" />
                <input
                  className="ml-2 min-h-9 flex-1 bg-transparent text-[14px] text-textHi placeholder:text-textLow focus:outline-none"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search models"
                  autoFocus
                />
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-y-auto pb-2">
              {normalizedQuery ? (
                <>
                  <div className="px-4 pb-1 pt-1 text-[12px] font-medium text-textLow">Results</div>
                  {results.length > 0 ? (
                    results.map(familyRow)
                  ) : (
                    <div className="px-4 py-5 text-[13px] text-textLow">No matching models</div>
                  )}
                </>
              ) : (
                <>
                  {recommended && (
                    <>
                      <div className="px-4 pb-1 pt-1 text-[12px] font-medium text-textLow">
                        Recommended
                      </div>
                      {familyRow(recommended)}
                    </>
                  )}
                  {recent.length > 0 && (
                    <>
                      <div className="mx-4 my-2 h-px bg-borderSubtle" />
                      <div className="px-4 pb-1 pt-1 text-[12px] font-medium text-textLow">
                        Recent
                      </div>
                      {recent.map(familyRow)}
                    </>
                  )}
                  {others.length > 0 && (
                    <>
                      <div className="mx-4 my-2 h-px bg-borderSubtle" />
                      <div className="px-4 pb-1 pt-1 text-[12px] font-medium text-textLow">
                        All Models
                      </div>
                      {others.map(familyRow)}
                    </>
                  )}
                  {catalogSource === 'recent' && (
                    <div className="px-4 pb-2 pt-3 text-[11px] leading-4 text-textLow">
                      Showing recent models. Refresh to load the full catalog from Devin.
                    </div>
                  )}
                  {refreshError && (
                    <div className="px-4 pb-2 pt-3 text-[11px] text-failed">
                      Couldn&apos;t refresh models. Your previous list is still available.
                    </div>
                  )}
                </>
              )}
            </div>
          </>
        )}
      </div>
    </Popover>
  );
}
