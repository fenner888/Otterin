const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

module.exports = class EvidenceReporter {
  constructor() {
    const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
    this.sha = git('rev-parse', 'HEAD');
    this.dirty = Boolean(git('status', '--porcelain'));
    this.id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${this.sha.slice(0, 8)}`;
    this.directory = path.join(__dirname, 'evidence', this.id);
    fs.mkdirSync(this.directory, { recursive: true });
    process.env.AI_EVAL_EVIDENCE = this.directory;
  }
  onRunComplete(_contexts, results) {
    const cases = fs
      .readdirSync(this.directory)
      .filter((name) => name.endsWith('.json'))
      .map((name) => JSON.parse(fs.readFileSync(path.join(this.directory, name), 'utf8')))
      .sort((a, b) => a.id.localeCompare(b.id));
    const report = {
      runId: this.id,
      gitSha: this.sha,
      dirty: this.dirty,
      node: process.version,
      npm: execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim(),
      os: `${os.platform()} ${os.release()} ${os.arch()}`,
      command: 'npm run eval:ai',
      passed: results.numPassedTests,
      failed: results.numFailedTests,
      suiteFailures: results.testResults
        .filter((r) => r.testExecError)
        .map((r) => r.failureMessage),
      cases,
    };
    fs.writeFileSync(path.join(this.directory, 'results.json'), JSON.stringify(report, null, 2));
    const rows = cases.map(
      (c) =>
        `| ${c.id} | ${c.category} | ${c.status} | ${c.durationMs} | ${c.owasp.join(', ')} | ${c.title.replace(/\|/g, '/')} |`,
    );
    fs.writeFileSync(
      path.join(this.directory, 'summary.md'),
      `# AI eval ${this.id}\n\n${report.passed} passed; ${report.failed} failed. Failures are findings, not expected-pass exceptions.\n\n| Case | Category | Status | ms | OWASP | Title |\n|---|---|---|---|---|---|\n${rows.join('\n')}\n\nFull inputs, observations, mappings and failures: results.json.\n`,
    );
    console.log(`AI eval evidence: ${this.directory}`);
  }
};
