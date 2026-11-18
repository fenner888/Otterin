import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mappings, type Category } from './mappings';

function bounded(value: unknown): unknown {
  const serialized = JSON.stringify(value) ?? 'null';
  return serialized.length > 12000
    ? `${serialized.slice(0, 12000)} [truncated]`
    : JSON.parse(serialized);
}

export function evalCase(
  metadata: { id: string; category: Category; target: string; title: string },
  run: (ev: { record(input: unknown, observed: unknown): void }) => void | Promise<void>,
): void {
  test(`${metadata.id}: ${metadata.title}`, async () => {
    const records: Array<{ input: unknown; observed: unknown }> = [];
    const started = Date.now();
    let failure: string | undefined;
    try {
      await run({
        record: (input, observed) =>
          records.push({ input: bounded(input), observed: bounded(observed) }),
      });
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      const directory = process.env.AI_EVAL_EVIDENCE;
      if (!directory) throw new Error('Run with npm run eval:ai to enable evidence');
      writeFileSync(
        join(directory, `${metadata.id}.json`),
        JSON.stringify(
          {
            ...metadata,
            ...mappings[metadata.category],
            status: failure ? 'failed' : 'passed',
            durationMs: Date.now() - started,
            records,
            failureMessage: failure?.slice(0, 12000),
          },
          null,
          2,
        ),
      );
    }
  }, 15000);
}
