/** Deadline covers headers AND the consumed body; signals live on request-local clients. */
export async function providerFetch(url: string, init: RequestInit = {}, parent?: AbortSignal, timeoutMs = 15000): Promise<Response> {
  const controller = new AbortController();
  const signals = [parent, init.signal].filter((signal): signal is AbortSignal => !!signal);
  const abort = () => controller.abort(new DOMException("上游请求已取消或超时", "AbortError"));
  for (const signal of signals) {
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  }
  const timer = setTimeout(abort, timeoutMs);
  const dispose = () => { clearTimeout(timer); signals.forEach(signal => signal.removeEventListener("abort", abort)); };
  let response: Response;
  try { response = await fetch(url, { ...init, signal: controller.signal }); }
  catch (error) { dispose(); throw error; }
  if (!response.body) { dispose(); return response; }
  const reader = response.body.getReader();
  let bytes = 0;
  let finished = false;
  let output: ReadableStreamDefaultController<Uint8Array>;
  const bodyAbort = () => {
    if (finished) return;
    finished = true; dispose();
    output?.error(new DOMException("上游响应读取已取消或超时", "AbortError"));
    void reader.cancel().catch(() => {});
  };
  controller.signal.addEventListener("abort", bodyAbort, { once: true });
  const finish = () => { finished = true; controller.signal.removeEventListener("abort", bodyAbort); dispose(); };
  return new Response(new ReadableStream<Uint8Array>({
    start(stream) { output = stream; if (controller.signal.aborted) bodyAbort(); },
    async pull(stream) {
      try {
        const item = await reader.read();
        if (finished) return;
        if (item.done) { finish(); stream.close(); return; }
        bytes += item.value.byteLength;
        if (bytes > 5 * 1024 * 1024) {
          finish(); controller.abort(); void reader.cancel().catch(() => {});
          stream.error(new Error("上游响应超过 5MB 读取预算")); return;
        }
        stream.enqueue(item.value);
      } catch (error) { if (!finished) { finish(); stream.error(error); } }
    },
    async cancel() { finish(); controller.abort(); await reader.cancel(); },
  }), { status: response.status, statusText: response.statusText, headers: response.headers });
}
