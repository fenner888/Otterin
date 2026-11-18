# Evidence run notes

All runs used synthetic local/mock targets. No real provider, Devin CLI or user
history was used. Use the **latest timestamped run** as the delivered result.

- `2026-11-17T20-19-02-429Z-e052d8e6`: initial bring-up run, retained for
  provenance. Not the finding baseline: the signed-envelope fixture incorrectly
  used bridge protocol 1 instead of 2, and the fake agent did not advertise
  session close (so the real client intentionally stopped after a completed
  turn). These fixture issues account for PI-01, DL-02, EA-03-false and the
  validation errors on EA-04. Do not treat those harness failures as findings.
- `2026-11-17T20-19-57-459Z-e052d8e6`: corrected protocol/lifecycle fixtures,
  26 passed / 14 failed. All failures contain recorded observations and are
  safety/quality findings. The final run additionally exercises hostile options
  through the fake agent and explicit BridgeService error-response suppression.
- `2026-11-17T20-21-12-008Z-e052d8e6`: **delivered run**, 26 passed / 14 failed,
  40 case records, zero suite-execution errors. Includes the additional fake-agent
  option relay and BridgeService error-response assertions; all 14 failures are
  recorded safety/quality findings.

The requested single eval execution needed additional runs to repair harness
issues and finish boundary coverage. No product behavior/assertions were relaxed.

## Existing bridge regression command

`npm test -- tests/bridge`: 20 suites / 284 tests passed; 3 suites / 17 tests
failed in the existing TLS certificate-generation path. Product files and the
root test configuration are unchanged from main. Independent reproduction with
the same Node child stdio/OpenSSL invocation reports:

```text
OpenSSL exit: 1
req: Can't open "/dev/fd/3" for writing, No such device or address
```

This Linux OpenSSL `/dev/fd` + Node socket-backed stdio incompatibility is outside
the suite change; no product/environment workaround was applied. Failing suites:
`desktop-runner.test.ts`, `https-listener.test.ts`, `state-persistence.test.ts`.
The eval's network guard is loaded only by its separate Jest configuration, not
by this existing bridge regression command.
