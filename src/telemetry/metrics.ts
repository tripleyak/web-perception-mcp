export interface MetricsSnapshot {
  steps_total: number;
  step_latency_ms_p50: number;
  step_latency_ms_p95: number;
  dropped_frames: number;
  action_failures: number;
  active_sessions: number;
}

export class MetricsCollector {
  private readonly stepLatencies: number[] = [];
  private readonly maxLatencySamples = 500;
  private droppedFrames = 0;
  private actionFailures = 0;
  private steps = 0;

  public recordStepLatency(ms: number): void {
    this.steps += 1;
    this.stepLatencies.push(Math.max(0, ms));
    if (this.stepLatencies.length > this.maxLatencySamples) {
      this.stepLatencies.shift();
    }
  }

  public recordFrameDrops(count: number): void {
    if (count > 0) {
      this.droppedFrames += count;
    }
  }

  public recordActionFailure(): void {
    this.actionFailures += 1;
  }

  public snapshot(activeSessions: number): MetricsSnapshot {
    const sorted = [...this.stepLatencies].sort((a, b) => a - b);
    const percentile = (p: number): number => {
      if (sorted.length === 0) {
        return 0;
      }
      const idx = Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100));
      return sorted[idx] ?? 0;
    };

    return {
      steps_total: this.steps,
      step_latency_ms_p50: percentile(50),
      step_latency_ms_p95: percentile(95),
      dropped_frames: this.droppedFrames,
      action_failures: this.actionFailures,
      active_sessions: activeSessions,
    };
  }
}
