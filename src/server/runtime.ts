import { configIsValid } from "./config";
import { AdmissionController } from "./admission/limiter";
import { JobRegistry } from "./jobs/registry";
import { WorkerManager } from "./jobs/worker-manager";

type Runtime = {
  admission: AdmissionController;
  worker: WorkerManager;
  jobs: JobRegistry;
  shutdownStarted: boolean;
};

const key = Symbol.for("code-survivability.runtime");
const globalRuntime = globalThis as typeof globalThis & { [key]?: Runtime };

function createRuntime(): Runtime {
  const worker = new WorkerManager();
  const jobs = new JobRegistry(
    (id, login, signal, onProgress) =>
      worker.run(id, login, signal, onProgress),
    () => worker.getGeneration(),
  );
  return {
    admission: new AdmissionController(),
    worker,
    jobs,
    shutdownStarted: false,
  };
}

export const runtime = (globalRuntime[key] ??= createRuntime());

export function isReady(): boolean {
  return (
    configIsValid() && runtime.worker.isReady() && !runtime.shutdownStarted
  );
}

async function shutdown(): Promise<void> {
  if (runtime.shutdownStarted) return;
  runtime.shutdownStarted = true;
  await runtime.jobs.shutdown();
  await runtime.worker.stop();
}

if (import.meta.env.PROD) {
  process.once("SIGTERM", () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.once("SIGINT", () => {
    void shutdown().finally(() => process.exit(0));
  });
}
