/**
 * ============================================================================
 *  TextSync — Content Script (content.js)
 * ============================================================================
 *
 *  HOW CROSS-PAGE TEXT SYNCHRONIZATION WORKS:
 *  -------------------------------------------
 *  1. This content script is injected into every page the user visits.
 *  2. It creates a floating control panel (DOM overlay) on top of the page.
 *  3. An interval listener polls the currently focused/active element every
 *     100ms, checking whether the user has selected text inside an <input>,
 *     <textarea>, or a contentEditable element.
 *  4. When a selection is detected (via selectionStart/selectionEnd for
 *     native inputs, or window.getSelection() for contentEditable), the
 *     selected text is displayed in the panel's "Selected Text" field.
 *  5. The user can edit the replacement text in a second input field.
 *  6. On clicking "Replace", the script:
 *       a. Restores focus to the original element.
 *       b. Restores the exact selectionStart / selectionEnd range.
 *       c. Uses document.execCommand('insertText') to replace the selected
 *          text. This preserves undo history and fires proper input events,
 *          which is critical for React-based sites like ChatGPT that rely
 *          on synthetic event listeners rather than direct value mutation.
 *       d. Falls back to direct value assignment + InputEvent dispatch if
 *          execCommand is unavailable.
 *  7. A MutationObserver watches for DOM changes (new inputs appearing,
 *     contentEditable regions mounting) so the extension adapts dynamically.
 *
 *  SECURITY NOTE:
 *  Content scripts run in an "isolated world" — they share the page's DOM
 *  but NOT its JavaScript context. This means we can read/write DOM properties
 *  (like .value, .selectionStart) but cannot call page-level JS functions.
 *  This is why a browser extension is required; a normal website cannot
 *  manipulate another site's DOM due to the Same-Origin Policy.
 * ============================================================================
 */

(function () {
  'use strict';

  // ── Guard against double-injection ──────────────────────────────────────
  if (window.__textSyncInjected) return;
  window.__textSyncInjected = true;

  // ── State ───────────────────────────────────────────────────────────────
  /** @type {HTMLElement|null} The element the user last selected text in */
  let trackedElement = null;

  /** Selection boundaries for <input> / <textarea> */
  let selStart = 0;
  let selEnd = 0;

  /** The raw selected string */
  let selectedText = '';

  /**
   * Whether we have a captured selection that can be replaced.
   * This is separate from selStart/selEnd because for contentEditable
   * elements both are set to -1 as sentinels, so selStart === selEnd
   * would incorrectly indicate "no selection".
   */
  let hasValidSelection = false;

  /** Sync status for the UI badge */
  let syncStatus = 'idle'; // 'idle' | 'watching' | 'synced' | 'replaced'

  /** Whether the panel is currently visible */
  let panelVisible = true;

  /** Polling interval ID */
  let pollerId = null;

  // ── Build the floating panel ────────────────────────────────────────────
  const panel = document.createElement('div');
  panel.id = 'textsync-panel';
  panel.innerHTML = buildPanelHTML();
  document.documentElement.appendChild(panel);

  // Cache DOM references inside the panel
  const elStatus      = panel.querySelector('#ts-status');
  const elStatusDot   = panel.querySelector('#ts-status-dot');
  const elSelected    = panel.querySelector('#ts-selected');
  const elReplacement = panel.querySelector('#ts-replacement');
  const elBtnReplace  = panel.querySelector('#ts-btn-replace');
  const elBtnCopy     = panel.querySelector('#ts-btn-copy');
  const elBtnClear    = panel.querySelector('#ts-btn-clear');
  const elToggle      = panel.querySelector('#ts-toggle');
  const elBody        = panel.querySelector('#ts-body');
  const elElementInfo = panel.querySelector('#ts-element-info');
  const elCharCount   = panel.querySelector('#ts-char-count');
  const elToast       = panel.querySelector('#ts-toast');

  // ── Make the panel draggable ────────────────────────────────────────────
  initDrag();

  // ── Event listeners ─────────────────────────────────────────────────────

  /**
   * REPLACE: Take the replacement text, restore focus & selection on the
   * original element, then surgically swap the selected region.
   */
  elBtnReplace.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();

    // Use hasValidSelection instead of selStart === selEnd because
    // for contentEditable elements, both selStart and selEnd are -1
    // (sentinel values), so selStart === selEnd would always be true.
    if (!trackedElement || !hasValidSelection) {
      showToast('Nothing selected to replace', 'warning');
      return;
    }
    const replacement = elReplacement.value;
    replaceTextInElement(trackedElement, selStart, selEnd, replacement);
    showToast('Text replaced!', 'success');
    updateStatus('replaced');

    // After replacement, update selection boundaries so the newly
    // inserted text is selected, allowing iterative edits.
    if (selStart >= 0) {
      // Native input/textarea — update numeric boundaries
      selEnd = selStart + replacement.length;
    }
    // For contentEditable, the __tsRange is stale after replacement.
    // We capture the new range so the user can replace again.
    if (selStart === -1 && trackedElement) {
      try {
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0) {
          trackedElement.__tsRange = sel.getRangeAt(0).cloneRange();
        }
      } catch (_) {}
    }
    selectedText = replacement;
    elSelected.value = replacement;
  });

  /**
   * COPY: Write the selected text to the clipboard.
   */
  elBtnCopy.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!selectedText) {
      showToast('Nothing to copy', 'warning');
      return;
    }
    navigator.clipboard.writeText(selectedText).then(() => {
      showToast('Copied to clipboard!', 'success');
    }).catch(() => {
      // Fallback for older browsers
      const ta = document.createElement('textarea');
      ta.value = selectedText;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      showToast('Copied!', 'success');
    });
  });

  /**
   * CLEAR: Reset the panel fields and stop tracking.
   */
  elBtnClear.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    trackedElement = null;
    selectedText = '';
    selStart = 0;
    selEnd = 0;
    hasValidSelection = false;
    elSelected.value = '';
    elReplacement.value = '';
    elElementInfo.textContent = 'No element tracked';
    elCharCount.textContent = '0 chars selected';
    updateStatus('idle');
    showToast('Cleared', 'info');
  });

  /**
   * TOGGLE: Collapse / expand the panel body.
   */
  elToggle.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    panelVisible = !panelVisible;
    elBody.style.display = panelVisible ? 'flex' : 'none';
    elToggle.textContent = panelVisible ? '▼' : '▲';
  });

  /**
   * Prevent focus-stealing: when the user clicks INSIDE the panel,
   * we don't want the page's tracked element to lose focus permanently.
   * We mark a flag so the poller knows to skip that tick.
   *
   * IMPORTANT: We use a debounced focusout (50ms delay) because when
   * focus moves between elements WITHIN the panel (e.g. from the
   * replacement textarea to the Replace button), focusout fires before
   * focusin. Without the delay, panelFocused would briefly become false
   * and the poller could run, see no selection on the original element,
   * and wipe our saved state.
   */
  let panelFocused = false;
  let focusOutTimer = null;
  panel.addEventListener('mousedown', () => {
    clearTimeout(focusOutTimer);
    panelFocused = true;
  });
  panel.addEventListener('focusin', () => {
    clearTimeout(focusOutTimer);
    panelFocused = true;
  });
  panel.addEventListener('focusout', () => {
    clearTimeout(focusOutTimer);
    focusOutTimer = setTimeout(() => {
      // Only clear if focus truly left the panel entirely
      if (!panel.contains(document.activeElement)) {
        panelFocused = false;
      }
    }, 50);
  });

  // ── Live "replacement" text auto-sync (two-way binding) ─────────────
  /**
   * When the user types in the replacement field AND the original element
   * still has the same selection, we can live-preview the replacement.
   * This enables real-time two-way synchronization.
   */
  elReplacement.addEventListener('input', () => {
    // We don't auto-replace on every keystroke to avoid disrupting the
    // user's workflow. Instead we update char count feedback.
    const len = elReplacement.value.length;
    elCharCount.textContent = `${selectedText.length} → ${len} chars`;
  });

  // ── Polling: detect selection changes ───────────────────────────────────
  /**
   * We use setInterval rather than 'selectionchange' because:
   *  - 'selectionchange' fires on document, not on individual inputs.
   *  - Some sites (ChatGPT, Google Docs) use custom contentEditable
   *    elements where selectionchange is unreliable.
   *  - Polling at 100ms is imperceptible to the user and very lightweight.
   */
  function startPolling() {
    if (pollerId) return;
    pollerId = setInterval(pollSelection, 100);
  }

  function stopPolling() {
    if (pollerId) {
      clearInterval(pollerId);
      pollerId = null;
    }
  }

  /**
   * Core polling function — runs every 100ms.
   * Detects the focused element and reads its current text selection.
   */
  function pollSelection() {
    // Skip if the user is interacting with our panel
    if (panelFocused) return;

    const active = document.activeElement;
    if (!active || active === document.body || panel.contains(active)) return;

    // ── Case 1: Native <input> or <textarea> ─────────────────────────
    if (isNativeInput(active)) {
      try {
        const start = active.selectionStart;
        const end = active.selectionEnd;

        if (start !== null && end !== null && start !== end) {
          const text = active.value.substring(start, end);
          if (text !== selectedText || active !== trackedElement) {
            trackedElement = active;
            selStart = start;
            selEnd = end;
            selectedText = text;
            hasValidSelection = true;
            elSelected.value = text;
            elReplacement.value = text;
            updateElementInfo(active);
            updateStatus('watching');
            elCharCount.textContent = `${text.length} chars selected`;
          }
        }
      } catch (err) {
        // Some input types (e.g. type="email") throw on selectionStart
      }
      return;
    }

    // ── Case 2: contentEditable / general selection ──────────────────
    if (active.isContentEditable || active.getAttribute('role') === 'textbox') {
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
        const text = sel.toString();
        if (text && (text !== selectedText || active !== trackedElement)) {
          trackedElement = active;
          selectedText = text;
          hasValidSelection = true;
          // For contentEditable, we store the Range so we can restore it
          trackedElement.__tsRange = sel.getRangeAt(0).cloneRange();
          selStart = -1; // sentinel: indicates contentEditable mode
          selEnd = -1;
          elSelected.value = text;
          elReplacement.value = text;
          updateElementInfo(active);
          updateStatus('watching');
          elCharCount.textContent = `${text.length} chars selected`;
        }
      }
    }
  }

  // ── Text replacement logic ──────────────────────────────────────────────

  /**
   * Replace text within the tracked element.
   *
   * Strategy:
   *  1. Restore focus to the element.
   *  2. Restore the exact selection range.
   *  3. Use execCommand('insertText') which:
   *     - Fires proper 'input' events (critical for React/Vue sites).
   *     - Preserves undo/redo history.
   *  4. Fall back to manual value assignment if execCommand fails.
   *  5. Re-position the cursor at the end of the inserted text.
   */
  function replaceTextInElement(el, start, end, replacement) {
    // ── contentEditable path ──────────────────────────────────────────
    if (start === -1 && end === -1) {
      replaceContentEditable(el, replacement);
      return;
    }

    // ── Native input/textarea path ────────────────────────────────────
    el.focus();

    // Restore selection range
    el.setSelectionRange(start, end);

    // Attempt execCommand (works in most browsers, fires input events)
    const success = document.execCommand('insertText', false, replacement);

    if (!success) {
      // Manual fallback: splice the value string
      const before = el.value.substring(0, start);
      const after = el.value.substring(end);
      el.value = before + replacement + after;

      // Dispatch synthetic InputEvent so frameworks pick up the change
      el.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: replacement,
      }));
    }

    // Preserve cursor: place it right after the replacement text
    const newCursorPos = start + replacement.length;
    el.setSelectionRange(newCursorPos, newCursorPos);
  }

  /**
   * Replace selected text inside a contentEditable element.
   * Uses the stored Range to restore the exact selection, then
   * replaces via execCommand for React-compatible event firing.
   */
  function replaceContentEditable(el, replacement) {
    el.focus();

    const storedRange = el.__tsRange;
    if (storedRange) {
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(storedRange);
    }

    const success = document.execCommand('insertText', false, replacement);

    if (!success) {
      // Fallback: delete range contents and insert a text node
      const sel = window.getSelection();
      if (sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        range.deleteContents();
        range.insertNode(document.createTextNode(replacement));
        // Collapse cursor to end of insertion
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      }
      el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    }
  }

  // ── MutationObserver ────────────────────────────────────────────────────
  /**
   * Watch for new nodes being added to the DOM. This handles:
   *  - Single-page apps that dynamically mount/unmount input fields.
   *  - ChatGPT's textarea which is replaced on route changes.
   *  - Lazy-loaded forms.
   *
   * When we detect DOM changes, we simply keep polling — no special
   * action needed since pollSelection() always reads document.activeElement.
   * The observer is here primarily to restart polling if it was stopped.
   */
  const observer = new MutationObserver((mutations) => {
    // If polling was somehow stopped, restart it
    if (!pollerId) startPolling();
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });

  // ── Utility functions ───────────────────────────────────────────────────

  function isNativeInput(el) {
    const tag = el.tagName;
    if (tag === 'TEXTAREA') return true;
    if (tag === 'INPUT') {
      const type = (el.type || 'text').toLowerCase();
      // Only text-like inputs support selectionStart
      return ['text', 'search', 'url', 'tel', 'password'].includes(type);
    }
    return false;
  }

  function updateStatus(status) {
    syncStatus = status;
    const labels = {
      idle: 'Idle',
      watching: 'Watching',
      synced: 'Synced',
      replaced: 'Replaced',
    };
    const colors = {
      idle: '#6b7280',
      watching: '#3b82f6',
      synced: '#10b981',
      replaced: '#f59e0b',
    };
    elStatus.textContent = labels[status] || status;
    elStatusDot.style.background = colors[status] || '#6b7280';
  }

  function updateElementInfo(el) {
    const tag = el.tagName.toLowerCase();
    const id = el.id ? `#${el.id}` : '';
    const cls = el.className && typeof el.className === 'string'
      ? `.${el.className.split(' ').slice(0, 2).join('.')}`
      : '';
    const role = el.getAttribute('role') ? `[role="${el.getAttribute('role')}"]` : '';
    elElementInfo.textContent = `${tag}${id}${cls}${role}`.substring(0, 60);
  }

  function showToast(message, type = 'info') {
    const colors = {
      success: 'linear-gradient(135deg, #10b981, #059669)',
      warning: 'linear-gradient(135deg, #f59e0b, #d97706)',
      info: 'linear-gradient(135deg, #3b82f6, #2563eb)',
      error: 'linear-gradient(135deg, #ef4444, #dc2626)',
    };
    elToast.textContent = message;
    elToast.style.background = colors[type] || colors.info;
    elToast.style.opacity = '1';
    elToast.style.transform = 'translateY(0)';
    setTimeout(() => {
      elToast.style.opacity = '0';
      elToast.style.transform = 'translateY(8px)';
    }, 2000);
  }

  // ── Drag logic ──────────────────────────────────────────────────────────
  function initDrag() {
    const header = panel.querySelector('#ts-header');
    let isDragging = false;
    let offsetX = 0, offsetY = 0;

    header.addEventListener('mousedown', (e) => {
      // Only drag on the header background, not on buttons
      if (e.target.closest('button')) return;
      isDragging = true;
      offsetX = e.clientX - panel.getBoundingClientRect().left;
      offsetY = e.clientY - panel.getBoundingClientRect().top;
      panel.style.transition = 'none';
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const x = e.clientX - offsetX;
      const y = e.clientY - offsetY;
      panel.style.left = `${x}px`;
      panel.style.top = `${y}px`;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    });

    document.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        panel.style.transition = '';
      }
    });
  }

  // ── Panel HTML template ─────────────────────────────────────────────────
  function buildPanelHTML() {
    return `
      <div id="ts-header">
        <div id="ts-title">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
          </svg>
          <span>TextSync</span>
          <span id="ts-status-dot"></span>
          <span id="ts-status">Idle</span>
        </div>
        <button id="ts-toggle" title="Toggle panel">▼</button>
      </div>
      <div id="ts-body">
        <div id="ts-element-info">No element tracked</div>
        <label class="ts-label">
          <span class="ts-label-text">Selected Text</span>
          <textarea id="ts-selected" readonly rows="3" placeholder="Select text on the page…"></textarea>
        </label>
        <label class="ts-label">
          <span class="ts-label-text">Replacement Text</span>
          <textarea id="ts-replacement" rows="3" placeholder="Type replacement text…"></textarea>
        </label>
        <div id="ts-char-count">0 chars selected</div>
        <div id="ts-actions">
          <button id="ts-btn-replace" class="ts-btn ts-btn-primary" title="Replace selected text in the page">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
            Replace
          </button>
          <button id="ts-btn-copy" class="ts-btn ts-btn-secondary" title="Copy selected text">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            Copy
          </button>
          <button id="ts-btn-clear" class="ts-btn ts-btn-ghost" title="Clear selection">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            Clear
          </button>
        </div>
        <div id="ts-toast"></div>
      </div>
    `;
  }

  // ── Start ───────────────────────────────────────────────────────────────
  startPolling();
  updateStatus('idle');

})();
