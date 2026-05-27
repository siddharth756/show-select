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
  if (window.__seiyaaInjected) return;
  window.__seiyaaInjected = true;

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

  /** Whether the panel is currently expanded */
  let panelExpanded = false;

  /** Polling interval ID */
  let pollerId = null;

  // ── Build the floating panel ────────────────────────────────────────────
  const panel = document.createElement('div');
  panel.id = 'seiyaa-panel';
  panel.className = 'ts-collapsed';
  panel.innerHTML = buildPanelHTML();
  document.documentElement.appendChild(panel);

  // Cache DOM references inside the panel
  const elStatus = panel.querySelector('#ts-status');
  const elStatusDot = panel.querySelector('#ts-status-dot');
  const elSelected = panel.querySelector('#ts-selected');
  const elReplacement = panel.querySelector('#ts-replacement');
  const elBtnReplace = panel.querySelector('#ts-btn-replace');
  const elBtnCopy = panel.querySelector('#ts-btn-copy');
  const elBtnCheck = panel.querySelector('#ts-btn-check');
  const elBtnClear = panel.querySelector('#ts-btn-clear');
  const elCircle = panel.querySelector('#seiyaa-circle-view');
  const elBtnClose = panel.querySelector('#ts-btn-close');
  const elBody = panel.querySelector('#ts-body');
  const elElementInfo = panel.querySelector('#ts-element-info');
  const elCharCount = panel.querySelector('#ts-char-count');
  const elToast = panel.querySelector('#ts-toast');
  const elCheckResults = panel.querySelector('#ts-check-results');
  const elCheckBody = panel.querySelector('#ts-check-body');
  const elCheckScore = panel.querySelector('#ts-check-score');
  const elCheckList = panel.querySelector('#ts-check-list');
  const elCheckSuggestions = panel.querySelector('#ts-check-suggestions');

  // AI & Settings elements
  const elBtnSettings = panel.querySelector('#ts-btn-settings');
  const elSettingsBody = panel.querySelector('#ts-settings-body');
  const elApiKey = panel.querySelector('#ts-api-key');
  const elApiKeyStatus = panel.querySelector('#ts-api-key-status');
  const elBtnKeyToggle = panel.querySelector('#ts-btn-key-toggle');
  const elKeyEyeShow = panel.querySelector('#ts-key-eye-show');
  const elKeyEyeHide = panel.querySelector('#ts-key-eye-hide');
  const elBtnKeySave = panel.querySelector('#ts-btn-key-save');
  const elBtnKeyClear = panel.querySelector('#ts-btn-key-clear');
  const elModelSelect = panel.querySelector('#ts-model-select');
  const elCustomModelWrapper = panel.querySelector('#ts-custom-model-wrapper');
  const elCustomModel = panel.querySelector('#ts-custom-model');
  const elBtnSettingsBack = panel.querySelector('#ts-btn-settings-back');
  const elBtnGenerate = panel.querySelector('#ts-btn-generate');
  const elBtnGenerateText = panel.querySelector('#ts-btn-generate-text');

  // Templates elements
  const elBtnTemplates       = panel.querySelector('#ts-btn-templates');
  const elTemplatesBody      = panel.querySelector('#ts-templates-body');
  const elNewTemplateName    = panel.querySelector('#ts-new-template-name');
  const elBtnSaveTemplate    = panel.querySelector('#ts-btn-save-template');
  const elBuiltinList        = panel.querySelector('#ts-builtin-templates-list');
  const elCustomList         = panel.querySelector('#ts-custom-templates-list');
  const elBtnTemplatesBack   = panel.querySelector('#ts-btn-templates-back');

  // ── OpenRouter & Settings State ──────────────────────────────────────────
  let openRouterKey = '';
  let selectedModel = 'meta-llama/llama-3.3-70b-instruct:free';
  let customModelId = '';
  let settingsVisible = false;
  let templatesVisible = false;
  let isGenerating = false;
  let customTemplates = [];

  const BUILTIN_TEMPLATES = [
    {
      name: 'Chain of Thought (CoT)',
      description: 'Breaks down reasoning step-by-step for complex problem solving.',
      prompt: 'Act as a [ROLE].\n\nYour task is to [TASK].\n\nContext:\n[BACKGROUND INFORMATION]\n\nLet\'s think step by step to solve this:\n1. First, [STEP 1]\n2. Next, [STEP 2]\n\nRequirements:\n- [RULE 1]\n- [RULE 2]\n\nOutput format:\n[DESIRED FORMAT]'
    },
    {
      name: 'Few-Shot Prompting',
      description: 'Provides examples to guide the AI\'s output structure and style.',
      prompt: 'Act as a [ROLE].\n\nYour task is to [TASK].\n\nContext:\n[BACKGROUND INFORMATION]\n\nHere are examples of how to solve the task:\nInput: [EXAMPLE INPUT 1]\nOutput: [EXAMPLE OUTPUT 1]\n\nInput: [EXAMPLE INPUT 2]\nOutput: [EXAMPLE OUTPUT 2]\n\nNow process the following input:\nInput: [CURRENT INPUT]\nOutput:'
    },
    {
      name: 'Code Debugger',
      description: 'Finds bugs, proposes fixes, and explains solutions clearly.',
      prompt: 'Act as a senior software engineer.\n\nYour task is to debug the following code:\n[CODE BLOCK]\n\nContext:\n- Language/framework: [LANGUAGE]\n- Expected behavior: [EXPECTED]\n- Actual behavior/error: [ACTUAL/ERROR]\n\nRequirements:\n- Locate the root cause of the error.\n- Provide the corrected code.\n- Explain the fix step-by-step.\n\nOutput format:\nDetailed explanation followed by corrected code block.'
    }
  ];

  // Load settings from storage
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get(['openRouterKey', 'selectedModel', 'customModelId', 'customTemplates'], (result) => {
      if (result.customTemplates) {
        customTemplates = result.customTemplates;
        renderCustomTemplates();
      }
      if (result.openRouterKey) {
        openRouterKey = result.openRouterKey;
        elApiKey.value = openRouterKey;
        updateApiKeyStatus(true);
      }
      if (result.selectedModel) {
        selectedModel = result.selectedModel;
        elModelSelect.value = selectedModel;
        if (selectedModel === 'custom') {
          elCustomModelWrapper.style.display = 'flex';
        } else {
          elCustomModelWrapper.style.display = 'none';
        }
      }
      if (result.customModelId) {
        customModelId = result.customModelId;
        elCustomModel.value = customModelId;
      }
    });
  }

  // ── API Key Status Helper ────────────────────────────────────────────
  /**
   * Update the stored/not-saved pill next to the API Key label.
   * @param {boolean} stored - true if a key is currently persisted in storage
   */
  function updateApiKeyStatus(stored) {
    if (!elApiKeyStatus) return;
    if (stored) {
      elApiKeyStatus.textContent = '✓ Stored';
      elApiKeyStatus.className = 'ts-api-key-status ts-api-key-status--stored';
    } else {
      elApiKeyStatus.textContent = 'Not saved';
      elApiKeyStatus.className = 'ts-api-key-status ts-api-key-status--empty';
    }
  }

  // Show / hide key toggle (eye icon)
  elBtnKeyToggle.addEventListener('click', () => {
    const isPassword = elApiKey.type === 'password';
    elApiKey.type = isPassword ? 'text' : 'password';
    elKeyEyeShow.style.display = isPassword ? 'none' : '';
    elKeyEyeHide.style.display = isPassword ? '' : 'none';
  });

  // Save Key — explicit save with visual confirmation
  elBtnKeySave.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const key = elApiKey.value.trim();
    if (!key) {
      showToast('Enter an API key first', 'warning');
      return;
    }
    openRouterKey = key;
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ openRouterKey: key }, () => {
        updateApiKeyStatus(true);
        showToast('API key saved to storage!', 'success');
      });
    } else {
      updateApiKeyStatus(true);
      showToast('API key saved (session only)', 'info');
    }
  });

  // Clear Key — removes from storage and resets state
  elBtnKeyClear.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openRouterKey = '';
    elApiKey.value = '';
    elApiKey.type = 'password';
    elKeyEyeShow.style.display = '';
    elKeyEyeHide.style.display = 'none';
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.remove('openRouterKey', () => {
        updateApiKeyStatus(false);
        showToast('API key cleared from storage', 'info');
      });
    } else {
      updateApiKeyStatus(false);
      showToast('API key cleared', 'info');
    }
  });

  elModelSelect.addEventListener('change', () => {
    selectedModel = elModelSelect.value;
    if (selectedModel === 'custom') {
      elCustomModelWrapper.style.display = 'flex';
    } else {
      elCustomModelWrapper.style.display = 'none';
    }
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ selectedModel });
    }
  });

  elCustomModel.addEventListener('input', () => {
    customModelId = elCustomModel.value.trim();
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ customModelId });
    }
  });

  function toggleSettings(show) {
    settingsVisible = show !== undefined ? show : !settingsVisible;
    if (settingsVisible) {
      elBody.style.display = 'none';
      elTemplatesBody.style.display = 'none';
      elSettingsBody.style.display = 'flex';
      elBtnSettings.classList.add('active');
      elBtnTemplates.classList.remove('active');
      templatesVisible = false;
    } else {
      elBody.style.display = 'flex';
      elSettingsBody.style.display = 'none';
      elBtnSettings.classList.remove('active');
    }
  }

  elBtnSettings.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleSettings();
  });

  elBtnSettingsBack.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleSettings(false);
  });

  function toggleTemplates(show) {
    templatesVisible = show !== undefined ? show : !templatesVisible;
    if (templatesVisible) {
      elBody.style.display = 'none';
      elSettingsBody.style.display = 'none';
      elTemplatesBody.style.display = 'flex';
      elBtnTemplates.classList.add('active');
      elBtnSettings.classList.remove('active');
      settingsVisible = false;
    } else {
      elBody.style.display = 'flex';
      elTemplatesBody.style.display = 'none';
      elBtnTemplates.classList.remove('active');
    }
  }

  elBtnTemplates.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleTemplates();
  });

  elBtnTemplatesBack.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleTemplates(false);
  });


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
      } catch (_) { }
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
   * CHECK: Validate the selected/replacement text against prompt
   * validation rules. Evaluates every rule independently and shows
   * a structured pass/fail report with score and suggestions.
   */
  elBtnCheck.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();

    // Use replacement text if modified, otherwise selected text
    const textToCheck = elReplacement.value.trim() || selectedText.trim();
    if (!textToCheck) {
      showToast('No text to validate', 'warning');
      return;
    }

    const result = validatePrompt(textToCheck);
    renderCheckResults(result);
    showToast(`Score: ${result.score}/100`, result.success ? 'success' : 'warning');
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
    elCheckResults.style.display = 'none';
    updateStatus('idle');
    showToast('Cleared', 'info');
  });

  /**
   * GENERATE: Query OpenRouter using Llama models to rewrite/generate text.
   */
  elBtnGenerate.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();

    if (isGenerating) return;

    // Use replacement text if modified, otherwise selected text
    const promptText = elReplacement.value.trim() || selectedText.trim();
    if (!promptText) {
      showToast('No text to generate from', 'warning');
      return;
    }

    if (!openRouterKey) {
      showToast('API Key required! Opening settings...', 'warning');
      toggleSettings(true);
      return;
    }

    const modelToUse = selectedModel === 'custom' ? customModelId : selectedModel;
    if (selectedModel === 'custom' && !customModelId) {
      showToast('Please specify a custom model ID', 'warning');
      toggleSettings(true);
      return;
    }

    setGeneratingState(true);
    updateStatus('generating');

    try {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${openRouterKey}`,
          'HTTP-Referer': 'https://github.com/siddharth756/show-select',
          'X-Title': 'seiyaa Extension'
        },
        body: JSON.stringify({
          model: modelToUse,
          messages: [
            {
              role: 'system',
              content: 'You are an expert prompt engineer. Your task is to take the user\'s input/request and expand it into a structured, highly effective AI prompt.\n\nThe generated prompt MUST strictly follow this exact format (replace the bracketed placeholders with rich, specific details tailored to the user\'s request):\n\nAct as a [ROLE].\n\nYour task is to [TASK].\n\nContext:\n[BACKGROUND INFORMATION]\n\nRequirements:\n- [RULE 1]\n- [RULE 2]\n- [RULE 3]\n\nOutput format:\n[DESIRED FORMAT]\n\nExample:\n[OPTIONAL EXAMPLE]\n\nIMPORTANT: Do not write any markdown code blocks, do not write backticks, and do not include any introductory or concluding comments. Output ONLY the formatted prompt itself.'
            },
            {
              role: 'user',
              content: promptText
            }
          ]
        })
      });

      const data = await response.json();

      if (!response.ok) {
        let errMsg = '';
        if (data && data.error) {
          errMsg = data.error.message;
          if (data.error.metadata && data.error.metadata.provider) {
            errMsg += ` [Provider: ${data.error.metadata.provider}]`;
          }
        } else {
          errMsg = `API error (${response.status})`;
        }
        throw new Error(errMsg);
      }

      const generatedText = data.choices?.[0]?.message?.content;
      if (generatedText) {
        elReplacement.value = generatedText;
        elCharCount.textContent = `${selectedText.length} → ${generatedText.length} chars`;
        showToast('Generation complete!', 'success');
        updateStatus('synced');
      } else {
        throw new Error('Invalid response structure from API');
      }
    } catch (err) {
      console.error('[seiyaa] Generation failed:', err);
      showToast(err.message || 'Generation failed', 'error');
      updateStatus('watching');
    } finally {
      setGeneratingState(false);
    }
  });

  function setGeneratingState(generating) {
    isGenerating = generating;
    if (generating) {
      elBtnGenerate.classList.add('ts-btn-loading');
      elBtnGenerateText.textContent = 'Generating...';
      elBtnGenerate.disabled = true;
      elBtnReplace.disabled = true;
      elBtnCopy.disabled = true;
      elBtnCheck.disabled = true;
      elBtnClear.disabled = true;
    } else {
      elBtnGenerate.classList.remove('ts-btn-loading');
      elBtnGenerateText.textContent = 'Generate';
      elBtnGenerate.disabled = false;
      elBtnReplace.disabled = false;
      elBtnCopy.disabled = false;
      elBtnCheck.disabled = false;
      elBtnClear.disabled = false;
    }
  }

  // ── Expand/Collapse Panel Logic ──────────────────────────────────────────
  function togglePanel(expand) {
    const shouldExpand = expand !== undefined ? expand : !panelExpanded;
    if (shouldExpand) {
      panelExpanded = true;
      panel.classList.remove('ts-collapsed');
      panel.classList.add('ts-expanded');
      showToast('seiyaa expanded', 'info');
    } else {
      panelExpanded = false;
      panel.classList.remove('ts-expanded');
      panel.classList.add('ts-collapsed');
      // Clear drag styles so the panel returns to its bottom-right home
      panel.style.left = '';
      panel.style.top = '';
      panel.style.right = '';
      panel.style.bottom = '';
    }
  }

  // Click circle view to expand
  elCircle.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    togglePanel(true);
  });

  // Click close button to collapse
  elBtnClose.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    togglePanel(false);
  });

  // Keyboard shortcut to toggle (Alt + S)
  window.addEventListener('keydown', (e) => {
    if (e.altKey && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      e.stopPropagation();
      togglePanel();
    }
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
      generating: 'Generating',
    };
    const colors = {
      idle: '#6b7280',
      watching: '#3b82f6',
      synced: '#10b981',
      replaced: '#f59e0b',
      generating: '#a855f7',
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

  // ── Prompt Validation Rules ──────────────────────────────────────────────
  /**
   * Default validation rules for the Check button.
   * Each rule is evaluated independently against the prompt text.
   *
   * ALL 11 RULE TYPES SUPPORTED (per Prompt Validation AI spec):
   *   minLength        — minimum character count
   *   maxLength        — maximum character count
   *   contains         — must include ALL specified keywords/phrases
   *   notContains      — must NOT include any specified phrases
   *   regex            — must match the given regular expression
   *   requiredSections — must include section headers (e.g., "## Goal")
   *   keywordCoverage  — percentage of keywords that must appear
   *   tone             — checks for tone indicators (formal, casual, etc.)
   *   audience         — checks if the prompt specifies a target audience
   *   format           — checks structural format (bullet points, numbering)
   *   aiSemanticCheck  — heuristic semantic quality analysis
   *
   * Each result includes:
   *   - ruleId:     unique identifier for the rule
   *   - passed:     boolean pass/fail status
   *   - message:    human-readable explanation
   *   - detail:     technical detail string
   *   - confidence: 0–100 confidence score for the evaluation
   *   - suggestion: improvement hint (null if passed)
   */
  const VALIDATION_RULES = {
    rules: [
      {
        id: 'appropriate_length',
        type: 'minLength',
        value: 20,
        critical: true,
        message: 'Prompt is too short to be meaningful (min 20 chars).'
      },
      {
        id: 'min_length',
        type: 'minLength',
        value: 50,
        critical: true,
        message: 'Prompt must contain at least 50 characters.'
      },
      {
        id: 'max_length',
        type: 'maxLength',
        value: 10000,
        critical: false,
        message: 'Prompt should not exceed 10,000 characters.'
      },
      {
        id: 'must_include_goal',
        type: 'contains',
        value: ['goal'],
        critical: false,
        message: 'Prompt should mention its goal or purpose.'
      },
      {
        id: 'has_clear_instruction',
        type: 'contains',
        value: ['you'],
        critical: false,
        message: 'Prompt should address the AI directly (e.g., use "you").'
      },
      {
        id: 'no_placeholder_text',
        type: 'notContains',
        value: ['[insert here]', '[TODO]', 'lorem ipsum', 'placeholder', 'FIXME'],
        critical: true,
        message: 'Prompt must not contain placeholder or draft text.'
      },
      {
        id: 'has_action_verb',
        type: 'regex',
        value: '(\\?|please|create|generate|write|explain|list|describe|analyze|summarize|build|make|help|design|implement|review|compare|evaluate|suggest|recommend|translate|convert|optimize|debug|refactor)',
        flags: 'i',
        critical: false,
        message: 'Prompt should include a clear action verb or question.'
      },
      {
        id: 'keyword_coverage',
        type: 'keywordCoverage',
        value: {
          keywords: ['goal', 'context', 'format', 'audience', 'tone', 'example', 'constraint', 'output', 'input', 'role'],
          threshold: 0.2
        },
        critical: false,
        message: 'Prompt should cover key prompt dimensions: goal, context, format, audience, tone, or examples.'
      },
      {
        id: 'has_structure',
        type: 'format',
        value: 'structured',
        critical: false,
        message: 'Consider using bullet points, numbering, or sections for clarity.'
      },
      {
        id: 'audience_check',
        type: 'audience',
        value: {
          indicators: ['target audience', 'audience', 'readers', 'users', 'developers', 'beginners', 'experts', 'students', 'professionals', 'team', 'customers', 'stakeholders', 'end users', 'for whom']
        },
        critical: false,
        message: 'Prompt should specify or imply a target audience.'
      },
      {
        id: 'tone_professional',
        type: 'tone',
        value: 'formal',
        critical: false,
        message: 'Prompt tone should be professional/formal for best AI results.'
      },
      {
        id: 'semantic_quality',
        type: 'aiSemanticCheck',
        value: {
          checks: ['clarity', 'specificity', 'completeness', 'coherence']
        },
        critical: false,
        message: 'Prompt should be clear, specific, complete, and coherent.'
      }
    ]
  };

  /**
   * Validate a prompt string against all rules.
   *
   * Returns the EXACT response format specified by the Prompt Validation AI:
   * {
   *   success:     boolean — true if no critical rule failed
   *   score:       number  — 0–100 based on pass ratio
   *   passedCount: number  — how many rules passed
   *   totalRules:  number  — total rules evaluated
   *   results:     array   — per-rule { ruleId, passed, message, confidence, detail }
   *   suggestions: array   — improvement hints for failed rules
   * }
   *
   * The full JSON is also logged to the browser console for debugging.
   */
  function validatePrompt(promptText) {
    const results = [];
    const suggestions = [];
    let passedCount = 0;
    let criticalFailed = false;

    // Evaluate every rule independently — never skip rules
    for (const rule of VALIDATION_RULES.rules) {
      const result = evaluateRule(rule, promptText);
      results.push(result);

      if (result.passed) {
        passedCount++;
      } else {
        suggestions.push(result.suggestion || result.message);
        if (rule.critical) criticalFailed = true;
      }
    }

    const totalRules = VALIDATION_RULES.rules.length;
    const score = Math.round((passedCount / totalRules) * 100);

    const output = {
      success: !criticalFailed,
      score,
      passedCount,
      totalRules,
      results,
      suggestions
    };

    // Log the structured JSON to the console for inspection/debugging
    console.log(
      '%c[seiyaa] Prompt Validation Result',
      'color: #67e8f9; font-weight: bold; font-size: 13px;',
      '\n' + JSON.stringify(output, null, 2)
    );

    return output;
  }

  /**
   * Evaluate a single validation rule against the prompt text.
   * Each rule type has its own evaluation logic.
   * Every result includes a `confidence` score (0–100).
   */
  function evaluateRule(rule, text) {
    const base = { ruleId: rule.id, message: rule.message };

    switch (rule.type) {

      // ═══════════════════════════════════════════════════════════════
      //  1. minLength — text must be at least N characters
      // ═══════════════════════════════════════════════════════════════
      case 'minLength': {
        const passed = text.length >= rule.value;
        return {
          ...base,
          passed,
          confidence: 100,  // deterministic check
          detail: `${text.length}/${rule.value} chars`,
          suggestion: passed ? null : `Add more detail — current length is ${text.length}, minimum is ${rule.value}.`
        };
      }

      // ═══════════════════════════════════════════════════════════════
      //  2. maxLength — text must not exceed N characters
      // ═══════════════════════════════════════════════════════════════
      case 'maxLength': {
        const passed = text.length <= rule.value;
        return {
          ...base,
          passed,
          confidence: 100,
          detail: `${text.length}/${rule.value} chars`,
          suggestion: passed ? null : `Shorten the prompt — current length is ${text.length}, maximum is ${rule.value}.`
        };
      }

      // ═══════════════════════════════════════════════════════════════
      //  3. contains — text must include ALL specified keywords
      // ═══════════════════════════════════════════════════════════════
      case 'contains': {
        const lower = text.toLowerCase();
        const missing = rule.value.filter(kw => !lower.includes(kw.toLowerCase()));
        const passed = missing.length === 0;
        const found = rule.value.length - missing.length;
        return {
          ...base,
          passed,
          confidence: 100,
          detail: passed
            ? `All ${rule.value.length} keyword(s) found`
            : `Missing: ${missing.join(', ')} (${found}/${rule.value.length} found)`,
          suggestion: passed ? null : `Include the following in your prompt: ${missing.join(', ')}.`
        };
      }

      // ═══════════════════════════════════════════════════════════════
      //  4. notContains — text must NOT include any specified phrases
      // ═══════════════════════════════════════════════════════════════
      case 'notContains': {
        const lower = text.toLowerCase();
        const found = rule.value.filter(kw => lower.includes(kw.toLowerCase()));
        const passed = found.length === 0;
        return {
          ...base,
          passed,
          confidence: 100,
          detail: passed ? 'No forbidden text found' : `Found: ${found.join(', ')}`,
          suggestion: passed ? null : `Remove placeholder/forbidden text: ${found.join(', ')}.`
        };
      }

      // ═══════════════════════════════════════════════════════════════
      //  5. regex — text must match the given pattern
      // ═══════════════════════════════════════════════════════════════
      case 'regex': {
        try {
          const re = new RegExp(rule.value, rule.flags || 'i');
          const passed = re.test(text);
          return {
            ...base,
            passed,
            confidence: 100,
            detail: passed ? 'Pattern matched' : 'Pattern not matched',
            suggestion: passed ? null : rule.message
          };
        } catch {
          return { ...base, passed: true, confidence: 0, detail: 'Invalid regex — skipped' };
        }
      }

      // ═══════════════════════════════════════════════════════════════
      //  6. requiredSections — text must include section headers
      // ═══════════════════════════════════════════════════════════════
      case 'requiredSections': {
        const sections = Array.isArray(rule.value) ? rule.value : [];
        const missing = sections.filter(section => {
          const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const headerPattern = new RegExp(`(^|\\n)#+\\s*${escaped}`, 'i');
          const colonPattern = text.toLowerCase().includes(section.toLowerCase() + ':');
          const boldPattern = new RegExp(`\\*\\*${escaped}\\*\\*`, 'i').test(text);
          return !headerPattern.test(text) && !colonPattern && !boldPattern;
        });
        const passed = missing.length === 0;
        const found = sections.length - missing.length;
        return {
          ...base,
          passed,
          confidence: 95,
          detail: passed
            ? `All ${sections.length} section(s) present`
            : `Missing: ${missing.join(', ')} (${found}/${sections.length} found)`,
          suggestion: passed ? null : `Add sections for: ${missing.join(', ')}.`
        };
      }

      // ═══════════════════════════════════════════════════════════════
      //  7. keywordCoverage — percentage of keywords present
      // ═══════════════════════════════════════════════════════════════
      case 'keywordCoverage': {
        const { keywords, threshold } = rule.value;
        const lower = text.toLowerCase();
        const found = keywords.filter(kw => lower.includes(kw.toLowerCase()));
        const coverage = found.length / keywords.length;
        const passed = coverage >= threshold;
        return {
          ...base,
          passed,
          confidence: 90,
          detail: `${found.length}/${keywords.length} keywords (${Math.round(coverage * 100)}%) — need ${Math.round(threshold * 100)}%`,
          suggestion: passed
            ? null
            : `Consider mentioning: ${keywords.filter(kw => !lower.includes(kw.toLowerCase())).slice(0, 4).join(', ')}.`
        };
      }

      // ═══════════════════════════════════════════════════════════════
      //  8. format — checks for structural formatting
      // ═══════════════════════════════════════════════════════════════
      case 'format': {
        const hasBullets = /[-*•]\s+\S/.test(text);
        const hasNumbering = /\d+[.)]\s+\S/.test(text);
        const hasHeaders = /^#{1,6}\s+/m.test(text);
        const hasColonSections = /^[A-Z][A-Za-z\s]+:/m.test(text);
        const hasNewlines = (text.match(/\n/g) || []).length >= 2;
        const indicators = [hasBullets, hasNumbering, hasHeaders, hasColonSections, hasNewlines];
        const structureScore = indicators.filter(Boolean).length;
        const isStructured = structureScore >= 1;
        const passed = rule.value === 'structured' ? isStructured : true;
        return {
          ...base,
          passed,
          confidence: isStructured ? 85 + (structureScore * 3) : 90,
          detail: isStructured
            ? `Structured (${structureScore}/5 indicators: ${[hasBullets && 'bullets', hasNumbering && 'numbering', hasHeaders && 'headers', hasColonSections && 'sections', hasNewlines && 'paragraphs'].filter(Boolean).join(', ')})`
            : 'Single block of text',
          suggestion: passed ? null : 'Break your prompt into sections, bullet points, or numbered steps.'
        };
      }

      // ═══════════════════════════════════════════════════════════════
      //  9. tone — basic tone detection (formal / casual / neutral)
      // ═══════════════════════════════════════════════════════════════
      case 'tone': {
        const lower = text.toLowerCase();
        const formalIndicators = [
          'please', 'kindly', 'ensure', 'provide', 'regarding', 'therefore',
          'furthermore', 'additionally', 'consequently', 'shall', 'must',
          'objective', 'requirement', 'specification', 'deliverable'
        ];
        const casualIndicators = [
          'hey', 'gonna', 'wanna', 'lol', 'btw', 'idk', 'ngl', 'tbh',
          'yo', 'dude', 'stuff', 'kinda', 'sorta', 'cuz', 'ur', 'thx'
        ];
        const formalFound = formalIndicators.filter(w => lower.includes(w));
        const casualFound = casualIndicators.filter(w => lower.includes(w));
        const formalCount = formalFound.length;
        const casualCount = casualFound.length;
        const total = formalCount + casualCount;
        const detectedTone = formalCount > casualCount ? 'formal'
          : casualCount > formalCount ? 'casual' : 'neutral';
        const expected = rule.value;
        const passed = expected === detectedTone || detectedTone === 'neutral';
        const confidence = total === 0 ? 50 : Math.min(60 + total * 8, 95);
        return {
          ...base,
          passed,
          confidence,
          detail: `Detected: ${detectedTone} (${formalCount} formal, ${casualCount} casual indicators)`,
          suggestion: passed ? null : `Adjust tone to be more ${expected}. ${casualCount > 0 ? 'Remove casual words: ' + casualFound.slice(0, 3).join(', ') + '.' : ''}`
        };
      }

      // ═══════════════════════════════════════════════════════════════
      // 10. audience — checks if the prompt specifies a target audience
      // ═══════════════════════════════════════════════════════════════
      case 'audience': {
        const lower = text.toLowerCase();
        const indicators = rule.value.indicators || [
          'target audience', 'audience', 'readers', 'users', 'developers',
          'beginners', 'experts', 'students', 'professionals', 'team',
          'customers', 'stakeholders', 'end users', 'for whom', 'intended for',
          'aimed at', 'written for', 'non-technical', 'technical'
        ];
        const found = indicators.filter(term => lower.includes(term));
        const passed = found.length > 0;
        const confidence = passed ? Math.min(70 + found.length * 10, 95) : 75;
        return {
          ...base,
          passed,
          confidence,
          detail: passed
            ? `Audience specified: ${found.slice(0, 3).join(', ')}`
            : 'No audience indicators found',
          suggestion: passed
            ? null
            : 'Specify who the output is intended for (e.g., "for beginners", "target audience: developers").'
        };
      }

      // ═══════════════════════════════════════════════════════════════
      // 11. aiSemanticCheck — heuristic semantic quality analysis
      //     (approximation without an AI model, based on text signals)
      // ═══════════════════════════════════════════════════════════════
      case 'aiSemanticCheck': {
        const checks = rule.value.checks || ['clarity', 'specificity', 'completeness', 'coherence'];
        const lower = text.toLowerCase();
        const words = text.split(/\s+/).filter(w => w.length > 0);
        const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
        const subResults = {};

        // ── Clarity: average sentence length, no overly long sentences
        if (checks.includes('clarity')) {
          const avgLen = words.length / Math.max(sentences.length, 1);
          // Good clarity: avg 10–25 words per sentence
          const isGoodAvg = avgLen >= 5 && avgLen <= 30;
          const hasVeryLongSentences = sentences.some(s => s.split(/\s+/).length > 50);
          subResults.clarity = isGoodAvg && !hasVeryLongSentences;
        }

        // ── Specificity: contains specific details (numbers, names, quoted text)
        if (checks.includes('specificity')) {
          const hasNumbers = /\d+/.test(text);
          const hasQuotes = /["'`]/.test(text);
          const hasSpecificTerms = /\b(specific|exactly|precisely|e\.g\.|for example|such as|like|including)\b/i.test(text);
          const hasNoVagueness = !/\b(something|somehow|maybe|perhaps|kind of|sort of|whatever|etc\.?)\b/i.test(text) || text.length > 200;
          subResults.specificity = (hasNumbers || hasQuotes || hasSpecificTerms) && hasNoVagueness;
        }

        // ── Completeness: has enough content and covers multiple aspects
        if (checks.includes('completeness')) {
          const hasMinLength = text.length >= 100;
          const hasParagraphs = sentences.length >= 3;
          const hasContext = /\b(context|background|scenario|situation|when|because|since|given)\b/i.test(text);
          subResults.completeness = hasMinLength && hasParagraphs;
        }

        // ── Coherence: sentences flow logically (simple heuristic)
        if (checks.includes('coherence')) {
          const hasTransitions = /\b(then|next|also|however|therefore|additionally|furthermore|first|second|finally|moreover|in addition)\b/i.test(text);
          const hasConsistentPOV = !(/\byou\b/i.test(text) && /\bwe\b/i.test(text) && /\bthey\b/i.test(text));
          const noRepeatedSentences = new Set(sentences.map(s => s.trim().toLowerCase())).size >= sentences.length * 0.8;
          subResults.coherence = (hasTransitions || sentences.length <= 3) && hasConsistentPOV && noRepeatedSentences;
        }

        const passedChecks = Object.values(subResults).filter(Boolean).length;
        const totalChecks = Object.keys(subResults).length;
        const passed = passedChecks >= Math.ceil(totalChecks * 0.5); // pass if ≥50% of checks pass
        const confidence = Math.round(40 + (passedChecks / Math.max(totalChecks, 1)) * 45); // 40-85 range (heuristic)
        const failedAspects = Object.entries(subResults).filter(([, v]) => !v).map(([k]) => k);

        return {
          ...base,
          passed,
          confidence,
          detail: `${passedChecks}/${totalChecks} semantic checks passed: ${Object.entries(subResults).map(([k, v]) => `${k}:${v ? '✓' : '✗'}`).join(', ')}`,
          suggestion: passed
            ? null
            : `Improve ${failedAspects.join(' and ')}: ${failedAspects.map(a => {
              const tips = {
                clarity: 'use shorter, clearer sentences',
                specificity: 'add specific details, numbers, or examples',
                completeness: 'add more context and detail (aim for 3+ sentences)',
                coherence: 'use transition words and maintain consistent perspective'
              };
              return tips[a] || a;
            }).join('; ')}.`
        };
      }

      // ═══════════════════════════════════════════════════════════════
      //  Fallback for unknown rule types
      // ═══════════════════════════════════════════════════════════════
      default:
        return { ...base, passed: true, confidence: 0, detail: `Unknown rule type: ${rule.type} — skipped` };
    }
  }

  /**
   * Render the validation results in the check results panel.
   * Displays: score badge, per-rule pass/fail with confidence, and suggestions.
   */
  function renderCheckResults(result) {
    // Score badge color
    const scoreColor = result.score >= 80 ? '#10b981' : result.score >= 50 ? '#f59e0b' : '#ef4444';
    elCheckScore.textContent = `${result.score}`;
    elCheckScore.style.background = scoreColor;
    elCheckScore.style.boxShadow = `0 0 12px ${scoreColor}40`;

    // Build rule results list
    elCheckList.innerHTML = result.results.map(r => {
      const icon = r.passed ? '✅' : '❌';
      const detailHtml = r.detail ? `<span class="ts-check-detail">${r.detail}</span>` : '';
      return `
        <div class="ts-check-item ${r.passed ? 'ts-check-pass' : 'ts-check-fail'}">
          <span class="ts-check-icon">${icon}</span>
          <div class="ts-check-item-body">
            <span class="ts-check-rule-id">${r.ruleId}</span>
            <span class="ts-check-msg">${r.message}</span>
            ${detailHtml}
          </div>
        </div>
      `;
    }).join('');

    // Suggestions
    if (result.suggestions.length > 0) {
      elCheckSuggestions.innerHTML =
        '<div class="ts-check-suggestions-title">💡 Suggestions</div>' +
        result.suggestions.map(s => `<div class="ts-check-suggestion">• ${s}</div>`).join('');
      elCheckSuggestions.style.display = 'block';
    } else {
      elCheckSuggestions.innerHTML = '<div class="ts-check-suggestions-title">🎉 All checks passed!</div>';
      elCheckSuggestions.style.display = 'block';
    }

    // Show the results panel
    elCheckResults.style.display = 'block';
    elCheckBody.style.display = 'block';
  }

  // ── Prompt Templates Helper Functions & Actions ──────────────────────────
  function renderBuiltinTemplates() {
    elBuiltinList.innerHTML = BUILTIN_TEMPLATES.map((tmpl, idx) => `
      <div class="ts-template-card" data-type="builtin" data-index="${idx}">
        <div class="ts-template-card-title">${tmpl.name}</div>
        <div class="ts-template-card-desc">${tmpl.description}</div>
      </div>
    `).join('');

    // Attach click listeners to cards
    elBuiltinList.querySelectorAll('.ts-template-card').forEach(card => {
      card.addEventListener('click', () => {
        const idx = card.getAttribute('data-index');
        loadTemplate(BUILTIN_TEMPLATES[idx]);
      });
    });
  }

  function renderCustomTemplates() {
    if (customTemplates.length === 0) {
      elCustomList.innerHTML = '<div style="font-size: 11px; color: #64748b; font-style: italic; padding: 4px;">No custom templates saved.</div>';
      return;
    }

    elCustomList.innerHTML = customTemplates.map((tmpl, idx) => `
      <div class="ts-template-card" data-type="custom" data-index="${idx}">
        <div style="flex: 1; min-width: 0;">
          <div class="ts-template-card-title">${escapeHTML(tmpl.name)}</div>
          <div class="ts-template-card-desc">${escapeHTML(tmpl.prompt.substring(0, 65))}...</div>
        </div>
        <button class="ts-template-card-delete" data-index="${idx}" title="Delete template">❌</button>
      </div>
    `).join('');

    // Attach click listeners to card bodies
    elCustomList.querySelectorAll('.ts-template-card').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.ts-template-card-delete')) return;
        const idx = card.getAttribute('data-index');
        loadTemplate(customTemplates[idx]);
      });
    });

    // Attach delete listeners
    elCustomList.querySelectorAll('.ts-template-card-delete').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const idx = parseInt(btn.getAttribute('data-index'), 10);
        deleteCustomTemplate(idx);
      });
    });
  }

  function loadTemplate(tmpl) {
    elReplacement.value = tmpl.prompt;
    const len = elReplacement.value.length;
    elCharCount.textContent = `${selectedText.length} → ${len} chars`;
    updateStatus('watching');
    showToast(`Loaded: ${tmpl.name}`, 'success');
    toggleTemplates(false);
  }

  function deleteCustomTemplate(idx) {
    const name = customTemplates[idx].name;
    customTemplates.splice(idx, 1);
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ customTemplates });
    }
    renderCustomTemplates();
    showToast(`Deleted template: ${name}`, 'info');
  }

  function escapeHTML(str) {
    if (!str) return '';
    return str.replace(/[&<>'"]/g, 
      tag => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        "'": '&#39;',
        '"': '&quot;'
      }[tag] || tag)
    );
  }

  // Save template click handler
  elBtnSaveTemplate.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();

    const name = elNewTemplateName.value.trim();
    const prompt = elReplacement.value.trim();

    if (!prompt) {
      showToast('No prompt content to save!', 'warning');
      return;
    }
    if (!name) {
      showToast('Please enter a template name', 'warning');
      return;
    }

    const newTmpl = { name, prompt };
    customTemplates.push(newTmpl);

    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ customTemplates });
    }

    elNewTemplateName.value = '';
    renderCustomTemplates();
    showToast(`Saved template: ${name}`, 'success');
  });


  // ── Panel HTML template ─────────────────────────────────────────────────
  function buildPanelHTML() {
    return `
      <!-- Collapsed Circle View -->
      <div id="seiyaa-circle-view">
        <div class="seiyaa-circle-glow"></div>
        <span class="seiyaa-circle-text">seiyaa</span>
      </div>

      <!-- Expanded Panel View -->
      <div id="seiyaa-expanded-view">
        <div id="ts-header">
          <div id="ts-title">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
            <span>seiyaa</span>
            <span id="ts-status-dot"></span>
            <span id="ts-status">Idle</span>
          </div>
          <div id="ts-header-controls" style="display: flex; gap: 6px; align-items: center;">
            <button id="ts-btn-templates" title="Prompt Templates" class="ts-header-btn">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>
                <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
              </svg>
            </button>
            <button id="ts-btn-settings" title="OpenRouter Settings" class="ts-header-btn">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="3"/>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
              </svg>
            </button>
            <button id="ts-btn-close" title="Collapse Panel" class="ts-header-btn">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>
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
            <button id="ts-btn-generate" class="ts-btn ts-btn-ai" title="Generate with Meta-Llama">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="ts-ai-icon"><path d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364-6.364l-.707.707M6.343 17.657l-.707.707m0-12.728l.707.707m11.314 11.314l.707-.707M12 5a7 7 0 1 0 0 14 7 7 0 0 0 0-14z"/></svg>
              <span id="ts-btn-generate-text">Generate</span>
            </button>
            <button id="ts-btn-copy" class="ts-btn ts-btn-secondary" title="Copy selected text">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
              Copy
            </button>
            <button id="ts-btn-check" class="ts-btn ts-btn-check" title="Validate prompt against rules">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
              Check
            </button>
            <button id="ts-btn-clear" class="ts-btn ts-btn-ghost" title="Clear selection">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              Clear
            </button>
          </div>
          <div id="ts-check-results" style="display:none;">
            <div class="ts-check-header">
              <span class="ts-check-title">Validation Results</span>
              <span id="ts-check-score" class="ts-check-score">0</span>
            </div>
            <div id="ts-check-body">
              <div id="ts-check-list"></div>
              <div id="ts-check-suggestions" style="display:none;"></div>
            </div>
          </div>
          <div id="ts-toast"></div>
        </div>
        <div id="ts-settings-body" style="display: none;">
          <div class="ts-settings-header">OpenRouter AI Settings</div>
          
          <div class="ts-api-key-section">
            <div class="ts-api-key-header">
              <span class="ts-label-text">OpenRouter API Key</span>
              <span id="ts-api-key-status" class="ts-api-key-status ts-api-key-status--empty">Not saved</span>
            </div>
            <div class="ts-api-key-input-row">
              <input type="password" id="ts-api-key" placeholder="sk-or-v1-..." class="ts-input ts-api-key-input" autocomplete="off" />
              <button id="ts-btn-key-toggle" class="ts-btn-icon" title="Show / hide key" type="button">
                <svg id="ts-key-eye-show" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
                </svg>
                <svg id="ts-key-eye-hide" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:none">
                  <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/>
                </svg>
              </button>
            </div>
            <div class="ts-api-key-actions">
              <button id="ts-btn-key-save" class="ts-btn ts-btn-primary ts-btn-sm" type="button">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
                Save Key
              </button>
              <button id="ts-btn-key-clear" class="ts-btn ts-btn-ghost ts-btn-sm" type="button">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
                Clear Key
              </button>
            </div>
          </div>
          
          <label class="ts-label">
            <span class="ts-label-text">Meta-Llama Model</span>
            <select id="ts-model-select" class="ts-select">
              <option value="meta-llama/llama-3.3-70b-instruct:free">Llama 3.3 70B Instruct (Free)</option>
              <option value="google/gemma-4-26b-a4b-it:free">Gemma 4 26B A4B IT (Free)</option>
              <option value="deepseek/deepseek-v4-flash:free">DeepSeek V4 Flash (Free)</option>
              <option value="arcee-ai/trinity-large-thinking:free">Trinity Large Thinking (Free)</option>
              <option value="openrouter/owl-alpha">Owl-Alpha (Free)</option>
              <option value="nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free">Nemotron-3 Nano Omni (Free)</option>
              <option value="qwen/qwen3-next-80b-a3b-instruct:free">Qwen 3 (Free)</option>
              <option value="custom">Custom Model ID...</option>
            </select>
          </label>

          <label class="ts-label" id="ts-custom-model-wrapper" style="display: none;">
            <span class="ts-label-text">Custom Model ID</span>
            <input type="text" id="ts-custom-model" placeholder="e.g. meta-llama/llama-3-8b-instruct" class="ts-input" />
          </label>

          <div id="ts-settings-actions" style="display: flex; gap: 6px; width: 100%;">
            <button id="ts-btn-settings-back" class="ts-btn ts-btn-secondary" style="width: 100%;">
              Back to Panel
            </button>
          </div>
        </div>
        <div id="ts-templates-body" style="display: none;">
          <div class="ts-settings-header">Prompt Templates</div>
          
          <div class="ts-template-save-box">
            <span class="ts-label-text" style="margin-bottom: 4px; display: block;">Save Current Prompt</span>
            <div style="display: flex; gap: 6px;">
              <input type="text" id="ts-new-template-name" placeholder="Template name..." class="ts-input" style="flex: 1;" />
              <button id="ts-btn-save-template" class="ts-btn ts-btn-primary" style="padding: 0 12px; font-size: 11px;">Save</button>
            </div>
          </div>

          <div class="ts-templates-section">
            <div class="ts-label-text" style="margin-bottom: 6px;">Built-in Templates</div>
            <div id="ts-builtin-templates-list" class="ts-templates-list"></div>
          </div>

          <div class="ts-templates-section" style="margin-top: 10px;">
            <div class="ts-label-text" style="margin-bottom: 6px;">My Saved Templates</div>
            <div id="ts-custom-templates-list" class="ts-templates-list"></div>
          </div>

          <div id="ts-templates-actions" style="display: flex; gap: 6px; width: 100%; margin-top: 8px;">
            <button id="ts-btn-templates-back" class="ts-btn ts-btn-secondary" style="width: 100%;">
              Back to Panel
            </button>
          </div>
        </div>
      </div>
    `;
  }

  // ── Start ───────────────────────────────────────────────────────────────
  renderBuiltinTemplates();
  renderCustomTemplates();
  startPolling();
  updateStatus('idle');

})();
