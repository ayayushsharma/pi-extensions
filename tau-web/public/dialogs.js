/**
 * Dialogs - Handles extension UI dialogs
 */

import { icon } from './icons.js';

// Monotonic id source for dialog titles (aria-labelledby targets).
let dialogSeq = 0;

export class DialogHandler {
  constructor(container, wsClient) {
    this.container = container;
    this.wsClient = wsClient;
    this.currentDialog = null;
    this.currentRequestId = null;
    this.currentRequest = null;
    this.timeoutId = null;
    // Set by app.js: asked when the user hits "Abort run" on an agent
    // dialog. Routes like any other control command (uplink → mirror →
    // headless), which dialogs.js itself cannot decide.
    this.onAbortRequest = null;
  }

  // Every agent dialog carries an Abort-run escape hatch (ADR-007): answer
  // Cancel first so the parked waiter is released, then abort the run that
  // asked — routed to the dialog's owner (uplink TUI / headless child /
  // mirror session), never just the currently viewed backend.
  abortActions() {
    return `<button id="dialog-abort" class="dialog-abort">Abort run</button>`;
  }
  wireAbort(dialog, id) {
    dialog.querySelector('#dialog-abort')?.addEventListener('click', () => {
      const req = this.currentRequestId === id ? this.currentRequest : null;
      this.respond(id, { cancelled: true });
      try {
        if (req?.uplink) {
          this.wsClient.send({ type: 'uplink_command', command: { type: 'abort' } });
        } else if (req?.headless) {
          this.wsClient.send({ type: 'rpc_command', command: { type: 'abort' } });
        } else if (typeof this.onAbortRequest === 'function') {
          this.onAbortRequest();
        } else {
          this.wsClient.send({ type: 'abort' });
        }
      } catch {}
    });
  }

  showSelect(request) {
    this.clearCurrentDialog();

    const { id, title, options, timeout } = request;

    const dialog = document.createElement('div');
    dialog.className = 'dialog';
    dialog.innerHTML = `
      <div class="dialog-title">${this.escapeHtml(title || 'Select an option')}</div>
      <div class="dialog-options" id="dialog-options"></div>
      <div class="dialog-actions">
        <button id="dialog-cancel">Cancel</button>
        ${this.abortActions()}
      </div>
    `;

    const optionsContainer = dialog.querySelector('#dialog-options');
    
    (options || []).forEach(option => {
      const optionDiv = document.createElement('div');
      optionDiv.className = 'dialog-option';
      optionDiv.textContent = option;
      optionDiv.onclick = () => {
        this.respond(id, { value: option });
      };
      optionsContainer.appendChild(optionDiv);
    });

    dialog.querySelector('#dialog-cancel').onclick = () => {
      this.respond(id, { cancelled: true });
    };

    this.showDialog(dialog, timeout, id, request);
  }

  showConfirm(request) {
    this.clearCurrentDialog();

    const { id, title, message, timeout } = request;

    const dialog = document.createElement('div');
    dialog.className = 'dialog';
    dialog.innerHTML = `
      <div class="dialog-title">${this.escapeHtml(title || 'Confirm')}</div>
      ${message ? `<div class="dialog-message">${this.escapeHtml(message)}</div>` : ''}
      <div class="dialog-actions">
        <button id="dialog-no">No</button>
        <button id="dialog-yes">Yes</button>
        ${this.abortActions()}
      </div>
    `;

    dialog.querySelector('#dialog-yes').onclick = () => {
      this.respond(id, { confirmed: true });
    };

    dialog.querySelector('#dialog-no').onclick = () => {
      this.respond(id, { confirmed: false });
    };

    this.showDialog(dialog, timeout, id, request);
  }

  showInput(request) {
    this.clearCurrentDialog();

    const { id, title, placeholder, timeout } = request;

    const dialog = document.createElement('div');
    dialog.className = 'dialog';
    dialog.innerHTML = `
      <div class="dialog-title">${this.escapeHtml(title || 'Input')}</div>
      <input type="text" class="dialog-input" id="dialog-input" placeholder="${this.escapeHtml(placeholder || '')}" />
      <div class="dialog-actions">
        <button id="dialog-cancel">Cancel</button>
        <button id="dialog-submit">Submit</button>
        ${this.abortActions()}
      </div>
    `;

    const input = dialog.querySelector('#dialog-input');
    
    const submit = () => {
      const value = input.value.trim();
      this.respond(id, value ? { value } : { cancelled: true });
    };

    input.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') submit();
    });

    dialog.querySelector('#dialog-submit').onclick = submit;
    dialog.querySelector('#dialog-cancel').onclick = () => {
      this.respond(id, { cancelled: true });
    };

    this.showDialog(dialog, timeout, id, request);
    
    // Focus input after a short delay
    setTimeout(() => input.focus(), 100);
  }

  showEditor(request) {
    this.clearCurrentDialog();

    const { id, title, prefill, timeout } = request;

    const dialog = document.createElement('div');
    dialog.className = 'dialog';
    dialog.innerHTML = `
      <div class="dialog-title">${this.escapeHtml(title || 'Editor')}</div>
      <textarea class="dialog-textarea" id="dialog-textarea">${this.escapeHtml(prefill || '')}</textarea>
      <div class="dialog-actions">
        <button id="dialog-cancel">Cancel</button>
        <button id="dialog-save">Save</button>
        ${this.abortActions()}
      </div>
    `;

    const textarea = dialog.querySelector('#dialog-textarea');

    dialog.querySelector('#dialog-save').onclick = () => {
      const value = textarea.value;
      this.respond(id, value ? { value } : { cancelled: true });
    };

    dialog.querySelector('#dialog-cancel').onclick = () => {
      this.respond(id, { cancelled: true });
    };

    this.showDialog(dialog, timeout, id, request);
    
    // Focus textarea after a short delay
    setTimeout(() => textarea.focus(), 100);
  }

  showNotification(request) {
    const { message, notifyType } = request;
    const sticky = notifyType && notifyType !== 'info';
    
    // Create a temporary notification element
    const notification = document.createElement('div');
    notification.className = 'error-message';
    notification.setAttribute('role', 'status');
    notification.innerHTML = `${icon(notifyType === 'info' ? 'info' : 'warn', 14)}<span></span>`;
    notification.querySelector('span').textContent = message;
    
    // Add to messages container temporarily
    const messagesContainer = document.getElementById('messages');
    if (messagesContainer) {
      messagesContainer.appendChild(notification);
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
      
      // Info notices fade; warnings/errors persist (ADR-007: failures stay
      // visible) and dismiss on tap.
      if (!sticky) {
        setTimeout(() => {
          notification.remove();
        }, 5000);
      } else {
        notification.style.cursor = 'pointer';
        notification.title = 'Tap to dismiss';
        notification.addEventListener('click', () => notification.remove());
      }
    }
  }

  // Local (client-side) confirmation modal for UI-destructive actions
  // (delete session, …). The agent-dialog methods above answer a parked
  // server waiter; this one answers the caller — no WS traffic involved.
  confirmLocal({ title, message, okLabel = 'Delete', cancelLabel = 'Cancel' } = {}) {
    // A local confirm supersedes like any other dialog: an agent dialog on
    // screen has a parked server waiter — answer it cancelled first, or the
    // run hangs forever with an orphan spinner.
    if (this.currentRequestId) {
      try {
        this.wsClient.send({ type: 'extension_ui_response', id: this.currentRequestId, cancelled: true, superseded: true });
      } catch {}
    }
    this.clearCurrentDialog();
    return new Promise((resolve) => {
      const dialog = document.createElement('div');
      dialog.className = 'dialog';
      const titleEl = document.createElement('div');
      titleEl.className = 'dialog-title';
      titleEl.textContent = title || 'Confirm';
      dialog.appendChild(titleEl);
      if (message) {
        const msgEl = document.createElement('div');
        msgEl.className = 'dialog-message';
        msgEl.textContent = message;
        dialog.appendChild(msgEl);
      }
      const actions = document.createElement('div');
      actions.className = 'dialog-actions';
      const cancelBtn = document.createElement('button');
      cancelBtn.textContent = cancelLabel;
      const okBtn = document.createElement('button');
      okBtn.textContent = okLabel;
      okBtn.className = 'dialog-danger';
      actions.appendChild(cancelBtn);
      actions.appendChild(okBtn);
      dialog.appendChild(actions);
      const done = (value) => { this.clearCurrentDialog(); resolve(value); };
      cancelBtn.addEventListener('click', () => done(false));
      okBtn.addEventListener('click', () => done(true));
      dialog.addEventListener('keydown', (e) => { if (e.key === 'Escape') done(false); });
      this.makeDialogAccessible(dialog);
      this.currentDialog = dialog;
      this.container.innerHTML = '';
      this.container.appendChild(dialog);
      this.container.classList.remove('hidden');
      setTimeout(() => okBtn.focus(), 50);
    });
  }

  // A lightweight in-browser prompt for tau-owned flows (New session). Unlike
  // agent dialogs it never parks a server waiter, but it still supersedes any
  // on-screen agent dialog for the same reason confirmLocal does.
  promptLocal({ title, fields = [], okLabel = "Create", cancelLabel = "Cancel" } = {}) {
    if (this.currentRequestId) {
      try {
        this.wsClient.send({ type: 'extension_ui_response', id: this.currentRequestId, cancelled: true, superseded: true });
      } catch {}
    }
    this.clearCurrentDialog();
    return new Promise((resolve) => {
      const dialog = document.createElement('div');
      dialog.className = 'dialog';
      const titleEl = document.createElement('div');
      titleEl.className = 'dialog-title';
      titleEl.textContent = title || 'New session';
      dialog.appendChild(titleEl);

      const inputs = {};
      for (const f of fields) {
        const row = document.createElement('label');
        row.className = 'dialog-field';
        const label = document.createElement('span');
        label.textContent = f.label || f.name;
        row.appendChild(label);
        const input = document.createElement(f.multiline ? 'textarea' : 'input');
        input.className = 'dialog-input';
        input.value = f.value || '';
        if (f.placeholder) input.placeholder = f.placeholder;
        if (f.multiline) input.rows = 3;
        inputs[f.name] = input;
        row.appendChild(input);
        dialog.appendChild(row);
      }

      const actions = document.createElement('div');
      actions.className = 'dialog-actions';
      const cancelBtn = document.createElement('button');
      cancelBtn.textContent = cancelLabel;
      const okBtn = document.createElement('button');
      okBtn.textContent = okLabel;
      actions.appendChild(cancelBtn);
      actions.appendChild(okBtn);
      dialog.appendChild(actions);

      const done = (value) => { this.clearCurrentDialog(); resolve(value); };
      cancelBtn.addEventListener('click', () => done(null));
      okBtn.addEventListener('click', () => {
        const out = {};
        for (const [k, el] of Object.entries(inputs)) out[k] = el.value;
        done(out);
      });
      dialog.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') done(null);
        else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) okBtn.click();
      });

      this.makeDialogAccessible(dialog);
      this.currentDialog = dialog;
      this.container.innerHTML = '';
      this.container.appendChild(dialog);
      this.container.classList.remove('hidden');
      const first = inputs[fields[0]?.name];
      setTimeout(() => (first || okBtn).focus(), 50);
    });
  }

  // Every dialog is modal and takes its accessible name from its title row,
  // so assistive tech announces it on open instead of an unnamed group.
  // Called wherever a freshly built dialog is handed to the container: the
  // four server-driven ones via showDialog, plus confirmLocal/promptLocal.
  makeDialogAccessible(dialogElement) {
    dialogElement.setAttribute('role', 'dialog');
    dialogElement.setAttribute('aria-modal', 'true');
    const titleEl = dialogElement.querySelector('.dialog-title');
    if (titleEl) {
      if (!titleEl.id) titleEl.id = `dialog-title-${++dialogSeq}`;
      dialogElement.setAttribute('aria-labelledby', titleEl.id);
    }
    return dialogElement;
  }

  // ADR-007: dialogs queue one-at-a-time. A second request supersedes the
  // first — but the first waiter's run is still parked on it, so answer
  // `cancelled` for the displaced dialog instead of dropping it silently
  // (a dropped dialog hangs the run forever with an orphan spinner).
  showDialog(dialogElement, timeout, requestId, request = null) {
    if (this.currentRequestId && this.currentRequestId !== requestId) {
      try {
        this.wsClient.send({ type: 'extension_ui_response', id: this.currentRequestId, cancelled: true, superseded: true });
      } catch {}
    }
    this.clearCurrentDialog();
    this.currentRequestId = requestId || null;
    this.currentRequest = request;
    this.wireAbort(dialogElement, this.currentRequestId);
    this.makeDialogAccessible(dialogElement);
    this.currentDialog = dialogElement;
    this.container.innerHTML = '';
    this.container.appendChild(dialogElement);
    this.container.classList.remove('hidden');

    // Set up timeout if specified
    if (timeout) {
      this.timeoutId = setTimeout(() => {
        this.respond(requestId, { cancelled: true });
      }, timeout);
    }
  }

  clearCurrentDialog() {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    this.container.innerHTML = '';
    this.container.classList.add('hidden');
    this.currentDialog = null;
    this.currentRequestId = null;
    this.currentRequest = null;
  }

  respond(id, response) {
    this.clearCurrentDialog();
    this.wsClient.send({
      type: 'extension_ui_response',
      id,
      ...response
    });
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    // innerHTML escapes &<>, but NOT quotes — attribute contexts need them too.
    return div.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
}
