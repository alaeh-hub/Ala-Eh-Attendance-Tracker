import { useState } from "react";
import { ConfirmDialog } from "./ui";

/**
 * Closing a form with unsaved edits asks first. Use `requestClose` for Cancel, Escape and the backdrop;
 * it closes straight away when nothing changed. Render `dialog` inside the form's component.
 */
export function useDiscardGuard(dirty: boolean, onClose: () => void, busy = false) {
  const [asking, setAsking] = useState(false);
  const requestClose = () => {
    if (busy) return;
    if (dirty) setAsking(true);
    else onClose();
  };
  const dialog = (
    <ConfirmDialog
      open={asking}
      title="Discard your changes?"
      confirmLabel="Discard changes"
      danger
      message="You have unsaved edits. If you close now they will be lost."
      onClose={() => setAsking(false)}
      onConfirm={() => {
        setAsking(false);
        onClose();
      }}
    />
  );
  return { requestClose, dialog };
}
