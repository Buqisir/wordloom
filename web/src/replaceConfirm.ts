export type ReplaceIntent = {
  open: boolean;
  confirmed: boolean;
};

export type ReplaceAction = { type: 'open' } | { type: 'dismiss' } | { type: 'acknowledge'; checked: boolean };

export const initialReplaceIntent: ReplaceIntent = { open: false, confirmed: false };

export function replaceIntentReducer(state: ReplaceIntent, action: ReplaceAction): ReplaceIntent {
  switch (action.type) {
    case 'open':
      return { open: true, confirmed: false };
    case 'dismiss':
      return { open: false, confirmed: false };
    case 'acknowledge':
      return { open: state.open, confirmed: action.checked };
    default: {
      const unreachable: never = action;
      return unreachable;
    }
  }
}

export function replaceConfirmEnabled(confirmed: boolean, busy: boolean): boolean {
  return confirmed && !busy;
}
