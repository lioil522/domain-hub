# Domain Hub 2.0 — Phase 4-A

## DNSHE modal state/action boundary

`DnsheDnsModal.tsx` is now an orchestration/view layer rather than the owner of its entire local state and mutation workflow.

- `useDnsheDnsModalState.ts` owns modal-local React state.
- `useDnsheDnsModalActions.ts` owns DNSHE record loading, create/update/batch mutation, selection, and reset actions.
- `DnsheDnsModal.tsx` keeps derived view data, row rendering, effects, and composition.
- Architecture checks prevent local `useState` from returning to the modal component.
