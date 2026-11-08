/**
 * Interaction dock — sits above the composer. Priority: elicitation >
 * permission > terminal question; an answered-summary row replaces the card
 * until the next interaction arrives. Silent retirement (a poll returning
 * null) means another paired device answered first — expected, not an error.
 */
import type { ReactNode } from 'react';

import type {
  ElicitationAnswer,
  ElicitationInteraction,
  PermissionDecision,
  SessionPermission,
  TerminalQuestion,
} from '../types';
import { ElicitationCard } from './ElicitationCard';
import { PermissionCard } from './PermissionCard';
import { TerminalQuestionCard } from './TerminalQuestionCard';

export function InteractionAnsweredRow({ sentence }: { sentence: string }) {
  return (
    <div className="flex items-center rounded-card border border-border bg-surface1 px-4 py-3">
      <span className="mr-2 h-2 w-2 shrink-0 rounded-dot bg-brand" />
      <span className="flex-1 text-[12px] text-textMid">{sentence}</span>
    </div>
  );
}

export function InteractionDock({
  answeredSummary,
  elicitation,
  permission,
  terminalQuestions,
  responding,
  respondError,
  computerName,
  onElicitation,
  onPermission,
}: {
  answeredSummary: string | null;
  elicitation: ElicitationInteraction | null;
  permission: SessionPermission | null;
  terminalQuestions: TerminalQuestion[];
  responding: boolean;
  respondError: string | null;
  computerName: string;
  onElicitation(answer: ElicitationAnswer): void;
  onPermission(decision: PermissionDecision): void;
}) {
  let content: ReactNode = null;
  if (answeredSummary) {
    content = <InteractionAnsweredRow sentence={answeredSummary} />;
  } else if (elicitation) {
    content = (
      <ElicitationCard
        interaction={elicitation}
        pending={responding}
        error={respondError ?? undefined}
        onRespond={onElicitation}
      />
    );
  } else if (permission) {
    content = (
      <PermissionCard
        permission={permission}
        pending={responding}
        error={respondError ?? undefined}
        onRespond={onPermission}
      />
    );
  } else if (terminalQuestions.length > 0) {
    content = terminalQuestions.map((question, index) => (
      <div className="mb-2 last:mb-0" key={`${index}-${question.question}`}>
        <TerminalQuestionCard question={question} computerName={computerName} />
      </div>
    ));
  }
  if (!content) return null;
  return <div className="max-h-[45vh] overflow-y-auto px-4 pb-2">{content}</div>;
}
