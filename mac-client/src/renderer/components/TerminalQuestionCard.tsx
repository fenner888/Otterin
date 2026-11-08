/**
 * Terminal-question card — read-only. The question was asked by Devin's own
 * TUI on the host Mac; answering must happen there.
 */
import type { TerminalQuestion } from '../types';

export function TerminalQuestionCard({
  question,
  computerName,
}: {
  question: TerminalQuestion;
  computerName: string;
}) {
  return (
    <div className="rounded-card border border-border bg-surface1 px-4 py-4">
      <div className="text-[16px] font-medium text-textHi selectable">{question.question}</div>
      {question.header && (
        <div className="mt-2 inline-block rounded-chip bg-tintSecondary px-3 py-1 text-[11px] text-textMid">
          {question.header}
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {question.options.map((option) => (
          <span
            key={option}
            className="min-h-9 rounded-chip border border-border px-4 py-2 text-[13px] text-textMid opacity-60"
          >
            {option}
          </span>
        ))}
      </div>
      <div className="mt-3 text-[12px] text-textLow">Answer in Terminal on {computerName}</div>
    </div>
  );
}
