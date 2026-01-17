# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

YouTube Language Filter is a Chrome Extension (Manifest V3) that filters YouTube comments by language on both Watch pages and Shorts pages. It uses a hybrid detection approach: script-based heuristics first, then `chrome.i18n.detectLanguage` as fallback—no external network calls.

## Development

### Loading the Extension

1. Open `chrome://extensions/`
2. Enable Developer mode
3. Click "Load unpacked" and select the root directory (contains `manifest.json`)

### Testing Changes

After modifying code, reload the extension from `chrome://extensions/` and refresh any open YouTube pages.

## Architecture

### Communication Flow

```
popup.js  ---(chrome.tabs.sendMessage)---> content.js
    |                                          |
    v                                          v
chrome.storage.local  <----(settings)---->  settings object
```

**Message Types:**
- `SETTINGS_UPDATED`: Popup sends new settings to content script
- `RESCAN`: Triggers reprocessing of all comments on page

### Hybrid Language Detection

The detection uses a two-stage approach to prevent misclassification:

1. **Script-based heuristic** (fast, deterministic):
   - Counts characters by Unicode range: Hangul, Hiragana, Katakana, Han, Latin
   - Decision rules prioritize script evidence over statistical detection
   - Key rule: If Hangul exists, NEVER classify as Japanese (prevents "ㅋㅋㅋ" misdetection)
   - Key rule: If no kana exists, NEVER classify as Japanese

2. **Chrome API fallback** (only for uncertain cases):
   - Uses `chrome.i18n.detectLanguage` when heuristic returns "uncertain"
   - Validates Chrome's result against script evidence before accepting
   - Rejects contradictory results (e.g., "ja" when Hangul is present)

### Unicode Ranges

| Script | Range | Language |
|--------|-------|----------|
| Hangul syllables | `\uAC00-\uD7A3` | Korean |
| Hangul Jamo | `\u1100-\u11FF`, `\u3130-\u318F` | Korean (includes ㅋ, ㅎ) |
| Hiragana | `\u3040-\u309F` | Japanese |
| Katakana | `\u30A0-\u30FF`, `\u31F0-\u31FF` | Japanese |
| CJK Han | `\u4E00-\u9FFF` | Chinese/Japanese/Korean (shared) |
| Latin | `A-Za-z` | English/European |

### Content Script Processing Pipeline

1. **MutationObserver** watches comment containers for new nodes
2. New comments are queued and debounced (200ms)
3. Comments processed in batches of 20 to avoid UI blocking
4. For each comment:
   - Extract text from `#content-text` selector
   - Run heuristic detection first
   - Fall back to Chrome API only if uncertain
   - Cache result keyed by first 100 chars
   - Apply hide/collapse based on settings and confidence

### Page Type Support

- **Watch pages**: `/watch` path, container selectors: `#comments`, `ytd-comments`
- **Shorts pages**: `/shorts` path, container selectors include `ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-comments-section"]`

URL observer detects SPA navigation and reinitializes observers when switching between page types.

### YouTube DOM Selectors

- Comment containers: `ytd-comment-thread-renderer`, `ytd-comment-renderer`
- Comment text: `#content-text`
- Watch comments section: `#comments`, `ytd-comments`
- Shorts comments section: engagement panel with `target-id="engagement-panel-comments-section"`

These selectors may change when YouTube updates their UI.

### Storage Schema

```javascript
{
  settings: {
    enabled: boolean,
    allowedLangs: string[],  // ISO codes: "en", "ko", "ja", etc.
    mode: "hide" | "collapse",
    hideUnknown: boolean
  }
}
```

### CSS Classes Applied by Extension

- `ylf-hidden`: Hides comment completely (`display: none`)
- `ylf-collapsed`: Dims comment, shows placeholder
- `ylf-placeholder`: Expandable placeholder element
- `ylf-processed`: Marks comment as already processed
- `ylf-expanded`: Comment expanded after user clicks "Show"

Also uses `data-ylf-processed` attribute as a more reliable processed marker.

## Key Constraints

- Runs on YouTube watch pages (`/watch`) and shorts pages (`/shorts`)
- Handles YouTube SPA navigation by observing URL changes
- Must not break YouTube's event handlers—uses CSS classes and style changes rather than removing DOM nodes
- Low-confidence detections are not filtered by default (reduces false positives)
- Heuristic detection is O(n) per comment for performance
