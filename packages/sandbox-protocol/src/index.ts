export interface SandboxJob {
  code: string;
  callbackDirectory: string;
  resultFile: string;
  callbackTimeoutMs: number;
  maxLogBytes: number;
}

export interface SandboxCallbackRequest {
  id: string;
  name: string;
  args: unknown;
}

export interface SandboxCallbackResponse {
  id: string;
  result?: unknown;
  error?: string;
}

export interface SandboxRunResult {
  result: unknown;
  error?: string;
  logs: string[];
}

export interface SandboxLimits {
  timeoutMs: number;
  callbackTimeoutMs: number;
  maxLogBytes: number;
  maxResultBytes: number;
  maxCallbacks: number;
  memory: string;
  cpus: string;
  pidsLimit: number;
}
