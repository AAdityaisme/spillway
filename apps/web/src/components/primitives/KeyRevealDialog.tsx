import { Button } from './Button.js';
import { CodeBlock } from './CodeBlock.js';
import { Dialog } from './Dialog.js';

export interface KeyRevealDialogProps {
  /** The plaintext key from the 201 create response, or null when closed. */
  openWithKey: string | null;
  onDone: () => void;
}

/**
 * Copy-once reveal (09-frontend §3.3 step 3): the API returns the plaintext exactly once.
 * No Escape, no backdrop close — "I've saved my key" is the only exit.
 */
export function KeyRevealDialog({ openWithKey, onDone }: KeyRevealDialogProps) {
  return (
    <Dialog
      open={openWithKey !== null}
      onClose={onDone}
      destructive
      title="Copy your key now"
      description="This is the only time Spillway will show you this key. Store it somewhere safe."
      actions={
        <Button onClick={onDone} data-testid="key-reveal-confirm-btn">
          I&rsquo;ve saved my key
        </Button>
      }
    >
      {openWithKey ? <CodeBlock code={openWithKey} testId="key-reveal-copy-btn" /> : null}
    </Dialog>
  );
}
