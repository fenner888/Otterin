/**
 * Elicitation card — all field types (text / single_select / multi_select /
 * number / integer / boolean), allowOther, required + min/max validation,
 * Submit / Decline / Cancel. Port of ComputerElicitationCard.
 */
import { useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';

import type { ElicitationAnswer, ElicitationInteraction, ElicitationValue } from '../types';

type DraftValue = string | boolean | string[];

function initialAnswers(interaction: ElicitationInteraction): Record<string, DraftValue> {
  return Object.fromEntries(
    interaction.fields.map((field) => {
      if (Array.isArray(field.defaultValue)) return [field.key, [...field.defaultValue]];
      if (typeof field.defaultValue === 'boolean') return [field.key, field.defaultValue];
      if (field.defaultValue !== undefined) return [field.key, String(field.defaultValue)];
      if (field.type === 'multi_select') return [field.key, []];
      return [field.key, ''];
    }),
  );
}

function answerContent(
  interaction: ElicitationInteraction,
  answers: Record<string, DraftValue>,
  otherAnswers: Record<string, string>,
): Record<string, ElicitationValue> | null {
  const content: Record<string, ElicitationValue> = {};
  for (const field of interaction.fields) {
    const otherAnswer = otherAnswers[field.key]?.trim();
    const answer =
      field.type === 'single_select' && field.allowOther === true && otherAnswer
        ? (otherAnswers[field.key] ?? '')
        : answers[field.key];
    if (field.type === 'boolean') {
      if (typeof answer !== 'boolean') {
        if (field.required) return null;
        continue;
      }
      content[field.key] = answer;
      continue;
    }
    if (field.type === 'multi_select') {
      const selections = Array.isArray(answer) ? answer : [];
      if (field.required && selections.length === 0) return null;
      if (field.minItems !== undefined && selections.length < field.minItems) return null;
      if (field.maxItems !== undefined && selections.length > field.maxItems) return null;
      if (selections.length > 0 || field.required) content[field.key] = selections;
      continue;
    }
    const text = typeof answer === 'string' ? answer.trim() : '';
    if (!text) {
      if (field.required) return null;
      continue;
    }
    if (field.minLength !== undefined && text.length < field.minLength) return null;
    if (field.maxLength !== undefined && text.length > field.maxLength) return null;
    if (field.type === 'number' || field.type === 'integer') {
      const numeric = Number(text);
      if (!Number.isFinite(numeric) || (field.type === 'integer' && !Number.isInteger(numeric))) {
        return null;
      }
      if (field.minimum !== undefined && numeric < field.minimum) return null;
      if (field.maximum !== undefined && numeric > field.maximum) return null;
      content[field.key] = numeric;
    } else {
      content[field.key] = text;
    }
  }
  return content;
}

function OptionChip({
  label,
  selected,
  disabled,
  onSelect,
}: {
  label: string;
  selected: boolean;
  disabled: boolean;
  onSelect(): void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onSelect}
      role="radio"
      aria-checked={selected}
      className={clsx(
        'min-h-9 rounded-chip border px-4 text-[13px]',
        selected ? 'border-brand bg-tintPrimary text-brandText' : 'border-border bg-surface2 text-textMid hover:border-borderStrong',
        disabled && 'opacity-60',
      )}
    >
      {label}
    </button>
  );
}

export function ElicitationCard({
  interaction,
  pending,
  error,
  onRespond,
}: {
  interaction: ElicitationInteraction;
  pending: boolean;
  error?: string;
  onRespond(answer: ElicitationAnswer): void;
}) {
  const [answers, setAnswers] = useState<Record<string, DraftValue>>(() =>
    initialAnswers(interaction),
  );
  const [otherAnswers, setOtherAnswers] = useState<Record<string, string>>({});
  const content = useMemo(
    () => answerContent(interaction, answers, otherAnswers),
    [answers, interaction, otherAnswers],
  );

  useEffect(() => {
    setAnswers(initialAnswers(interaction));
    setOtherAnswers({});
  }, [interaction]);

  return (
    <div className="rounded-card border border-brand bg-surface1 px-4 py-4">
      <div className="text-[12px] font-medium text-brandText">Devin needs your input</div>
      <div className="mt-1 text-[16px] font-medium text-textHi">
        {interaction.title ?? interaction.message}
      </div>
      {interaction.title && (
        <div className="mt-2 text-[13px] leading-5 text-textMid selectable">{interaction.message}</div>
      )}
      {interaction.description && (
        <div className="mt-1 text-[12px] leading-5 text-textMid selectable">{interaction.description}</div>
      )}

      {interaction.fields.map((field) => {
        const value = answers[field.key];
        const options = field.options ?? [];
        return (
          <div className="mt-4" key={field.key}>
            <div className="text-[13px] font-medium text-textHi">
              {field.title}
              {field.required ? ' *' : ''}
            </div>
            {field.description && (
              <div className="mt-1 text-[12px] text-textLow">{field.description}</div>
            )}
            {field.type === 'single_select' || field.type === 'boolean' ? (
              <>
                <div className="mt-2 flex flex-wrap gap-2">
                  {(field.type === 'boolean'
                    ? [
                        { value: 'true', label: 'Yes' },
                        { value: 'false', label: 'No' },
                      ]
                    : options
                  ).map((option) => {
                    const selected =
                      field.type === 'boolean'
                        ? value === (option.value === 'true')
                        : value === option.value;
                    return (
                      <OptionChip
                        key={option.value}
                        label={option.label}
                        selected={selected}
                        disabled={pending}
                        onSelect={() => {
                          setOtherAnswers((current) => ({ ...current, [field.key]: '' }));
                          setAnswers((current) => ({
                            ...current,
                            [field.key]:
                              field.type === 'boolean' ? option.value === 'true' : option.value,
                          }));
                        }}
                      />
                    );
                  })}
                </div>
                {field.type === 'single_select' && field.allowOther === true && (
                  <input
                    className="mt-2 min-h-9 w-full rounded-input border border-border bg-surface2 px-3 py-2 text-[14px] text-textHi placeholder:text-textLow"
                    value={otherAnswers[field.key] ?? ''}
                    onChange={(event) => {
                      setOtherAnswers((current) => ({ ...current, [field.key]: event.target.value }));
                      setAnswers((current) => ({ ...current, [field.key]: '' }));
                    }}
                    disabled={pending}
                    maxLength={field.maxLength ?? 2_000}
                    placeholder="Other…"
                    aria-label={`Other answer: ${field.title}`}
                  />
                )}
              </>
            ) : field.type === 'multi_select' ? (
              <div className="mt-2 flex flex-wrap gap-2">
                {options.map((option) => {
                  const selected = Array.isArray(value) && value.includes(option.value);
                  return (
                    <button
                      key={option.value}
                      type="button"
                      role="checkbox"
                      aria-checked={selected}
                      disabled={pending}
                      className={clsx(
                        'min-h-9 rounded-chip border px-4 text-[13px]',
                        selected
                          ? 'border-brand bg-tintPrimary text-brandText'
                          : 'border-border bg-surface2 text-textMid hover:border-borderStrong',
                        pending && 'opacity-60',
                      )}
                      onClick={() =>
                        setAnswers((current) => {
                          const existing = Array.isArray(current[field.key])
                            ? (current[field.key] as string[])
                            : [];
                          return {
                            ...current,
                            [field.key]: selected
                              ? existing.filter((item) => item !== option.value)
                              : [...existing, option.value],
                          };
                        })
                      }
                    >
                      {option.label}
                    </button>
                  );
                })}
              </div>
            ) : (
              <input
                className="mt-2 min-h-9 w-full rounded-input border border-border bg-surface2 px-3 py-2 text-[14px] text-textHi placeholder:text-textLow"
                value={typeof value === 'string' ? value : ''}
                onChange={(event) =>
                  setAnswers((current) => ({ ...current, [field.key]: event.target.value }))
                }
                type={field.type === 'number' || field.type === 'integer' ? 'number' : 'text'}
                disabled={pending}
                placeholder={field.required ? 'Required' : 'Optional'}
                aria-label={field.title}
              />
            )}
          </div>
        );
      })}

      {error && <div className="mt-3 text-[12px] text-failed">{error}</div>}
      {!content && (
        <div className="mt-3 text-[12px] text-textLow">
          Complete the required fields before answering.
        </div>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          className="min-h-9 rounded-chip border border-border px-4 text-[13px] text-textMid hover:bg-tintSecondary"
          onClick={() => onRespond({ interactionId: interaction.id, action: 'cancel' })}
          disabled={pending}
        >
          Cancel
        </button>
        <button
          type="button"
          className="min-h-9 rounded-chip border border-border px-4 text-[13px] text-textMid hover:bg-tintSecondary"
          onClick={() => onRespond({ interactionId: interaction.id, action: 'decline' })}
          disabled={pending}
        >
          Decline
        </button>
        <button
          type="button"
          className={clsx(
            'min-h-9 min-w-24 items-center justify-center rounded-chip px-4 text-[13px] font-medium',
            content && !pending ? 'bg-brand text-textAlwaysWhite' : 'bg-tintSecondary text-textLow',
          )}
          onClick={() =>
            content && onRespond({ interactionId: interaction.id, action: 'accept', content })
          }
          disabled={!content || pending}
        >
          {pending ? 'Sending…' : 'Submit'}
        </button>
      </div>
    </div>
  );
}
