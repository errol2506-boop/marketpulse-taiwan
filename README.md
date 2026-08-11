# Evidence Decision Guard

Evidence Decision Guard validates the Evidence Store slice used by the CB1.0 champion and V4R1.2 research shadow before any decision is generated. The CLI now runs the local Evidence Decision Pipeline by default: validate evidence, freeze the decision snapshot, build model input status, and emit dashboard-ready output.

It enforces the handoff rules:

- Only evidence with `AvailableAsOf <= cutoff` can enter the decision snapshot.
- Late evidence is excluded, but late arrival is not a PIT violation.
- CB1.0 requires complete FULL inputs or returns `NO_PRODUCTION`.
- V4R1.2 requires complete frozen inputs or returns `UNASSESSED`.
- Broker flow must keep six independent rows: BUY1-3 and SELL1-3.
- TEST evidence cannot enter production validation.
- Low-quality research-only evidence cannot feed CB1.0.

## Run

```powershell
node .\src\cli.js --input .\fixtures\complete-evidence.json --cutoff 2026-08-11T06:30:00+08:00
```

JSON report:

```powershell
node .\src\cli.js --input .\fixtures\complete-evidence.json --json
```

Validation-only mode:

```powershell
node .\src\cli.js --input .\fixtures\complete-evidence.json --mode validate
```

Write a pipeline artifact:

```powershell
node .\src\cli.js --input .\fixtures\complete-evidence.json --json --output .\reports\pipeline-result.json
```

Continue even when production is blocked:

```powershell
node .\src\cli.js --input .\runs\2026-08-11\evidence-live.json --continue-on-blocked --output .\runs\2026-08-11\pipeline-report.txt
```

In this mode the program exits successfully after producing a complete degraded report. `NO_PRODUCTION` still means CB1.0 must not generate an official action.

Cancel the cutoff and use the latest available evidence:

```powershell
node .\src\cli.js --input .\runs\2026-08-11\evidence-latest.json --time-policy LATEST --continue-on-blocked
```

`LATEST` mode includes evidence retrieved after the 06:30 cutoff. It is useful for exploratory analysis, not strict PIT production.

Produce BUY/HOLD/REDUCE with relaxed fallback policy:

```powershell
node .\src\cli.js --input .\runs\2026-08-11\evidence-three-layer.json --time-policy LATEST --decision-policy RELAXED --continue-on-blocked
```

This emits actions from `CB1.0_RELAXED_FALLBACK`. Strict frozen CB1.0 remains `NO_PRODUCTION` if required inputs are missing.

The process exits with:

- `0` when CB1.0 and V4R1.2 are both READY and PIT violations are zero.
- `1` when validation completes but production should be blocked.
- `2` when CLI usage or input parsing fails.

With `--continue-on-blocked`, exit code is `0` even when the dashboard says `NO_PRODUCTION`.

## Schedule

Daily scheduling is defined but disabled in:

```text
config/daily-schedule.json
```

It must stay disabled until live capture and all critical E2E gates pass.

## Input

Input can be `.json` or `.csv`.

JSON may be either an array of Evidence Store rows or:

```json
{
  "rows": []
}
```
