import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['**/*.test.ts', '**/*.test.js'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'lcov', 'json'],
      reportsDirectory: './coverage',
      // Coverage is measured over EVERY source module, not just worker.ts. The include used to
      // name worker.ts alone, so each extraction (http.ts, admin-auth.ts, kv-store.ts,
      // installer-scripts.ts, pbl/*, and S280's agent-routes.ts) silently left the gate's
      // denominator: the report only ever covered the file that remained. Widening it in S280
      // restored 17% of the code to measurement and the existing floors still held — the numbers
      // above worker.ts went UP (90.54/85.87/95.45/92.94) precisely because the moved code was
      // no longer counted, while the honest whole-tree figure was 86.36/82.99/95.04/88.52.
      include: ['*.ts', 'pbl/**/*.ts'],
      exclude: ['*.test.ts', 'coverage/**'],
      // Coverage gate. Measured 2026-10-28 on vitest 4.1.12 (worker.ts only):
      //   83.84 stmts / 77.36 branches / 88.00 funcs / 85.50 lines
      // Re-baselined when the coverage provider moved from vitest 3.2 to 4.1:
      // v8 instrumentation counts differently on unchanged code (the 2026-10-27
      // numbers were 85.48/81.67/92.59/85.48). Floors stay ~2 points under the
      // measurement; raise on real improvement, never lower to pass a build.
      //
      // Re-measured 2026-11-18 over the whole module set: 86.36 / 82.99 / 95.04 / 88.52.
      // Every floor still passes, so none was lowered — the widening was free. Two modules are
      // genuinely thin and are named rather than hidden by the total: pbl/routes/signingKey.ts
      // (0%) and pbl/routes/firmware.ts (16.66%), both exercised only through the `/v1` URL
      // download path that the unit suite never takes.
      thresholds: {
        statements: 82,
        branches: 75,
        functions: 86,
        lines: 83,
      },
    },
  },
  esbuild: {
    target: 'es2021',
  },
});
