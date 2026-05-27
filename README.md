# seiyaa — Smart Enhanced Input Yielding AI Assistance

> **Chrome Extension** for real-time two-way text synchronization between a floating control panel and any webpage input/textarea.

![seiyaa](icons/icon128.svg)

---

## ✨ Features

| Feature | Description |
|---------|-------------|
| 🔄 **Real-time Sync** | Continuously monitors selected text from any input field |
| ✏️ **Edit & Replace** | Modify selected text and replace it inline instantly |
| 📋 **One-click Copy** | Copy selected text to clipboard |
| 🎯 **Cursor Preserved** | Cursor position is maintained after replacement |
| 📦 **Collapsible Circle** | Shrinks into a subtle 72px floating circle in the bottom-right |
| ⌨️ **Keyboard Shortcut** | Toggle the panel visibility instantly by pressing `Alt + S` |
| 📦 **Draggable Panel** | Floating control panel can be repositioned when expanded |
| 🌐 **Universal** | Works across all websites (ChatGPT, Gmail, GitHub, etc.) |
| ⚡ **React-compatible** | Uses `execCommand('insertText')` for framework-friendly event firing |
| 🔍 **SPA-aware** | MutationObserver detects dynamically mounted elements |

---

## 🏗️ Project Structure

```
show-select/
├── manifest.json          # Extension manifest (Manifest V3)
├── content.js             # Content script — injected into every page
├── content-panel.css      # Glassmorphism styles for the floating panel
├── popup.html             # Extension popup dashboard
├── popup.js               # Popup logic & status detection
├── popup.css              # Popup styling
├── icons/
│   ├── icon16.svg         # 16×16 toolbar icon
│   ├── icon48.svg         # 48×48 extensions page icon
│   ├── icon128.svg        # 128×128 Chrome Web Store icon
│   └── generate-icons.html # Open in browser to generate PNG versions
└── README.md              # This file
```

---

## 🚀 Installation (Developer Mode)

1. **Generate PNG icons** (required once):
   - Open `icons/generate-icons.html` in Chrome
   - Click the three download links to save `icon16.png`, `icon48.png`, `icon128.png` into the `icons/` folder

2. **Load the extension**:
   - Open `chrome://extensions/` (or `edge://extensions/`)
   - Enable **Developer mode** (toggle in top-right corner)
   - Click **"Load unpacked"**
   - Select the `show-select/` folder

3. **Use it**:
   - Navigate to any webpage (e.g., ChatGPT, Gmail, GitHub)
   - Click into a text input or textarea
   - You'll see a floating **seiyaa** circle in the bottom-right corner.
   - Click the circle or press **Alt + S** on your keyboard to expand it.
   - Select some text on the page — the expanded panel displays the selection.
   - Edit the replacement text and click **Replace**.
   - Press **Alt + S** or click the close button `✕` to collapse it back.

---

## 🔧 How It Works

### Architecture

```
┌──────────────────────────────────────────────────────────┐
│  WEBPAGE (e.g., chatgpt.com)                             │
│                                                          │
│  ┌──────────────┐     ┌─────────────────────────────┐    │
│  │ <textarea>   │ ←── │  content.js (Content Script) │    │
│  │ <input>      │ ──→ │                             │    │
│  │ contentEdit. │     │  • Polls activeElement      │    │
│  └──────────────┘     │  • Reads selectionStart/End │    │
│                       │  • window.getSelection()    │    │
│                       │  • Replaces via execCommand  │    │
│                       │  • MutationObserver for SPAs │    │
│                       └──────────┬──────────────────┘    │
│                                  │                        │
│                       ┌──────────▼──────────────────┐    │
│                       │  Floating seiyaa Panel      │    │
│                       │  ┌──────────────────────┐   │    │
│                       │  │ Selected Text (r/o)  │   │    │
│                       │  ├──────────────────────┤   │    │
│                       │  │ Replacement Text      │   │    │
│                       │  ├──────────────────────┤   │    │
│                       │  │ [Replace] [Copy] [✕]  │   │    │
│                       │  └──────────────────────┘   │    │
│                       └─────────────────────────────┘    │
└──────────────────────────────────────────────────────────┘
```

### Selection Detection

| Element Type | API Used | Notes |
|---|---|---|
| `<input>` | `selectionStart` / `selectionEnd` | Only text-like types (text, search, url, tel, password) |
| `<textarea>` | `selectionStart` / `selectionEnd` | Full support |
| `contentEditable` | `window.getSelection()` + `Range` | Used by ChatGPT, Gmail compose, etc. |
| `role="textbox"` | `window.getSelection()` + `Range` | Used by some custom editors |

### Text Replacement Strategy

1. **Primary**: `document.execCommand('insertText', false, text)` — fires real `input` events, preserves undo history, works with React/Vue/Angular.
2. **Fallback**: Direct `.value` mutation + synthetic `InputEvent` dispatch — for browsers where `execCommand` is deprecated.
3. **contentEditable**: `Range.deleteContents()` + `Range.insertNode()` with text node insertion.

### Why a Browser Extension?

Normal websites are sandboxed by the browser's **Same-Origin Policy**. A webpage at `example.com` cannot read or modify the DOM of a page at `chatgpt.com`. Browser extensions, however, run **content scripts** in an "isolated world" that has full DOM access to the page while being sandboxed from the page's JavaScript context.

---

## 🎨 Design

- **Glassmorphism** dark theme with `backdrop-filter: blur(24px)`
- **Collapsible Circle** — default state is a 72px circle with a subtle glow/pulse animation
- **Keyboard Toggle** — press `Alt + S` to expand or collapse it instantly
- **Draggable** floating panel when expanded (grab the header to reposition)
- **Toast notifications** for feedback (replaced, copied, cleared)
- **Responsive** — adapts to narrow viewports
- **z-index: 2147483647** — always renders above page content

---

## 🌐 Tested On

| Site | Element Type | Status |
|------|-------------|--------|
| ChatGPT | `<textarea>` / contentEditable | ✅ Working |
| Gmail Compose | contentEditable | ✅ Working |
| GitHub Issues | `<textarea>` | ✅ Working |
| Google Search | `<input>` / `<textarea>` | ✅ Working |
| Stack Overflow | `<textarea>` | ✅ Working |
| Standard HTML forms | `<input>` / `<textarea>` | ✅ Working |
| Google Docs | Custom canvas rendering | ⚠️ Limited (not standard DOM) |

> **Note**: Google Docs uses a proprietary rendering engine that draws text on canvas elements rather than using standard DOM input elements. The extension cannot interact with canvas-rendered text.

---

## 📄 License

MIT — Free to use, modify, and distribute.
