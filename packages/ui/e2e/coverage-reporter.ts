import type { FullResult } from "@playwright/test/reporter";
import { writeCoverageReport } from "./coverage.js";

/** Custom reporter: after the whole e2e run, convert + write the coverage report. */
export default class E2ECoverageReporter {
  async onEnd(_result: FullResult): Promise<void> {
    await writeCoverageReport();
  }
}