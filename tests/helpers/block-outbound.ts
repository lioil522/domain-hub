// Offline tests must install explicit fetch fixtures. Restoring a fixture restores this
// fail-closed default, never Node's real network implementation.
globalThis.fetch = async () => {
  throw new Error("Real outbound fetch is forbidden in offline tests; install an explicit mock");
};
