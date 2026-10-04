/**
 * A read that failed, rendered as itself.
 *
 * The reason this is one component and not four inline `<div className="notice
 * error">` blocks is that the four places it appears all failed the same way:
 * the value came back empty and the panel said so as if it were a fact. Each
 * call site now has to name both halves — what could not be read, and why —
 * because the signature makes "just the reason" and "just the label"
 * unspellable.
 *
 * `role="alert"` because a failure that arrives after the panel has painted is
 * exactly what a live region is for: a screen reader user otherwise gets a
 * panel that silently changed from a table to nothing.
 */
export function ReadFailure({ label, reason }: { label: string; reason: string }): JSX.Element {
  return (
    <div className="notice error" role="alert">
      {label} — {reason}
    </div>
  );
}
