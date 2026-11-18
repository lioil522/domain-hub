import assert from "node:assert/strict";
import { test } from "node:test";
import { lazy, useEffect, useState } from "react";
import { act, create } from "react-test-renderer";
import { DeferredFeature } from "../src/components/DeferredFeature";
import { LazyBoundary } from "../src/components/LazyBoundary";
import { lazyModal } from "../src/lib/lazy-modal";

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("an unvisited feature never imports; after visiting, navigation preserves task/state", async () => {
  const module = deferred();
  let imports = 0, mounts = 0, aborts = 0;
  function Feature() {
    const [value, setValue] = useState("draft");
    useEffect(() => { mounts++; return () => { aborts++; }; }, []);
    return <button onClick={() => setValue("edited")}>{value}</button>;
  }
  const View = lazy(() => { imports++; return module.promise; });
  const render = (active, identity = "session-a") =>
    <DeferredFeature key={identity} active={active} label="Scanner"><View /></DeferredFeature>;
  let tree;
  await act(async () => { tree = create(render(false)); });
  assert.equal(imports, 0);
  assert.equal(tree.toJSON(), null);
  await act(async () => { tree.update(render(true)); });
  assert.equal(imports, 1);
  assert.equal(tree.root.findByProps({ role: "status" }).children.join(""), "正在加载Scanner…");
  await act(async () => { module.resolve({ default: Feature }); });
  await act(async () => { tree.root.findByType("button").props.onClick(); });
  await act(async () => { tree.update(render(false)); });
  assert.equal(tree.root.findByType("div").props.hidden, true);
  assert.equal(aborts, 0);
  await act(async () => { tree.update(render(true)); });
  assert.equal(tree.root.findByType("button").children.join(""), "edited");
  assert.equal(mounts, 1);
  assert.equal(imports, 1);
  // Session/backend identity change disposes work. The new identity remains dormant.
  await act(async () => { tree.update(render(false, "session-b")); });
  assert.equal(aborts, 1);
  assert.equal(tree.toJSON(), null);
  await act(async () => { tree.update(render(true, "session-b")); });
  assert.equal(tree.root.findByType("button").children.join(""), "draft");
  assert.equal(mounts, 2);
  await act(async () => { tree.unmount(); });
  assert.equal(aborts, 2, "logout/unmount must dispose the active task");
});

test("closed modals do not import; pending state can cancel, loaded modal has no extra overlay", async () => {
  const module = deferred();
  let imports = 0, closes = 0;
  const View = lazyModal(() => { imports++; return module.promise; }, "View", "添加域名", p => p.open, p => p.onClose);
  const render = open => <View open={open} onClose={() => { closes++; }} />;
  let tree;
  await act(async () => { tree = create(render(false)); });
  assert.equal(imports, 0);
  await act(async () => { tree.update(render(true)); });
  assert.equal(imports, 1);
  assert.equal(tree.root.findByProps({ role: "dialog" }).props["aria-label"], "添加域名");
  await act(async () => { tree.root.findByType("button").props.onClick(); tree.update(render(false)); });
  assert.equal(closes, 1);
  assert.equal(tree.toJSON(), null);
  await act(async () => { module.resolve({ View: () => <section role="dialog">loaded</section> }); });
  assert.equal(tree.toJSON(), null, "a late import cannot reopen a cancelled modal");
  await act(async () => { tree.update(render(true)); });
  assert.equal(imports, 1);
  assert.equal(tree.root.findAllByProps({ role: "dialog" }).length, 1);
  assert.equal(tree.toJSON().type, "section", "the loaded modal owns its overlay and focus trap");
  await act(async () => { tree.unmount(); });
});

async function withExpectedRenderError(run) {
  const original = console.error;
  console.error = (...args) => {
    if (String(args[0]).includes("The above error occurred")) return;
    original(...args);
  };
  try { await run(); } finally { console.error = original; }
}

test("a failed modal import shows close/reload recovery instead of a blank app", async () => {
  await withExpectedRenderError(async () => {
    const module = deferred();
    const View = lazyModal(() => module.promise, "View", "DNS 解析", p => p.open, p => p.onClose);
    let closed = false, reloaded = false, tree;
    const previousWindow = globalThis.window;
    globalThis.window = { location: { reload() { reloaded = true; } } };
    try {
      await act(async () => { tree = create(<View open onClose={() => { closed = true; }} />); });
      await act(async () => { module.reject(new Error("offline")); });
      assert.ok(tree.root.findByProps({ role: "alert" }));
      assert.equal(tree.root.findAllByProps({ role: "dialog" }).length, 1);
      const buttons = tree.root.findAllByType("button");
      await act(async () => { buttons[0].props.onClick(); buttons[1].props.onClick(); });
      assert.equal(reloaded, true);
      assert.equal(closed, true);
    } finally {
      if (tree) await act(async () => { tree.unmount(); });
      globalThis.window = previousWindow;
    }
  });
});

test("a failed page does not prevent navigation to another page", async () => {
  await withExpectedRenderError(async () => {
    const Broken = lazy(() => Promise.reject(new Error("offline")));
    let tree;
    await act(async () => { tree = create(<LazyBoundary label="页面" resetKey="old"><Broken /></LazyBoundary>); });
    assert.ok(tree.root.findByProps({ role: "alert" }));
    await act(async () => { tree.update(<LazyBoundary label="页面" resetKey="new"><p>healthy page</p></LazyBoundary>); });
    assert.equal(tree.toJSON().children.join(""), "healthy page");
    await act(async () => { tree.unmount(); });
  });
});
