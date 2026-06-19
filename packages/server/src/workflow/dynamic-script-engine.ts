import {
  getQuickJS,
  shouldInterruptAfterDeadline,
  type QuickJSContext,
  type QuickJSHandle,
} from 'quickjs-emscripten';

export type DynamicHostCallKind =
  | 'phase_start'
  | 'phase_complete'
  | 'agent'
  | 'checkpoint'
  | 'apply'
  | 'log';

export interface DynamicHostCall {
  kind: DynamicHostCallKind;
  key: string;
  parentKey?: string;
  input: Record<string, unknown>;
}

export interface DynamicScriptHost {
  call(request: DynamicHostCall): Promise<unknown>;
}

export interface DynamicScriptOptions {
  timeoutMs?: number;
  memoryLimitMb?: number;
  signal?: AbortSignal;
}

const DSL_BOOTSTRAP = `
(() => {
  "use strict";
  const phaseStack = [];
  let workflowSeen = false;
  let workflowPromise = null;
  let phaseCount = 0;
  let agentCount = 0;

  const assertId = (id, kind) => {
    if (typeof id !== "string" || id.trim().length === 0) {
      throw new Error(kind + " requires a stable non-empty id");
    }
    return id;
  };

  const parentKey = () => phaseStack.length
    ? phaseStack[phaseStack.length - 1]
    : undefined;

  globalThis.workflow = async (name, callback) => {
    if (workflowSeen) throw new Error("Only one workflow() call is allowed");
    if (typeof name !== "string" || !name.trim()) {
      throw new Error("workflow() requires a name");
    }
    if (typeof callback !== "function") {
      throw new Error("workflow() requires an async callback");
    }
    workflowSeen = true;
    workflowPromise = callback();
    return await workflowPromise;
  };

  globalThis.phase = async (id, callback) => {
    assertId(id, "phase()");
    phaseCount++;
    if (phaseCount > 50) throw new Error("Maximum 50 phases allowed");
    if (typeof callback !== "function") {
      throw new Error("phase() requires an async callback");
    }
    const parent = parentKey();
    await __hostCall("phase_start", {
      key: id,
      parentKey: parent,
      input: { id }
    });
    phaseStack.push(id);
    try {
      const result = await callback();
      await __hostCall("phase_complete", {
        key: id,
        parentKey: parent,
        input: { id }
      });
      return result;
    } finally {
      phaseStack.pop();
    }
  };

  globalThis.agent = async (id, options) => {
    assertId(id, "agent()");
    agentCount++;
    if (agentCount > 1000) throw new Error("Maximum 1000 agent calls allowed");
    if (!options || typeof options !== "object") {
      throw new Error("agent() requires an options object");
    }
    if (typeof options.prompt !== "string" || !options.prompt.trim()) {
      throw new Error("agent() requires options.prompt");
    }
    return await __hostCall("agent", {
      key: id,
      parentKey: parentKey(),
      input: options
    });
  };

  globalThis.checkpoint = async (id, value) => {
    assertId(id, "checkpoint()");
    return await __hostCall("checkpoint", {
      key: id,
      parentKey: parentKey(),
      input: { value }
    });
  };

  globalThis.apply = async (id, result) => {
    assertId(id, "apply()");
    return await __hostCall("apply", {
      key: id,
      parentKey: parentKey(),
      input: { result }
    });
  };

  globalThis.log = async (level, message, data) => {
    return await __hostCall("log", {
      key: "log:" + String(level) + ":" + String(message),
      parentKey: parentKey(),
      input: { level, message, data }
    });
  };

  globalThis.parallel = async (items, callback, options = {}) => {
    if (!Array.isArray(items)) throw new Error("parallel() requires an array");
    if (typeof callback !== "function") {
      throw new Error("parallel() requires a callback");
    }
    const concurrency = options.concurrency === undefined
      ? 16
      : Number(options.concurrency);
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) {
      throw new Error("parallel() concurrency must be between 1 and 16");
    }

    const results = new Array(items.length);
    let cursor = 0;
    const worker = async () => {
      while (true) {
        const index = cursor++;
        if (index >= items.length) return;
        results[index] = await callback(items[index], index);
      }
    };
    const workers = Array.from(
      { length: Math.min(concurrency, items.length) },
      () => worker()
    );
    await Promise.all(workers);
    return results;
  };

  globalThis.__assertWorkflowSeen = async () => {
    if (!workflowSeen) throw new Error("Script must call workflow()");
    return await workflowPromise;
  };
})();
`;

function toQuickJSValue(vm: QuickJSContext, value: unknown): QuickJSHandle {
  const json = JSON.stringify(value === undefined ? null : value);
  const result = vm.evalCode(`JSON.parse(${JSON.stringify(json)})`);
  return vm.unwrapResult(result);
}

function describeQuickJSError(vm: QuickJSContext, handle: QuickJSHandle): string {
  const dumped = vm.dump(handle) as unknown;
  if (dumped && typeof dumped === 'object') {
    const error = dumped as { name?: string; message?: string; stack?: string };
    if (error.message && error.stack) {
      return `${error.message}\n${error.stack}`;
    }
    return error.message || error.stack || JSON.stringify(error);
  }
  return String(dumped);
}

export async function validateDynamicScript(
  script: string,
  options: Pick<DynamicScriptOptions, 'timeoutMs' | 'memoryLimitMb'> = {},
): Promise<{ valid: true } | { valid: false; error: string }> {
  const QuickJS = await getQuickJS();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit((options.memoryLimitMb ?? 128) * 1024 * 1024);
  runtime.setMaxStackSize(1024 * 1024);
  runtime.setInterruptHandler(
    shouldInterruptAfterDeadline(Date.now() + (options.timeoutMs ?? 2_000)),
  );
  const vm = runtime.newContext();
  try {
    const bootstrap = vm.evalCode(DSL_BOOTSTRAP);
    if (bootstrap.error) {
      const message = describeQuickJSError(vm, bootstrap.error);
      bootstrap.error.dispose();
      return { valid: false, error: message };
    }
    bootstrap.value.dispose();

    // Validation deliberately does not invoke workflow callbacks. Runtime
    // behavior is validated when the durable executor runs the script.
    const noop = vm.newFunction('__hostCall', () => vm.undefined);
    vm.setProp(vm.global, '__hostCall', noop);
    noop.dispose();
    const workflowStub = vm.newFunction('workflow', (nameHandle) => {
      const name = vm.dump(nameHandle);
      if (typeof name !== 'string' || name.trim().length === 0) {
        throw new Error('workflow() requires a name');
      }
      return vm.undefined;
    });
    vm.setProp(vm.global, 'workflow', workflowStub);
    workflowStub.dispose();

    const result = vm.evalCode(script, 'workflow.js');
    if (result.error) {
      const message = describeQuickJSError(vm, result.error);
      result.error.dispose();
      return { valid: false, error: message };
    }
    result.value.dispose();
    if (!/\bworkflow\s*\(/.test(script)) {
      return { valid: false, error: 'Script must call workflow()' };
    }
    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    vm.dispose();
    runtime.dispose();
  }
}

export async function executeDynamicScript(
  script: string,
  host: DynamicScriptHost,
  options: DynamicScriptOptions = {},
): Promise<unknown> {
  const QuickJS = await getQuickJS();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit((options.memoryLimitMb ?? 128) * 1024 * 1024);
  runtime.setMaxStackSize(1024 * 1024);
  const deadline = Date.now() + (options.timeoutMs ?? 30 * 60_000);
  runtime.setInterruptHandler(
    () => options.signal?.aborted === true || Date.now() > deadline,
  );
  const vm = runtime.newContext();

  try {
    const hostCall = vm.newFunction(
      '__hostCall',
      (kindHandle, requestHandle) => {
        const kind = vm.getString(kindHandle) as DynamicHostCallKind;
        const raw = vm.dump(requestHandle) as {
          key?: unknown;
          parentKey?: unknown;
          input?: unknown;
        };
        const deferred = vm.newPromise();
        const request: DynamicHostCall = {
          kind,
          key: String(raw.key ?? ''),
          parentKey:
            typeof raw.parentKey === 'string' ? raw.parentKey : undefined,
          input:
            raw.input && typeof raw.input === 'object'
              ? (raw.input as Record<string, unknown>)
              : {},
        };

        void host.call(request).then(
          (value) => {
            const handle = toQuickJSValue(vm, value);
            deferred.resolve(handle);
            handle.dispose();
          },
          (error) => {
            const message =
              error instanceof Error ? error.message : String(error);
            const handle = vm.newError(message);
            deferred.reject(handle);
            handle.dispose();
          },
        );
        deferred.settled.then(() => {
          runtime.executePendingJobs();
        });
        return deferred.handle;
      },
    );
    vm.setProp(vm.global, '__hostCall', hostCall);
    hostCall.dispose();

    const bootstrap = vm.evalCode(DSL_BOOTSTRAP, 'dynflow-dsl.js');
    if (bootstrap.error) {
      const message = describeQuickJSError(vm, bootstrap.error);
      bootstrap.error.dispose();
      throw new Error(message);
    }
    bootstrap.value.dispose();

    const evaluated = vm.evalCode(
      `(async () => {
        ${script}
        await __assertWorkflowSeen();
      })()`,
      'workflow.js',
    );
    if (evaluated.error) {
      const message = describeQuickJSError(vm, evaluated.error);
      evaluated.error.dispose();
      throw new Error(message);
    }

    const promiseHandle = evaluated.value;
    const nativeResult = vm.resolvePromise(promiseHandle);
    runtime.executePendingJobs();
    const resolved = await nativeResult;
    promiseHandle.dispose();
    if (resolved.error) {
      const message = describeQuickJSError(vm, resolved.error);
      resolved.error.dispose();
      throw new Error(message);
    }
    const output = vm.dump(resolved.value);
    resolved.value.dispose();
    return output;
  } finally {
    vm.dispose();
    runtime.dispose();
  }
}
