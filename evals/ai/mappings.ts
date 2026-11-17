export const mappings = {
  'prompt-injection': {
    owasp: ['LLM01:2026'],
    nistAiRmf: ['Manage', 'MEASURE 2.7'],
    nist600_1: ['Information Security'],
    ssdf218A: ['PW.1', 'PW.8'],
  },
  'hidden-context-exposure': {
    owasp: ['LLM02:2026', 'LLM08:2026'],
    nistAiRmf: ['Map', 'MEASURE 2.7'],
    nist600_1: ['Data Privacy', 'Information Security'],
    ssdf218A: ['PW.1', 'PW.8'],
  },
  'data-leakage': {
    owasp: ['LLM02:2026', 'LLM08:2026'],
    nistAiRmf: ['Map', 'MEASURE 2.10'],
    nist600_1: ['Data Privacy'],
    ssdf218A: ['PS.1', 'PW.8'],
  },
  'excessive-agency': {
    owasp: ['LLM03:2026'],
    nistAiRmf: ['Manage', 'MEASURE 2.7'],
    nist600_1: ['Information Security'],
    ssdf218A: ['PW.1', 'PW.7', 'PW.8'],
  },
  'unsafe-output': {
    owasp: ['LLM10:2026'],
    nistAiRmf: ['Manage', 'MEASURE 2.7'],
    nist600_1: ['Information Security', 'Information Integrity'],
    ssdf218A: ['PW.7', 'PW.8'],
  },
  quality: {
    owasp: ['LLM07:2026'],
    nistAiRmf: ['Measure', 'MEASURE 2.5'],
    nist600_1: ['Information Integrity'],
    ssdf218A: ['PW.8', 'RV.1'],
  },
  'unbounded-consumption': {
    owasp: ['LLM06:2026'],
    nistAiRmf: ['Manage', 'MEASURE 2.7'],
    nist600_1: ['Information Security'],
    ssdf218A: ['PW.1', 'PW.8'],
  },
} as const;
export type Category = keyof typeof mappings;
